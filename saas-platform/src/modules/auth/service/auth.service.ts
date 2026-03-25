// ============================================================
// saas-platform/src/modules/auth/service/auth.service.ts
//
// SECURITY UPDATE:
//   - Refresh token rotation: bij elke refresh wordt het oude
//     token ingetrokken en een nieuw uitgegeven
//   - Audit logging op alle auth events
//   - Token reuse detection: als een al-gebruikt token wordt
//     aangeboden, worden ALLE tokens van die gebruiker ingetrokken
// ============================================================

import bcrypt from 'bcryptjs';
import jwt    from 'jsonwebtoken';
import crypto from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import { db }     from '../../../infrastructure/database/connection';
import { logger } from '../../../shared/logging/logger';

interface RegisterInput {
  firstName:    string;
  lastName:     string;
  email:        string;
  password:     string;
  companyName?: string;
  planSlug?:    string;
}

interface LoginInput {
  email:    string;
  password: string;
}

interface TokenPair {
  accessToken:  string;
  refreshToken: string;
  expiresIn:    number;
}

interface AuthResult {
  tokens: TokenPair;
  user: {
    userId:    string;
    email:     string;
    firstName: string;
    lastName:  string;
    tenantId:  string;
    planSlug:  string;
    role:      string;
  };
}

const JWT_SECRET               = () => process.env.JWT_SECRET ?? 'dev-secret-change-in-production';
const ACCESS_TOKEN_TTL         = '15m';
const ACCESS_TOKEN_TTL_SECONDS = 15 * 60;
const REFRESH_TOKEN_TTL        = '30d';
const REFRESH_TOKEN_TTL_MS     = 30 * 24 * 60 * 60 * 1000;
const BCRYPT_ROUNDS            = 12;

function generateSlug(text: string): string {
  return text
    .toLowerCase().trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .substring(0, 50) + '-' + uuidv4().substring(0, 8);
}

