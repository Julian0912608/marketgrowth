// ============================================================
// src/infrastructure/database/connection.ts
// ============================================================

import { Pool, PoolConfig, QueryResult, QueryResultRow } from 'pg';
import { getTenantContextOrNull } from '../../shared/middleware/tenant-context';
import { logger } from '../../shared/logging/logger';

function buildPoolConfig(): PoolConfig {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error('DATABASE_URL is niet ingesteld');

  const isSupabase = connectionString.includes('supabase.co') || connectionString.includes('supabase.com');
  const isPooler   = connectionString.includes('.pooler.supabase.com');

  return {
    connectionString,
    ssl: isSupabase ? { rejectUnauthorized: false }
      : process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false }
      : false,
    max: isPooler ? 10 : 5,
    min: 1,
    idleTimeoutMillis:       30_000,
    connectionTimeoutMillis: 10_000,
  };
}

let pool: Pool | null = null;

function getPool(): Pool {
  if (!pool) {
    pool = new Pool(buildPoolConfig());
    pool.on('error', (err) => logger.error('db.pool.error', { error: err.message }));
    pool.on('connect', () => logger.info('db.pool.connected'));
  }
  return pool;
}

interface QueryOptions {
  allowNoTenant?: boolean;
}

class Database {
  async query<T extends QueryResultRow = any>(
    text: string,
    values?: any[],
    options: QueryOptions = {}
  ): Promise<QueryResult<T>> {
    const p   = getPool();
    const ctx = getTenantContextOrNull();

    if (!ctx && !options.allowNoTenant) {
      throw new Error(`Query zonder tenant context: ${text.substring(0, 80)}`);
    }

    const start = Date.now();
    try {
      if (ctx) {
        await p.query(`SELECT set_config('app.tenant_id', $1, true)`, [ctx.tenantId]);
      }
      const result = await p.query<T>(text, values);
      const duration = Date.now() - start;
      if (duration > 2000) logger.warn('db.query.slow', { duration, query: text.substring(0, 100) });
      return result;
    } catch (err: any) {
      logger.error('db.query.error', { error: err.message, query: text.substring(0, 100) });
      throw err;
    }
  }

  async healthCheck(): Promise<{ ok: boolean; latencyMs?: number; error?: string }> {
    const start = Date.now();
    try {
      await getPool().query('SELECT 1');
      return { ok: true, latencyMs: Date.now() - start };
    } catch (err: any) {
      return { ok: false, error: err.message };
    }
  }

  stats() {
    if (!pool) return { total: 0, idle: 0, waiting: 0 };
    return { total: pool.totalCount, idle: pool.idleCount, waiting: pool.waitingCount };
  }
}

export const db = new Database();
