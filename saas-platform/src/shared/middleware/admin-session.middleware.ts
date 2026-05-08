// ============================================================
// src/shared/middleware/admin-session.middleware.ts
//
// Express middleware voor admin-only routes.
// Valideert het 'x-admin-session' header tegen de admin_sessions tabel.
//
// Schema admin_sessions:
//   id          uuid (PK)
//   token_hash  text  ← SHA-256 hex hash van de raw token
//   expires_at  timestamptz
//   revoked     boolean
//   ...
//
// De client (cookie / x-admin-session header) bevat de raw token.
// Wij hashen die met SHA-256 en zoeken op token_hash.
//
// Gebruik:
//   import { requireAdminSession } from '../../shared/middleware/admin-session.middleware';
//   router.use(requireAdminSession());
// ============================================================

import { Request, Response, NextFunction } from 'express';
import { createHash } from 'crypto';
import { db }     from '../../infrastructure/database/connection';
import { logger } from '../logging/logger';

interface AdminSessionRequest extends Request {
  adminSessionToken?: string;
}

function hashToken(rawToken: string): string {
  return createHash('sha256').update(rawToken).digest('hex');
}

async function isValidAdminSession(rawToken: string): Promise<boolean> {
  if (!rawToken || rawToken.length < 16) return false;

  const tokenHash = hashToken(rawToken);

  try {
    const result = await db.query<{ valid: number }>(
      `SELECT 1 AS valid
       FROM admin_sessions
       WHERE token_hash = $1
         AND expires_at > NOW()
         AND revoked = false
       LIMIT 1`,
      [tokenHash],
      { allowNoTenant: true }
    );

    if (result.rows.length === 0) return false;

    // Touch last_seen_at zodat we activity kunnen tracken.
    // Best-effort: faal niet als deze update faalt.
    db.query(
      `UPDATE admin_sessions SET last_seen_at = NOW() WHERE token_hash = $1`,
      [tokenHash],
      { allowNoTenant: true }
    ).catch(() => { /* swallow */ });

    return true;
  } catch (err) {
    logger.error('admin.session.lookup_failed', {
      error: (err as Error).message,
    });
    return false;
  }
}

export function requireAdminSession() {
  return async (req: AdminSessionRequest, res: Response, next: NextFunction): Promise<void> => {
    const token = req.header('x-admin-session');

    if (!token) {
      res.status(401).json({ error: 'admin_session_required' });
      return;
    }

    const valid = await isValidAdminSession(token);
    if (!valid) {
      res.status(401).json({ error: 'invalid_or_expired_admin_session' });
      return;
    }

    req.adminSessionToken = token;
    next();
  };
}

export { isValidAdminSession };
