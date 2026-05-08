// ============================================================
// src/shared/middleware/admin-session.middleware.ts
//
// Express middleware voor admin-only routes.
// Valideert het 'x-admin-session' header tegen de admin_sessions tabel.
//
// Aanname over schema: admin_sessions heeft kolommen 'token' (TEXT)
// en 'expires_at' (TIMESTAMPTZ). Als kolomnamen anders zijn faalt de
// query closed (deny access) — controleer Railway logs bij eerste deploy.
//
// Gebruik:
//   import { requireAdminSession } from '../../shared/middleware/admin-session.middleware';
//   router.use(requireAdminSession());
// ============================================================

import { Request, Response, NextFunction } from 'express';
import { db }     from '../../infrastructure/database/connection';
import { logger } from '../logging/logger';

interface AdminSessionRequest extends Request {
  adminSessionToken?: string;
}

async function isValidAdminSession(token: string): Promise<boolean> {
  if (!token || token.length < 16) return false;

  try {
    const result = await db.query<{ valid: boolean }>(
      `SELECT 1 AS valid
       FROM admin_sessions
       WHERE token = $1
         AND expires_at > NOW()
       LIMIT 1`,
      [token],
      { allowNoTenant: true }
    );
    return result.rows.length > 0;
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
