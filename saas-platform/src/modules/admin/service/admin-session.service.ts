// ============================================================
// src/modules/admin/service/admin-session.service.ts
//
// Manages admin sessions backed by the `admin_sessions` table.
//
// SECURITY:
//   - Tokens are 32 random bytes (256 bits), base64url-encoded
//   - Only the SHA-256 hash is stored in the database
//   - Plaintext token is only returned once at creation
//   - Sessions expire after 8 hours
//   - Sessions can be revoked individually or all at once
//   - Validation is cached in Redis for 60 seconds for performance
// ============================================================

import crypto from 'crypto';
import { db } from '../../../infrastructure/database/connection';
import { cache } from '../../../infrastructure/cache/redis';
import { logger } from '../../../shared/logging/logger';

const SESSION_TTL_MS       = 8 * 60 * 60 * 1000;  // 8 hours
const SESSION_CACHE_TTL_S  = 60;                   // 60 seconds

export interface AdminSession {
  id:        string;
  expiresAt: Date;
  ipAddress: string | null;
  userAgent: string | null;
}

function hashToken(plain: string): string {
  return crypto.createHash('sha256').update(plain).digest('hex');
}

function generateToken(): string {
  // 32 bytes = 256 bits, base64url for URL-safe transport
  return crypto.randomBytes(32).toString('base64url');
}

export class AdminSessionService {

  /**
   * Verifies the admin password and creates a new session.
   * Returns the plaintext token (only time it is exposed).
   */
  async login(
    password: string,
    meta: { ip?: string; userAgent?: string }
  ): Promise<{ token: string; session: AdminSession } | null> {
    const expected = process.env.ADMIN_SECRET;

    if (!expected) {
      logger.error('admin.login.misconfigured', { reason: 'ADMIN_SECRET missing' });
      return null;
    }

    // Constant-time comparison to prevent timing attacks
    const passwordBuf = Buffer.from(password);
    const expectedBuf = Buffer.from(expected);

    if (passwordBuf.length !== expectedBuf.length) {
      return null;
    }

    if (!crypto.timingSafeEqual(passwordBuf, expectedBuf)) {
      return null;
    }

    const token     = generateToken();
    const tokenHash = hashToken(token);
    const expiresAt = new Date(Date.now() + SESSION_TTL_MS);

    const result = await db.query<{ id: string }>(
      `INSERT INTO admin_sessions (token_hash, expires_at, ip_address, user_agent)
       VALUES ($1, $2, $3, $4)
       RETURNING id`,
      [tokenHash, expiresAt, meta.ip ?? null, meta.userAgent?.substring(0, 500) ?? null],
      { allowNoTenant: true }
    );

    const sessionId = result.rows[0].id;

    return {
      token,
      session: {
        id:        sessionId,
        expiresAt,
        ipAddress: meta.ip ?? null,
        userAgent: meta.userAgent ?? null,
      },
    };
  }

