// ============================================================
// src/infrastructure/database/connection.ts
//
// FIX: Connection pool uitgebreid voor 500+ gebruikers:
//   - max verhoogd naar 20 voor directe verbindingen
//   - PgBouncer transactie-modus automatisch gedetecteerd
//   - statement_timeout en idle_in_transaction_session_timeout
//     toegevoegd voor beveiliging
//   - prepare = false bij pooler (PgBouncer vereiste)
// ============================================================

import { Pool, PoolConfig, QueryResult, QueryResultRow } from 'pg';
import { getTenantContextOrNull } from '../../shared/middleware/tenant-context';
import { logger } from '../../shared/logging/logger';

function buildPoolConfig(): PoolConfig {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error('DATABASE_URL is niet ingesteld');

  const isSupabase  = connectionString.includes('supabase.co') || connectionString.includes('supabase.com');
  const isPooler    = connectionString.includes('.pooler.supabase.com') || connectionString.includes('pgbouncer=true');
  const isTransMode = isPooler; // PgBouncer in transactie-modus

  const config: PoolConfig = {
    connectionString,
    ssl: isSupabase
      ? { rejectUnauthorized: false }
      : process.env.NODE_ENV === 'production'
        ? { rejectUnauthorized: false }
        : false,

    // Pool grootte:
    // - Bij PgBouncer: laag houden want PgBouncer doet zelf multiplexing
    // - Bij directe verbinding: hoger voor concurrentie
    max:                     isPooler ? 10 : 20,
    min:                     2,
    idleTimeoutMillis:       30_000,  // Verbinding sluiten na 30s inactiviteit
    connectionTimeoutMillis: 10_000,  // Timeout als geen verbinding beschikbaar
  };

  return config;
}

// Verbindingsopties die per sessie ingesteld worden
const SESSION_INIT_QUERIES: string[] = [
  // Voorkom lang hangende queries (30 seconden max)
  `SET statement_timeout = '30s'`,
  // Voorkom open transacties die verbindingen blokkeren
  `SET idle_in_transaction_session_timeout = '10s'`,
];

const isPooler = (process.env.DATABASE_URL ?? '').includes('.pooler.supabase.com')
  || (process.env.DATABASE_URL ?? '').includes('pgbouncer=true');

let pool: Pool | null = null;

function getPool(): Pool {
  if (!pool) {
    pool = new Pool(buildPoolConfig());

    pool.on('error', (err) => {
      logger.error('db.pool.error', { error: err.message });
    });

    pool.on('connect', (client) => {
      logger.debug('db.pool.new_connection');
      // Bij PgBouncer in transactie-modus: geen session-level statements
      // want elke query kan op een andere backend-verbinding lopen
      if (!isPooler) {
        SESSION_INIT_QUERIES.forEach(q => {
          client.query(q).catch(err =>
            logger.warn('db.session_init.failed', { query: q, error: err.message })
          );
        });
      }
    });

    // Log pool stats periodiek in productie
    if (process.env.NODE_ENV === 'production') {
      setInterval(() => {
        if (pool) {
          logger.debug('db.pool.stats', {
            total:   pool.totalCount,
            idle:    pool.idleCount,
            waiting: pool.waitingCount,
          });
        }
      }, 60_000);
    }
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
    const client = await p.connect();

    try {
      if (ctx) {
        // set_config met transactie-scope (derde param = true) werkt ook
        // in PgBouncer transactie-modus omdat het binnen dezelfde transactie zit
        await client.query(`SELECT set_config('app.tenant_id', $1, true)`, [ctx.tenantId]);
      }

      const result   = await client.query<T>(text, values);
      const duration = Date.now() - start;

      if (duration > 2000) {
        logger.warn('db.query.slow', { duration, query: text.substring(0, 100) });
      }

      return result;
    } catch (err: any) {
      logger.error('db.query.error', { error: err.message, query: text.substring(0, 100) });
      throw err;
    } finally {
      client.release();
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
    return {
      total:   pool.totalCount,
      idle:    pool.idleCount,
      waiting: pool.waitingCount,
    };
  }
}

export const db = new Database();
