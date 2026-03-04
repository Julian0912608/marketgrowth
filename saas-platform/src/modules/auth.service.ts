// ============================================================
// src/modules/auth/service/auth.service.ts
//
// Verantwoordelijk voor:
//  - Registratie (nieuw account + tenant aanmaken)
//  - Login (email + wachtwoord)
//  - Token vernieuwing (refresh token → nieuw access token)
//  - Uitloggen (refresh token intrekken)
//  - Wachtwoord reset flow
// ============================================================

import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { v4 as uuidv4 } from 'uuid';
import { db } from '../../../infrastructure/database/connection';
import { logger } from '../../../shared/logging/logger';
import { eventBus } from '../../../shared/events/event-bus';
import { cache } from '../../../infrastructure/cache/redis';
import { AuthRepository } from '../repository/auth.repository';

const ACCESS_TOKEN_TTL  = '15m';
const REFRESH_TOKEN_TTL = 30 * 24 * 60 * 60; // 30 dagen in seconden

export interface RegisterInput {
  email: string;
  password: string;
  firstName: string;
  lastName: string;
  companyName: string;
}

export interface LoginInput {
  email: string;
  password: string;
}

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;  // seconden
}

export interface AuthUser {
  userId: string;
  tenantId: string;
  email: string;
  firstName: string;
  lastName: string;
  role: string;
  planSlug: string;
}

export class AuthService {
  constructor(private readonly repo = new AuthRepository()) {}

  // ── Registratie ──────────────────────────────────────────────
  // Maakt tenant + user in één transactie aan.
  // Als één van beiden mislukt, wordt alles teruggedraaid.
  async register(input: RegisterInput): Promise<{ user: AuthUser; tokens: AuthTokens }> {
    // Controleer of email al in gebruik is (globaal, niet per tenant)
    const existing = await this.repo.findUserByEmail(input.email);
    if (existing) {
      throw new ConflictError('Dit e-mailadres is al geregistreerd.');
    }

    const passwordHash = await bcrypt.hash(input.password, 12);

    // Alles in één transactie: tenant + user + subscription + onboarding
    const result = await db.transaction(async (client) => {
      // 1. Tenant aanmaken
      const tenantSlug = this.generateSlug(input.companyName);
      const tenantResult = await client.query<{ id: string }>(
        `INSERT INTO tenants (name, slug, email)
         VALUES ($1, $2, $3)
         RETURNING id`,
        [input.companyName, tenantSlug, input.email]
      );
      const tenantId = tenantResult.rows[0].id;

      // 2. User aanmaken
      const userResult = await client.query<{ id: string }>(
        `INSERT INTO users (tenant_id, email, password_hash, first_name, last_name, role)
         VALUES ($1, $2, $3, $4, $5, 'owner')
         RETURNING id`,
        [tenantId, input.email, passwordHash, input.firstName, input.lastName]
      );
      const userId = userResult.rows[0].id;

      // 3. Starter abonnement koppelen (gratis, geen betaling vereist)
      await client.query(
        `INSERT INTO tenant_subscriptions (tenant_id, plan_id, status)
         SELECT $1, p.id, 'active'
         FROM plans p WHERE p.slug = 'starter'`,
        [tenantId]
      );

      // 4. Onboarding state initialiseren
      await client.query(
        `INSERT INTO onboarding_progress (tenant_id, current_step, completed_steps)
         VALUES ($1, 'account_created', ARRAY['account_created'])`,
        [tenantId]
      );

      return { tenantId, userId, tenantSlug };
    });

    // Email verificatie token aanmaken en versturen
    await this.sendVerificationEmail(result.userId, input.email);

    const user: AuthUser = {
      userId: result.userId,
      tenantId: result.tenantId,
      email: input.email,
      firstName: input.firstName,
      lastName: input.lastName,
      role: 'owner',
      planSlug: 'starter',
    };

    const tokens = await this.generateTokens(user);

    // Event publiceren zodat andere modules (onboarding, email) kunnen reageren
    await eventBus.publish({
      type: 'tenant.registered',
      tenantId: result.tenantId,
      occurredAt: new Date(),
      traceId: uuidv4(),
      payload: {
        userId: result.userId,
        email: input.email,
        companyName: input.companyName,
      },
    });

    logger.info('auth.register.success', {
      tenantId: result.tenantId,
      userId: result.userId,
    });

    return { user, tokens };
  }