  /**
   * Validates a session token and returns the session if valid.
   * Cached in Redis for performance — only DB hit once per minute per session.
   */
  async verify(token: string | undefined | null): Promise<AdminSession | null> {
    if (!token || token.length < 20 || token.length > 100) {
      return null;
    }

    const tokenHash = hashToken(token);
    const cacheKey  = `admin:session:${tokenHash}`;

    // Check Redis cache first
    try {
      const cached = await cache.get(cacheKey);
      if (cached === 'invalid') {
        return null;
      }
      if (cached) {
        try {
          const parsed = JSON.parse(cached) as AdminSession & { expiresAt: string };
          if (new Date(parsed.expiresAt) > new Date()) {
            return {
              id:        parsed.id,
              expiresAt: new Date(parsed.expiresAt),
              ipAddress: parsed.ipAddress,
              userAgent: parsed.userAgent,
            };
          }
        } catch {
          // Cache corrupt, fall through to DB
        }
      }
    } catch {
      // Redis down, fall through to DB
    }

    // DB lookup
    const result = await db.query<{
      id: string;
      expires_at: Date;
      ip_address: string | null;
      user_agent: string | null;
      revoked: boolean;
    }>(
      `SELECT id, expires_at, ip_address, user_agent, revoked
       FROM admin_sessions
       WHERE token_hash = $1`,
      [tokenHash],
      { allowNoTenant: true }
    );

    const row = result.rows[0];

    if (!row || row.revoked || row.expires_at < new Date()) {
      // Cache the negative result briefly to absorb retry storms
      try { await cache.set(cacheKey, 'invalid', 60); } catch {}
      return null;
    }

    const session: AdminSession = {
      id:        row.id,
      expiresAt: row.expires_at,
      ipAddress: row.ip_address,
      userAgent: row.user_agent,
    };

    // Update last_seen and cache
    db.query(
      `UPDATE admin_sessions SET last_seen_at = now() WHERE id = $1`,
      [row.id],
      { allowNoTenant: true }
    ).catch(err => {
      logger.warn('admin.session.last_seen_update_failed', { error: (err as Error).message });
    });

    try {
      await cache.set(cacheKey, JSON.stringify({
        id:        session.id,
        expiresAt: session.expiresAt.toISOString(),
        ipAddress: session.ipAddress,
        userAgent: session.userAgent,
      }), SESSION_CACHE_TTL_S);
    } catch {}

    return session;
  }

  /**
   * Revokes a single session by token.
   */
  async revoke(token: string): Promise<void> {
    const tokenHash = hashToken(token);

    await db.query(
      `UPDATE admin_sessions
       SET revoked = true, revoked_at = now()
       WHERE token_hash = $1 AND revoked = false`,
      [tokenHash],
      { allowNoTenant: true }
    );

    const cacheKey = `admin:session:${tokenHash}`;
    try { await cache.del(cacheKey); } catch {}
  }

  /**
   * Revokes all active admin sessions. Use after suspected compromise.
   */
  async revokeAll(): Promise<number> {
    const result = await db.query<{ count: string }>(
      `WITH revoked AS (
         UPDATE admin_sessions
         SET revoked = true, revoked_at = now()
         WHERE revoked = false
         RETURNING token_hash
       )
       SELECT COUNT(*) as count FROM revoked`,
      [],
      { allowNoTenant: true }
    );

    // Best-effort cache invalidation; sessions will fall back to DB anyway
    logger.warn('admin.session.revoke_all', { count: result.rows[0].count });

    return parseInt(result.rows[0].count, 10);
  }

  /**
   * Audit logging helper. Use for every admin action.
   */
  async auditLog(params: {
    sessionId?: string;
    action:     string;
    resource?:  string;
    targetId?:  string;
    ip?:        string;
    userAgent?: string;
    metadata?:  Record<string, unknown>;
  }): Promise<void> {
    try {
      await db.query(
        `INSERT INTO admin_audit_log
           (session_id, action, resource, target_id, ip_address, user_agent, metadata)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          params.sessionId      ?? null,
          params.action,
          params.resource       ?? null,
          params.targetId       ?? null,
          params.ip             ?? null,
          params.userAgent?.substring(0, 500) ?? null,
          JSON.stringify(params.metadata ?? {}),
        ],
        { allowNoTenant: true }
      );
    } catch (err) {
      logger.warn('admin.audit.log_failed', {
        action: params.action,
        error: (err as Error).message,
      });
    }
  }

  /**
   * Records an impersonation event in the dedicated table.
   * Used for tenant notifications and detailed audit.
   */
  async logImpersonation(params: {
    sessionId:           string;
    tenantId:            string;
    impersonatedUserId:  string;
    reason?:             string;
    ip?:                 string;
    expiresAt:           Date;
  }): Promise<string> {
    const result = await db.query<{ id: string }>(
      `INSERT INTO admin_impersonation_log
         (session_id, tenant_id, impersonated_user_id, reason, ip_address, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id`,
      [
        params.sessionId,
        params.tenantId,
        params.impersonatedUserId,
        params.reason ?? null,
        params.ip ?? null,
        params.expiresAt,
      ],
      { allowNoTenant: true }
    );

    return result.rows[0].id;
  }
}

export const adminSessionService = new AdminSessionService();
