import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { v4 as uuidv4 } from 'uuid';
import { db } from '../../../infrastructure/database/connection';
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

const JWT_SECRET        = () => process.env.JWT_SECRET ?? 'dev-secret-change-in-production';
const ACCESS_TOKEN_TTL  = '15m';
const ACCESS_TOKEN_TTL_SECONDS = 15 * 60;
const REFRESH_TOKEN_TTL = '30d';
const BCRYPT_ROUNDS     = 12;

function generateSlug(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .substring(0, 50)
    + '-' + uuidv4().substring(0, 8);
}

export class AuthService {

  async register(input: RegisterInput): Promise<AuthResult> {
    const { firstName, lastName, email, password, companyName, planSlug = 'starter' } = input;

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

    const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
    const tenantId     = uuidv4();
    const tenantName   = companyName || `${firstName} ${lastName}'s workspace`;
    const tenantSlug   = generateSlug(tenantName);

    // Maak tenant aan — met plan_slug kolom (toegevoegd door migratie 003)
    await db.query(
      `INSERT INTO tenants (id, name, slug, email, plan_slug, status, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, 'active', now(), now())`,
      [tenantId, tenantName, tenantSlug, email.toLowerCase(), planSlug],
      { allowNoTenant: true }
    );
    // Trigger auto_create_starter_subscription maakt automatisch de subscription aan

    // Maak user aan
    const userId = uuidv4();
    await db.query(
      `INSERT INTO users (id, tenant_id, email, password_hash, first_name, last_name, role, status, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, 'owner', 'active', now(), now())`,
      [userId, tenantId, email.toLowerCase(), passwordHash, firstName, lastName],
      { allowNoTenant: true }
    );

    // Maak onboarding progress aan
    await db.query(
      `INSERT INTO onboarding_progress (tenant_id, current_step, completed_steps, created_at, updated_at)
       VALUES ($1, 'plan_selected', ARRAY[]::text[], now(), now())
       ON CONFLICT DO NOTHING`,
      [tenantId],
      { allowNoTenant: true }
    ).catch(() => { /* onboarding tabel optioneel */ });

    logger.info('auth.register.success', { userId, tenantId, email });

    return this.buildAuthResult(userId, tenantId, email, firstName, lastName, planSlug, 'owner');
  }