  // ── Login ────────────────────────────────────────────────────
  async login(input: LoginInput): Promise<{ user: AuthUser; tokens: AuthTokens }> {
    const userRow = await this.repo.findUserByEmail(input.email);

    if (!userRow || !userRow.password_hash) {
      // Zelfde foutmelding voor "user bestaat niet" en "verkeerd wachtwoord"
      // om te voorkomen dat aanvallers kunnen raden welke emails bestaan
      throw new UnauthorizedError('E-mailadres of wachtwoord is onjuist.');
    }

    const passwordValid = await bcrypt.compare(input.password, userRow.password_hash);
    if (!passwordValid) {
      logger.warn('auth.login.invalid_password', { email: input.email });
      throw new UnauthorizedError('E-mailadres of wachtwoord is onjuist.');
    }

    // Haal het actieve plan op
    const planSlug = await this.repo.getTenantPlanSlug(userRow.tenant_id);

    const user: AuthUser = {
      userId: userRow.id,
      tenantId: userRow.tenant_id,
      email: userRow.email,
      firstName: userRow.first_name,
      lastName: userRow.last_name,
      role: userRow.role,
      planSlug,
    };

    const tokens = await this.generateTokens(user);

    // Laatste login bijwerken
    await db.query(
      `UPDATE users SET last_login_at = now() WHERE id = $1`,
      [user.userId],
      { allowNoTenant: true }
    );

    logger.info('auth.login.success', {
      tenantId: user.tenantId,
      userId: user.userId,
    });

    return { user, tokens };
  }

  // ── Token vernieuwen ─────────────────────────────────────────
  async refreshTokens(refreshToken: string): Promise<AuthTokens> {
    const tokenHash = this.hashToken(refreshToken);

    const tokenRow = await this.repo.findRefreshToken(tokenHash);
    if (!tokenRow || tokenRow.revoked || new Date(tokenRow.expires_at) < new Date()) {
      throw new UnauthorizedError('Ongeldige of verlopen sessie. Log opnieuw in.');
    }

    // Oude token intrekken (rotation: één token per sessie)
    await this.repo.revokeRefreshToken(tokenHash);

    const userRow = await this.repo.findUserById(tokenRow.user_id);
    if (!userRow) throw new UnauthorizedError('Gebruiker niet gevonden.');

    const planSlug = await this.repo.getTenantPlanSlug(userRow.tenant_id);

    const user: AuthUser = {
      userId: userRow.id,
      tenantId: userRow.tenant_id,
      email: userRow.email,
      firstName: userRow.first_name,
      lastName: userRow.last_name,
      role: userRow.role,
      planSlug,
    };

    return this.generateTokens(user);
  }

  // ── Uitloggen ────────────────────────────────────────────────
  async logout(refreshToken: string): Promise<void> {
    const tokenHash = this.hashToken(refreshToken);
    await this.repo.revokeRefreshToken(tokenHash);
    logger.info('auth.logout');
  }

  // ── Wachtwoord reset aanvragen ───────────────────────────────
  async requestPasswordReset(email: string): Promise<void> {
    const user = await this.repo.findUserByEmail(email);

    // Altijd succes teruggeven, ook als email niet bestaat
    // (voorkomt dat aanvallers kunnen raden welke emails bestaan)
    if (!user) return;

    const token = crypto.randomBytes(32).toString('hex');
    const tokenHash = this.hashToken(token);

    await db.query(
      `INSERT INTO password_reset_tokens (user_id, token_hash)
       VALUES ($1, $2)
       ON CONFLICT DO NOTHING`,
      [user.id, tokenHash],
      { allowNoTenant: true }
    );

    // In productie: stuur email via Resend/SendGrid
    // await emailService.sendPasswordReset(email, token);

    logger.info('auth.password_reset.requested', { userId: user.id });
  }

