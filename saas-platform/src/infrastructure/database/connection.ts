// ============================================================
// src/infrastructure/database/connection.ts
//
// PostgreSQL connection pool. The query() wrapper enforces that
// every query runs within a tenant context — preventing accidental
// cross-tenant data access.
// ============================================================

import { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg';
import { getTenantContextOrNull } from '../../shared/middleware/tenant-context';
import { logger } from '../../shared/logging/logger';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 20,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
});

pool.on('error', (err) => {
  logger.error('db.pool.error', { error: err.message });
});

async function query<T extends QueryResultRow = QueryResultRow>(
  sql: string,
  params?: unknown[],
  options?: { allowNoTenant?: boolean }
): Promise<QueryResult<T>> {
  const ctx = getTenantContextOrNull();

  if (!ctx && !options?.allowNoTenant) {
    throw new Error(
      `[DB] Query attempted without tenant context.\n` +
      `SQL: ${sql.slice(0, 120)}\n` +
      `If this is intentional (migration/admin), pass { allowNoTenant: true }`
    );
  }

  const start = Date.now();

  try {
    if (ctx) {
      await pool.query(`SELECT set_config('app.tenant_id', $1, true)`, [ctx.tenantId]);
    }

    const result = await pool.query<T>(sql, params);

    const duration = Date.now() - start;
    if (duration > 1000) {
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

async function transaction<T>(
  fn: (client: PoolClient) => Promise<T>
): Promise<T> {
  const ctx = getTenantContextOrNull();
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

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