// ── Audit helper ──────────────────────────────────────────────
async function auditLog(params: {
  tenantId?:  string;
  userId?:    string;
  action:     string;
  resource?:  string;
  ipAddress?: string;
  userAgent?: string;
  metadata?:  Record<string, unknown>;
}): Promise<void> {
  try {
    await db.query(
      `INSERT INTO audit_logs (tenant_id, user_id, action, resource, ip_address, user_agent, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        params.tenantId  || null,
        params.userId    || null,
        params.action,
        params.resource  || null,
        params.ipAddress || null,
        params.userAgent || null,
        JSON.stringify(params.metadata || {}),
      ],
      { allowNoTenant: true }
    );
  } catch (err) {
    // Audit logging mag nooit een request laten falen
    logger.warn('audit.log.failed', { action: params.action, error: (err as Error).message });
  }
}

export class AuthService {

  // ── Registreren ───────────────────────────────────────────
  async register(input: RegisterInput, meta?: { ip?: string; ua?: string }): Promise<AuthResult> {
    const { firstName, lastName, email, password, companyName, planSlug = 'starter' } = input;

    const existing = await db.query(
      'SELECT id FROM users WHERE email = $1',
      [email.toLowerCase()],
      { allowNoTenant: true }
    );
    if (existing.rows.length > 0) {
      const err: any = new Error('Dit e-mailadres is al in gebruik');
      err.statusCode = 409;
      throw err;
    }

    const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
    const tenantId     = uuidv4();
    const tenantName   = companyName || `${firstName} ${lastName}'s workspace`;
    const tenantSlug   = generateSlug(tenantName);

    await db.query(
      `INSERT INTO tenants (id, name, slug, email, plan_slug, status, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, 'active', now(), now())`,
      [tenantId, tenantName, tenantSlug, email.toLowerCase(), planSlug],
      { allowNoTenant: true }
    );

    const userId = uuidv4();
    await db.query(
      `INSERT INTO users (id, tenant_id, email, password_hash, first_name, last_name, role, status, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, 'owner', 'active', now(), now())`,
      [userId, tenantId, email.toLowerCase(), passwordHash, firstName, lastName],
      { allowNoTenant: true }
    );

    await auditLog({
      tenantId, userId,
      action:    'auth.register',
      ipAddress: meta?.ip,
      userAgent: meta?.ua,
      metadata:  { email: email.toLowerCase() },
    });

    logger.info('auth.register.success', { userId, tenantId });
    return this.buildAuthResult(userId, tenantId, email.toLowerCase(), firstName, lastName, planSlug, 'owner', meta);
  }

  // ── Inloggen ──────────────────────────────────────────────
  async login(input: LoginInput, meta?: { ip?: string; ua?: string }): Promise<AuthResult> {
    const { email, password } = input;

    const userResult = await db.query<{
      id: string; tenant_id: string; password_hash: string | null;
      first_name: string; last_name: string; role: string; status: string; plan_slug: string;
    }>(
      `SELECT u.id, u.tenant_id, u.password_hash, u.first_name, u.last_name, u.role, u.status,
              COALESCE(
                (SELECT p.slug FROM tenant_subscriptions ts
                 JOIN plans p ON p.id = ts.plan_id
                 WHERE ts.tenant_id = u.tenant_id AND ts.status IN ('active','trialing')
                 ORDER BY ts.created_at DESC LIMIT 1),
                t.plan_slug, 'starter'
              ) AS plan_slug
       FROM users u
       JOIN tenants t ON t.id = u.tenant_id
       WHERE u.email = $1 LIMIT 1`,
      [email.toLowerCase()],
      { allowNoTenant: true }
    );

    const user = userResult.rows[0];

    if (!user || !user.password_hash) {
      await auditLog({ action: 'auth.login.failed', ipAddress: meta?.ip, metadata: { email } });
      const err: any = new Error('Onjuist e-mailadres of wachtwoord');
      err.statusCode = 401;
      throw err;
    }

    if (user.status === 'suspended') {
      await auditLog({ tenantId: user.tenant_id, userId: user.id, action: 'auth.login.suspended', ipAddress: meta?.ip });
      const err: any = new Error('Account is gedeactiveerd');
      err.statusCode = 403;
      throw err;
    }

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) {
      await auditLog({ tenantId: user.tenant_id, userId: user.id, action: 'auth.login.wrong_password', ipAddress: meta?.ip });
      const err: any = new Error('Onjuist e-mailadres of wachtwoord');
      err.statusCode = 401;
      throw err;
    }

    await auditLog({
      tenantId:  user.tenant_id,
      userId:    user.id,
      action:    'auth.login.success',
      ipAddress: meta?.ip,
      userAgent: meta?.ua,
    });

    logger.info('auth.login.success', { userId: user.id, tenantId: user.tenant_id });
    return this.buildAuthResult(user.id, user.tenant_id, email.toLowerCase(), user.first_name, user.last_name, user.plan_slug, user.role, meta);
  }

  // ── Refresh token rotation ────────────────────────────────
  // Bij elk gebruik:
  //   1. Oude token intrekken (revoke)
  //   2. Nieuw token uitgeven
  //   3. Als het token al gebruikt was → alle tokens intrekken (reuse attack)
  async refreshAccessToken(refreshToken: string, meta?: { ip?: string; ua?: string }): Promise<{ accessToken: string; refreshToken: string; expiresIn: number }> {
    let payload: any;
    try {
      payload = jwt.verify(refreshToken, JWT_SECRET());
    } catch {
      const err: any = new Error('Ongeldige of verlopen refresh token');
      err.statusCode = 401;
      throw err;
    }

    if (payload.type !== 'refresh') {
      const err: any = new Error('Ongeldige token type');
      err.statusCode = 401;
      throw err;
    }

    const tokenHash = crypto.createHash('sha256').update(refreshToken).digest('hex');
    const tokenRow  = await db.query<{
      id: string; user_id: string; tenant_id: string;
      revoked: boolean; expires_at: string; used_at: string | null;
    }>(
      `SELECT id, user_id, tenant_id, revoked, expires_at, used_at
       FROM refresh_tokens WHERE token_hash = $1 LIMIT 1`,
      [tokenHash],
      { allowNoTenant: true }
    );

    const stored = tokenRow.rows[0];

    if (!stored || new Date(stored.expires_at) < new Date()) {
      const err: any = new Error('Refresh token is verlopen');
      err.statusCode = 401;
      throw err;
    }

    // ✅ TOKEN REUSE DETECTIE
    // Als token al eerder gebruikt is, is er mogelijk een aanval gaande.
    // Trek dan ALLE refresh tokens van deze gebruiker in.
    if (stored.used_at !== null) {
      logger.warn('auth.refresh.token_reuse_detected', {
        userId:   stored.user_id,
        tenantId: stored.tenant_id,
        tokenId:  stored.id,
      });

      await db.query(
        `UPDATE refresh_tokens SET revoked = true WHERE user_id = $1`,
        [stored.user_id],
        { allowNoTenant: true }
      );

      await auditLog({
        tenantId:  stored.tenant_id,
        userId:    stored.user_id,
        action:    'auth.refresh.token_reuse_attack',
        ipAddress: meta?.ip,
        metadata:  { tokenId: stored.id },
      });

      const err: any = new Error('Sessie ongeldig — log opnieuw in');
      err.statusCode = 401;
      throw err;
    }

    if (stored.revoked) {
      await auditLog({
        tenantId:  stored.tenant_id,
        userId:    stored.user_id,
        action:    'auth.refresh.revoked_token_used',
        ipAddress: meta?.ip,
      });
      const err: any = new Error('Refresh token is ingetrokken');
      err.statusCode = 401;
      throw err;
    }

    // Markeer het huidige token als gebruikt (niet hard revoken — voor reuse detectie)
    await db.query(
      `UPDATE refresh_tokens SET used_at = now(), ip_address = $2, user_agent = $3 WHERE id = $1`,
      [stored.id, meta?.ip || null, meta?.ua || null],
      { allowNoTenant: true }
    );

    // Haal actuele planSlug op
    const userRow = await db.query<{
      email: string; first_name: string; last_name: string; plan_slug: string; role: string;
    }>(
      `SELECT u.email, u.first_name, u.last_name, u.role,
              COALESCE(
                (SELECT p.slug FROM tenant_subscriptions ts
                 JOIN plans p ON p.id = ts.plan_id
                 WHERE ts.tenant_id = u.tenant_id AND ts.status IN ('active','trialing')
                 ORDER BY ts.created_at DESC LIMIT 1),
                t.plan_slug, 'starter'
              ) AS plan_slug
       FROM users u JOIN tenants t ON t.id = u.tenant_id
       WHERE u.id = $1 LIMIT 1`,
      [stored.user_id],
      { allowNoTenant: true }
    );

    if (!userRow.rows[0]) {
      const err: any = new Error('Gebruiker niet gevonden');
      err.statusCode = 401;
      throw err;
    }

    const u = userRow.rows[0];

    // ✅ Nieuw access token
    const newAccessToken = jwt.sign(
      { sub: stored.user_id, tenantId: stored.tenant_id, email: u.email, planSlug: u.plan_slug, firstName: u.first_name, lastName: u.last_name, role: u.role, type: 'access' },
      JWT_SECRET(),
      { expiresIn: ACCESS_TOKEN_TTL }
    );

    // ✅ Nieuw refresh token uitgeven (rotation)
    const newRefreshToken = jwt.sign(
      { sub: stored.user_id, tenantId: stored.tenant_id, type: 'refresh' },
      JWT_SECRET(),
      { expiresIn: REFRESH_TOKEN_TTL }
    );

    const newTokenHash = crypto.createHash('sha256').update(newRefreshToken).digest('hex');
    const newExpiresAt = new Date(Date.now() + REFRESH_TOKEN_TTL_MS);

    await db.query(
      `INSERT INTO refresh_tokens (user_id, tenant_id, token_hash, expires_at, revoked, ip_address, user_agent)
       VALUES ($1, $2, $3, $4, false, $5, $6)`,
      [stored.user_id, stored.tenant_id, newTokenHash, newExpiresAt, meta?.ip || null, meta?.ua || null],
      { allowNoTenant: true }
    );

    // Markeer oud token als vervangen
    await db.query(
      `UPDATE refresh_tokens SET replaced_by = $1 WHERE id = $2`,
      [newTokenHash, stored.id],
      { allowNoTenant: true }
    );

    logger.info('auth.refresh.rotated', { userId: stored.user_id, tenantId: stored.tenant_id });

    return {
      accessToken:  newAccessToken,
      refreshToken: newRefreshToken,
      expiresIn:    ACCESS_TOKEN_TTL_SECONDS,
    };
  }

  // ── Uitloggen ─────────────────────────────────────────────
  async logout(refreshToken: string, meta?: { ip?: string }): Promise<void> {
    try {
      const tokenHash = crypto.createHash('sha256').update(refreshToken).digest('hex');
      const result    = await db.query<{ user_id: string; tenant_id: string }>(
        `UPDATE refresh_tokens SET revoked = true
         WHERE token_hash = $1
         RETURNING user_id, tenant_id`,
        [tokenHash],
        { allowNoTenant: true }
      );

      if (result.rows[0]) {
        await auditLog({
          tenantId:  result.rows[0].tenant_id,
          userId:    result.rows[0].user_id,
          action:    'auth.logout',
          ipAddress: meta?.ip,
        });
      }
    } catch (err) {
      logger.warn('auth.logout.error', { error: (err as Error).message });
    }
  }

  // ── Wachtwoord vergeten ───────────────────────────────────
  async requestPasswordReset(email: string, meta?: { ip?: string }): Promise<void> {
    const userResult = await db.query<{ id: string; tenant_id: string; first_name: string }>(
      `SELECT id, tenant_id, first_name FROM users WHERE email = $1 LIMIT 1`,
      [email.toLowerCase()],
      { allowNoTenant: true }
    );

    // Altijd succesvol antwoorden (voorkomt user enumeration)
    if (!userResult.rows[0]) return;

    const user      = userResult.rows[0];
    const tokenRaw  = crypto.randomBytes(32).toString('hex');
    const tokenHash = crypto.createHash('sha256').update(tokenRaw).digest('hex');
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000); // 1 uur

    await db.query(
      `INSERT INTO password_reset_tokens (user_id, token_hash, expires_at, used)
       VALUES ($1, $2, $3, false)`,
      [user.id, tokenHash, expiresAt],
      { allowNoTenant: true }
    );

    await auditLog({
      tenantId:  user.tenant_id,
      userId:    user.id,
      action:    'auth.password_reset.requested',
      ipAddress: meta?.ip,
    });

    logger.info('auth.password_reset.requested', { userId: user.id });
    // Email versturen via Resend (bestaande logica elders)
  }

  // ── Wachtwoord resetten ───────────────────────────────────
  async resetPassword(token: string, newPassword: string, meta?: { ip?: string }): Promise<void> {
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    const tokenRow  = await db.query<{ id: string; user_id: string; used: boolean; expires_at: string }>(
      `SELECT id, user_id, used, expires_at FROM password_reset_tokens WHERE token_hash = $1 LIMIT 1`,
      [tokenHash],
      { allowNoTenant: true }
    );

    const stored = tokenRow.rows[0];
    if (!stored || stored.used || new Date(stored.expires_at) < new Date()) {
      const err: any = new Error('Ongeldige of verlopen reset link');
      err.statusCode = 400;
      throw err;
    }

    const passwordHash = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);

    await db.query(
      `UPDATE users SET password_hash = $1, updated_at = now() WHERE id = $2`,
      [passwordHash, stored.user_id],
      { allowNoTenant: true }
    );

    await db.query(
      `UPDATE password_reset_tokens SET used = true WHERE id = $1`,
      [stored.id],
      { allowNoTenant: true }
    );

    // Trek alle refresh tokens in na password reset
    await db.query(
      `UPDATE refresh_tokens SET revoked = true WHERE user_id = $1`,
      [stored.user_id],
      { allowNoTenant: true }
    );

    const userRow = await db.query<{ tenant_id: string }>(
      `SELECT tenant_id FROM users WHERE id = $1`,
      [stored.user_id], { allowNoTenant: true }
    );

    await auditLog({
      tenantId:  userRow.rows[0]?.tenant_id,
      userId:    stored.user_id,
      action:    'auth.password_reset.completed',
      ipAddress: meta?.ip,
    });

    logger.info('auth.password_reset.completed', { userId: stored.user_id });
  }

  // ── Gebruikersprofiel ophalen ─────────────────────────────
  async getProfile(userId: string) {
    const result = await db.query(
      `SELECT u.id, u.email, u.first_name, u.last_name, u.role, u.tenant_id,
              t.name AS tenant_name, t.created_at,
              COALESCE(
                (SELECT p.slug FROM tenant_subscriptions ts
                 JOIN plans p ON p.id = ts.plan_id
                 WHERE ts.tenant_id = u.tenant_id AND ts.status IN ('active','trialing')
                 ORDER BY ts.created_at DESC LIMIT 1),
                t.plan_slug, 'starter'
              ) AS active_plan_slug
       FROM users u JOIN tenants t ON t.id = u.tenant_id WHERE u.id = $1`,
      [userId], { allowNoTenant: true }
    );

    if (!result.rows[0]) {
      const err: any = new Error('Gebruiker niet gevonden');
      err.statusCode = 404;
      throw err;
    }

    const u = result.rows[0];
    return {
      userId:    u.id,
      email:     u.email,
      firstName: u.first_name,
      lastName:  u.last_name,
      role:      u.role,
      tenantId:  u.tenant_id,
      tenantName: u.tenant_name,
      planSlug:  u.active_plan_slug,
      createdAt: u.created_at,
    };
  }

  // ── Tokens aanmaken (intern) ──────────────────────────────
  private async buildAuthResult(
    userId: string, tenantId: string, email: string,
    firstName: string, lastName: string,
    planSlug: string, role: string,
    meta?: { ip?: string; ua?: string }
  ): Promise<AuthResult> {
    const accessToken = jwt.sign(
      { sub: userId, tenantId, email, planSlug, firstName, lastName, role, type: 'access' },
      JWT_SECRET(),
      { expiresIn: ACCESS_TOKEN_TTL }
    );

    const refreshToken = jwt.sign(
      { sub: userId, tenantId, type: 'refresh' },
      JWT_SECRET(),
      { expiresIn: REFRESH_TOKEN_TTL }
    );

    const tokenHash = crypto.createHash('sha256').update(refreshToken).digest('hex');
    const expiresAt = new Date(Date.now() + REFRESH_TOKEN_TTL_MS);

    await db.query(
      `INSERT INTO refresh_tokens (user_id, tenant_id, token_hash, expires_at, revoked, ip_address, user_agent)
       VALUES ($1, $2, $3, $4, false, $5, $6)
       ON CONFLICT (token_hash) DO NOTHING`,
      [userId, tenantId, tokenHash, expiresAt, meta?.ip || null, meta?.ua || null],
      { allowNoTenant: true }
    );

    return {
      tokens: { accessToken, refreshToken, expiresIn: ACCESS_TOKEN_TTL_SECONDS },
      user:   { userId, email, firstName, lastName, tenantId, planSlug, role },
    };
  }
}