  // ── Wachtwoord resetten ──────────────────────────────────────
  async resetPassword(token: string, newPassword: string): Promise<void> {
    const tokenHash = this.hashToken(token);

    const tokenRow = await this.repo.findPasswordResetToken(tokenHash);
    if (!tokenRow || tokenRow.used || new Date(tokenRow.expires_at) < new Date()) {
      throw new ValidationError('Ongeldige of verlopen reset-link.');
    }

    const passwordHash = await bcrypt.hash(newPassword, 12);

    await db.transaction(async (client) => {
      await client.query(
        `UPDATE users SET password_hash = $1 WHERE id = $2`,
        [passwordHash, tokenRow.user_id]
      );
      await client.query(
        `UPDATE password_reset_tokens SET used = true WHERE id = $1`,
        [tokenRow.id]
      );
      // Alle actieve sessies intrekken na wachtwoord reset
      await client.query(
        `UPDATE refresh_tokens SET revoked = true WHERE user_id = $1`,
        [tokenRow.user_id]
      );
    });

    logger.info('auth.password_reset.completed', { userId: tokenRow.user_id });
  }

  // ── Private helpers ──────────────────────────────────────────

  private async generateTokens(user: AuthUser): Promise<AuthTokens> {
    const accessToken = jwt.sign(
      {
        tenantId:   user.tenantId,
        tenantSlug: user.tenantId,   // wordt hieronder overschreven
        userId:     user.userId,
        planSlug:   user.planSlug,
        role:       user.role,
      },
      process.env.JWT_SECRET!,
      { expiresIn: ACCESS_TOKEN_TTL }
    );

    // Refresh token: willekeurig, opgeslagen als hash
    const rawRefreshToken = crypto.randomBytes(40).toString('hex');
    const tokenHash = this.hashToken(rawRefreshToken);

    await db.query(
      `INSERT INTO refresh_tokens (tenant_id, user_id, token_hash, expires_at)
       VALUES ($1, $2, $3, now() + interval '30 days')`,
      [user.tenantId, user.userId, tokenHash],
      { allowNoTenant: true }
    );

    return {
      accessToken,
      refreshToken: rawRefreshToken,
      expiresIn: 15 * 60,  // 15 minuten in seconden
    };
  }

  private hashToken(token: string): string {
    return crypto.createHash('sha256').update(token).digest('hex');
  }

  private generateSlug(name: string): string {
    return name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 50) + '-' + crypto.randomBytes(3).toString('hex');
  }

  private async sendVerificationEmail(userId: string, email: string): Promise<void> {
    const token = crypto.randomBytes(32).toString('hex');
    const tokenHash = this.hashToken(token);

    await db.query(
      `INSERT INTO email_verification_tokens (user_id, token_hash)
       VALUES ($1, $2)`,
      [userId, tokenHash],
      { allowNoTenant: true }
    );

    // In productie: stuur email via Resend/SendGrid
    // await emailService.sendVerification(email, token);
    logger.info('auth.verification_email.sent', { userId });
  }
}

// ── Custom Errors ────────────────────────────────────────────
export class UnauthorizedError extends Error {
  httpStatus = 401;
  constructor(message: string) { super(message); this.name = 'UnauthorizedError'; }
}
export class ConflictError extends Error {
  httpStatus = 409;
  constructor(message: string) { super(message); this.name = 'ConflictError'; }
}
export class ValidationError extends Error {
  httpStatus = 400;
  constructor(message: string) { super(message); this.name = 'ValidationError'; }
}