  async login(input: LoginInput): Promise<AuthResult> {
    const { email, password } = input;

    // Haal user + plan op via tenant_subscriptions (niet via tenants.plan_slug direct)
    const result = await db.query<{
      id: string; tenant_id: string; password_hash: string;
      first_name: string; last_name: string; status: string;
      role: string; plan_slug: string;
    }>(
      `SELECT u.id, u.tenant_id, u.password_hash, u.first_name, u.last_name,
              u.status, u.role,
              COALESCE(
                (SELECT p.slug FROM tenant_subscriptions ts
                 JOIN plans p ON p.id = ts.plan_id
                 WHERE ts.tenant_id = u.tenant_id
                   AND ts.status IN ('active','trialing')
                 ORDER BY ts.created_at DESC LIMIT 1),
                t.plan_slug,
                'starter'
              ) AS plan_slug
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
      const err: any = new Error('Account is niet actief');
      err.statusCode = 403;
      throw err;
    }

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) {
      const err: any = new Error('Onjuist e-mailadres of wachtwoord');
      err.statusCode = 401;
      throw err;
    }

    logger.info('auth.login.success', { userId: user.id, tenantId: user.tenant_id });

    return this.buildAuthResult(
      user.id, user.tenant_id, email,
      user.first_name, user.last_name,
      user.plan_slug, user.role
    );
  }

  async refreshAccessToken(refreshToken: string): Promise<{ accessToken: string }> {
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

    // Check of token niet ingetrokken is
    const crypto = await import('crypto');
    const tokenHash = crypto.createHash('sha256').update(refreshToken).digest('hex');
    const tokenRow = await db.query<{ revoked: boolean; expires_at: string }>(
      `SELECT revoked, expires_at FROM refresh_tokens WHERE token_hash = $1 LIMIT 1`,
      [tokenHash],
      { allowNoTenant: true }
    );

    const stored = tokenRow.rows[0];
    if (!stored || stored.revoked || new Date(stored.expires_at) < new Date()) {
      const err: any = new Error('Refresh token is ingetrokken of verlopen');
      err.statusCode = 401;
      throw err;
    }

    // Haal actuele plan slug op
    const userRow = await db.query<{
      email: string; first_name: string; last_name: string; plan_slug: string;
    }>(
      `SELECT u.email, u.first_name, u.last_name,
              COALESCE(
                (SELECT p.slug FROM tenant_subscriptions ts
                 JOIN plans p ON p.id = ts.plan_id
                 WHERE ts.tenant_id = u.tenant_id
                   AND ts.status IN ('active','trialing')
                 ORDER BY ts.created_at DESC LIMIT 1),
                'starter'
              ) AS plan_slug
       FROM users u
       WHERE u.id = $1 AND u.status = 'active'`,
      [payload.sub],
      { allowNoTenant: true }
    );

    const user = userRow.rows[0];
    if (!user) {
      const err: any = new Error('Gebruiker niet gevonden');
      err.statusCode = 401;
      throw err;
    }

    const accessToken = jwt.sign(
      {
        sub:       payload.sub,
        tenantId:  payload.tenantId,
        email:     user.email,
        planSlug:  user.plan_slug,
        firstName: user.first_name,
        lastName:  user.last_name,
        type:      'access',
      },
      JWT_SECRET(),
      { expiresIn: ACCESS_TOKEN_TTL }
    );

    return { accessToken };
  }

  async logout(refreshToken: string): Promise<void> {
    try {
      const crypto = await import('crypto');
      const tokenHash = crypto.createHash('sha256').update(refreshToken).digest('hex');
      await db.query(
        `UPDATE refresh_tokens SET revoked = true WHERE token_hash = $1`,
        [tokenHash],
        { allowNoTenant: true }
      );
    } catch {
      // Stil falen — logout mag nooit crashen
    }
  }

  async getProfile(userId: string): Promise<object> {
    const result = await db.query(
      `SELECT u.id, u.email, u.first_name, u.last_name, u.role, u.created_at,
              t.id AS tenant_id, t.name AS tenant_name, t.plan_slug,
              COALESCE(
                (SELECT p.slug FROM tenant_subscriptions ts
                 JOIN plans p ON p.id = ts.plan_id
                 WHERE ts.tenant_id = u.tenant_id
                   AND ts.status IN ('active','trialing')
                 ORDER BY ts.created_at DESC LIMIT 1),
                t.plan_slug, 'starter'
              ) AS active_plan_slug
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

  private async buildAuthResult(
    userId: string, tenantId: string, email: string,
    firstName: string, lastName: string,
    planSlug: string, role: string
  ): Promise<AuthResult> {
    const crypto = await import('crypto');

    const accessToken = jwt.sign(
      { sub: userId, tenantId, email, planSlug, firstName, lastName, role, type: 'access' },
      JWT_SECRET(),
      { expiresIn: ACCESS_TOKEN_TTL }
    );

    const refreshTokenRaw = crypto.randomBytes(64).toString('hex');
    const refreshToken = jwt.sign(
      { sub: userId, tenantId, type: 'refresh' },
      JWT_SECRET(),
      { expiresIn: REFRESH_TOKEN_TTL }
    );

    const tokenHash = crypto.createHash('sha256').update(refreshToken).digest('hex');
    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

    await db.query(
      `INSERT INTO refresh_tokens (user_id, tenant_id, token_hash, expires_at, revoked)
       VALUES ($1, $2, $3, $4, false)
       ON CONFLICT (token_hash) DO NOTHING`,
      [userId, tenantId, tokenHash, expiresAt],
      { allowNoTenant: true }
    );

    return {
      tokens: {
        accessToken,
        refreshToken,
        expiresIn: ACCESS_TOKEN_TTL_SECONDS,
      },
      user: { userId, email, firstName, lastName, tenantId, planSlug, role },
    };
  }
}
