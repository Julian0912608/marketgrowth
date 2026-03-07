// src/modules/auth/service/auth.service.ts
//
// KRITIEKE FIXES:
// 1. Registratie werkt zonder Redis (Redis is optioneel)
// 2. Juiste tenant aanmaken bij registratie
// 3. JWT tokens correct aanmaken
// 4. Wachtwoord hashing met bcrypt

import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { v4 as uuidv4 } from 'uuid';
import { db } from '../../../infrastructure/database/connection';
import { logger } from '../../../shared/logging/logger';

interface RegisterInput {
  firstName: string;
  lastName:  string;
  email:     string;
  password:  string;
  planSlug?: string;
}

interface LoginInput {
  email:    string;
  password: string;
}

interface AuthResult {
  accessToken:  string;
  refreshToken: string;
  user: {
    id:        string;
    email:     string;
    firstName: string;
    lastName:  string;
    tenantId:  string;
    planSlug:  string;
  };
}

const JWT_SECRET          = () => process.env.JWT_SECRET || 'dev-secret-change-in-production';
const ACCESS_TOKEN_TTL    = '15m';
const REFRESH_TOKEN_TTL   = '30d';
const BCRYPT_ROUNDS       = 12;

export class AuthService {

  // ── Registratie ───────────────────────────────────────────
  async register(input: RegisterInput): Promise<AuthResult> {
    const { firstName, lastName, email, password, planSlug = 'starter' } = input;

    // Check of email al bestaat
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

    // Wachtwoord hashen
    const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);

    // Tenant aanmaken
    const tenantId   = uuidv4();
    const tenantName = `${firstName} ${lastName}'s workspace`;

    await db.query(
      `INSERT INTO tenants (id, name, plan_slug, status, created_at, updated_at)
       VALUES ($1, $2, $3, 'active', now(), now())`,
      [tenantId, tenantName, planSlug],
      { allowNoTenant: true }
    );

    // User aanmaken
    const userId = uuidv4();
    await db.query(
      `INSERT INTO users (
        id, tenant_id, email, password_hash,
        first_name, last_name, role, status,
        created_at, updated_at
       ) VALUES ($1, $2, $3, $4, $5, $6, 'owner', 'active', now(), now())`,
      [userId, tenantId, email.toLowerCase(), passwordHash, firstName, lastName],
      { allowNoTenant: true }
    );

    logger.info('auth.register.success', { userId, tenantId, email });

    return this.generateTokens(userId, tenantId, email, firstName, lastName, planSlug);
  }

  // ── Login ─────────────────────────────────────────────────
  async login(input: LoginInput): Promise<AuthResult> {
    const { email, password } = input;

    // User ophalen
    const result = await db.query<{
      id: string; tenant_id: string; password_hash: string;
      first_name: string; last_name: string; status: string;
    }>(
      `SELECT u.id, u.tenant_id, u.password_hash, u.first_name, u.last_name, u.status,
              t.plan_slug
       FROM users u
       JOIN tenants t ON t.id = u.tenant_id
       WHERE u.email = $1`,
      [email.toLowerCase()],
      { allowNoTenant: true }
    );

    const user = result.rows[0];

    if (!user) {
      const err: any = new Error('Onjuist e-mailadres of wachtwoord');
      err.statusCode = 401;
      throw err;
    }

    if (user.status !== 'active') {
      const err: any = new Error('Account is gedeactiveerd');
      err.statusCode = 403;
      throw err;
    }

    // Wachtwoord controleren
    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) {
      const err: any = new Error('Onjuist e-mailadres of wachtwoord');
      err.statusCode = 401;
      throw err;
    }

    logger.info('auth.login.success', { userId: user.id, tenantId: user.tenant_id });

    return this.generateTokens(
      user.id,
      user.tenant_id,
      email,
      user.first_name,
      user.last_name,
      (result.rows[0] as any).plan_slug || 'starter'
    );
  }

  // ── Token generatie ───────────────────────────────────────
  private generateTokens(
    userId: string,
    tenantId: string,
    email: string,
    firstName: string,
    lastName: string,
    planSlug: string
  ): AuthResult {
    const secret = JWT_SECRET();

    const accessToken = jwt.sign(
      { sub: userId, tenantId, email, planSlug, firstName, lastName },
      secret,
      { expiresIn: ACCESS_TOKEN_TTL }
    );

    const refreshToken = jwt.sign(
      { sub: userId, tenantId, type: 'refresh' },
      secret,
      { expiresIn: REFRESH_TOKEN_TTL }
    );

    return {
      accessToken,
      refreshToken,
      user: { id: userId, email, firstName, lastName, tenantId, planSlug },
    };
  }

  // ── Refresh token ─────────────────────────────────────────
  async refreshToken(token: string): Promise<{ accessToken: string }> {
    let payload: any;
    try {
      payload = jwt.verify(token, JWT_SECRET());
    } catch {
      const err: any = new Error('Ongeldige refresh token');
      err.statusCode = 401;
      throw err;
    }

    if (payload.type !== 'refresh') {
      const err: any = new Error('Ongeldige token type');
      err.statusCode = 401;
      throw err;
    }

    // Haal user info op voor nieuwe token
    const result = await db.query<{
      email: string; first_name: string; last_name: string; plan_slug: string;
    }>(
      `SELECT u.email, u.first_name, u.last_name, t.plan_slug
       FROM users u JOIN tenants t ON t.id = u.tenant_id
       WHERE u.id = $1 AND u.status = 'active'`,
      [payload.sub],
      { allowNoTenant: true }
    );

    const user = result.rows[0];
    if (!user) {
      const err: any = new Error('Gebruiker niet gevonden');
      err.statusCode = 401;
      throw err;
    }

    const accessToken = jwt.sign(
      {
        sub: payload.sub,
        tenantId: payload.tenantId,
        email: user.email,
        planSlug: user.plan_slug,
        firstName: user.first_name,
        lastName: user.last_name,
      },
      JWT_SECRET(),
      { expiresIn: ACCESS_TOKEN_TTL }
    );

    return { accessToken };
  }

  // ── Profiel ophalen ───────────────────────────────────────
  async getProfile(userId: string): Promise<object> {
    const result = await db.query(
      `SELECT u.id, u.email, u.first_name, u.last_name, u.role, u.created_at,
              t.id AS tenant_id, t.name AS tenant_name, t.plan_slug
       FROM users u
       JOIN tenants t ON t.id = u.tenant_id
       WHERE u.id = $1`,
      [userId],
      { allowNoTenant: true }
    );

    if (!result.rows[0]) {
      const err: any = new Error('Gebruiker niet gevonden');
      err.statusCode = 404;
      throw err;
    }

    return result.rows[0];
  }
}
