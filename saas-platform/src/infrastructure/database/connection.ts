// ============================================================
// src/infrastructure/database/connection.ts
//
// PostgreSQL connection pool. The query() wrapper enforces that
// every query runs within a tenant context — preventing accidental
// cross-tenant data access.
// ============================================================

import { Pool, PoolClient, QueryResult } from 'pg';
import { getTenantContextOrNull } from '../../shared/middleware/tenant-context';
import { logger } from '../../shared/logging/logger';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 20,                        // max connections in pool
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
});

pool.on('error', (err) => {
  logger.error('db.pool.error', { error: err.message });
});

// ─── Safe Query Wrapper ──────────────────────────────────────
// Automatically sets app.tenant_id before every query so RLS
// policies are always enforced. Throws if no tenant context
// is active and allowNoTenant is not explicitly set to true.
async function query<T = unknown>(
  sql: string,
  params?: unknown[],
  options?: { allowNoTenant?: boolean }
): Promise<QueryResult<T>> {
  const ctx = getTenantContextOrNull();

  // Guard: prevent queries without tenant context unless explicitly allowed
  // (allowed for: migrations, admin operations, auth queries)
  if (!ctx && !options?.allowNoTenant) {
    throw new Error(
      `[DB] Query attempted without tenant context.\n` +
      `SQL: ${sql.slice(0, 120)}\n` +
      `If this is intentional (migration/admin), pass { allowNoTenant: true }`
    );
  }

  const start = Date.now();

  try {
    // Set tenant context for RLS if we have one
    if (ctx) {
      await pool.query(`SELECT set_config('app.tenant_id', $1, true)`, [ctx.tenantId]);
    }

    const result = await pool.query<T>(sql, params);

    const duration = Date.now() - start;
    if (duration > 1000) {
      // Log slow queries for performance monitoring
      logger.warn('db.query.slow', {
        durationMs: duration,
        sql: sql.slice(0, 200),
      });
    }

    return result;
  } catch (err) {
    logger.error('db.query.error', {
      error: (err as Error).message,
      sql: sql.slice(0, 200),
    });
    throw err;
  }
}

// ─── Transaction Helper ──────────────────────────────────────
// Runs multiple queries in a single transaction.
// Usage: await transaction(async (client) => { ... })
async function transaction<T>(
  fn: (client: PoolClient) => Promise<T>
): Promise<T> {
  const ctx = getTenantContextOrNull();
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // Set tenant context for all queries in this transaction
    if (ctx) {
      await client.query(`SELECT set_config('app.tenant_id', $1, true)`, [ctx.tenantId]);
    }

    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export const db = { query, transaction, pool };
