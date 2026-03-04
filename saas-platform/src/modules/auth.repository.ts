// ============================================================
// src/modules/auth/repository/auth.repository.ts
// Enige plek die auth-gerelateerde tabellen leest/schrijft.
// ============================================================

import { db } from '../../../infrastructure/database/connection';

export class AuthRepository {
  async findUserByEmail(email: string) {
    const result = await db.query<{
      id: string; tenant_id: string; email: string; password_hash: string | null;
      first_name: string; last_name: string; role: string; email_verified: boolean;
    }>(
      `SELECT id, tenant_id, email, password_hash, first_name, last_name, role, email_verified
       FROM users WHERE email = $1 LIMIT 1`,
      [email], { allowNoTenant: true }
    );
    return result.rows[0] ?? null;
  }

  async findUserById(userId: string) {
    const result = await db.query<{
      id: string; tenant_id: string; email: string;
      first_name: string; last_name: string; role: string;
    }>(
      `SELECT id, tenant_id, email, first_name, last_name, role
       FROM users WHERE id = $1 LIMIT 1`,
      [userId], { allowNoTenant: true }
    );
    return result.rows[0] ?? null;
  }

  async findRefreshToken(tokenHash: string) {
    const result = await db.query<{
      id: string; user_id: string; tenant_id: string;
      revoked: boolean; expires_at: string;
    }>(
      `SELECT id, user_id, tenant_id, revoked, expires_at
       FROM refresh_tokens WHERE token_hash = $1 LIMIT 1`,
      [tokenHash], { allowNoTenant: true }
    );
    return result.rows[0] ?? null;
  }

  async revokeRefreshToken(tokenHash: string): Promise<void> {
    await db.query(
      `UPDATE refresh_tokens SET revoked = true WHERE token_hash = $1`,
      [tokenHash], { allowNoTenant: true }
    );
  }

  async findPasswordResetToken(tokenHash: string) {
    const result = await db.query<{
      id: string; user_id: string; used: boolean; expires_at: string;
    }>(
      `SELECT id, user_id, used, expires_at
       FROM password_reset_tokens WHERE token_hash = $1 LIMIT 1`,
      [tokenHash], { allowNoTenant: true }
    );
    return result.rows[0] ?? null;
  }

  async getTenantPlanSlug(tenantId: string): Promise<string> {
    const result = await db.query<{ plan_slug: string }>(
      `SELECT p.slug AS plan_slug
       FROM tenant_subscriptions ts
       JOIN plans p ON p.id = ts.plan_id
       WHERE ts.tenant_id = $1 AND ts.status IN ('active','trialing')
       ORDER BY ts.created_at DESC LIMIT 1`,
      [tenantId], { allowNoTenant: true }
    );
    return result.rows[0]?.plan_slug ?? 'starter';
  }
}
