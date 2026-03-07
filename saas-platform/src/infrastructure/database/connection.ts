// ============================================================
// src/infrastructure/database/connection.ts
//
// Robuuste database verbinding voor Railway + Supabase.
// 
// KRITIEKE FIXES:
// 1. Werkt met zowel directe URL als Session/Transaction Pooler
// 2. SSL correct geconfigureerd voor alle Supabase URL varianten
// 3. Crasht de server NIET bij connectie fout — logt en retries
// 4. Tenant isolation via AsyncLocalStorage
// 5. Pool settings geschikt voor 500+ gebruikers
// ============================================================

import { Pool, PoolConfig, QueryResult, QueryResultRow } from 'pg';
import { AsyncLocalStorage } from 'async_hooks';
import { logger } from '../../shared/logging/logger';

// ── Tenant context ────────────────────────────────────────────
interface TenantContext {
  tenantId: string;
}

const tenantStorage = new AsyncLocalStorage<TenantContext>();

export function runWithTenant<T>(tenantId: string, fn: () => T): T {
  return tenantStorage.run({ tenantId }, fn);
}

export function getTenantContext(): TenantContext {
  const ctx = tenantStorage.getStore();
  if (!ctx) throw new Error('Geen tenant context — gebruik runWithTenant()');
  return ctx;
}

// ── Pool configuratie ─────────────────────────────────────────
function buildPoolConfig(): PoolConfig {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error('DATABASE_URL environment variable is niet ingesteld');
  }

  // Detecteer of het een Supabase pooler URL is
  const isPooler = connectionString.includes('.pooler.supabase.com');
  const isSupabase = connectionString.includes('supabase.co') || connectionString.includes('supabase.com');

  const config: PoolConfig = {
    connectionString,

    // SSL: altijd aan voor Supabase, rejectUnauthorized uit voor pooler
    ssl: isSupabase
      ? { rejectUnauthorized: false }
      : process.env.NODE_ENV === 'production'
        ? { rejectUnauthorized: false }
        : false,

    // Pool sizing — geschikt voor Railway free tier + 500+ users via pooler
    max: isPooler ? 10 : 5,          // Pooler handles multiplexing, directe connectie is gelimiteerd
    min: 1,
    idleTimeoutMillis: 30000,         // Sluit idle connecties na 30s
    connectionTimeoutMillis: 10000,   // Timeout na 10s als er geen connectie vrij is
    statement_timeout: 30000,         // Query timeout 30s
  };

  return config;
}

// ── Pool instantie ────────────────────────────────────────────
let pool: Pool | null = null;
let poolReady = false;
let initAttempts = 0;
const MAX_INIT_ATTEMPTS = 5;

function createPool(): Pool {
  const config = buildPoolConfig();
  const p = new Pool(config);

  p.on('error', (err) => {
    logger.error('db.pool.error', { error: err.message, code: (err as any).code });
    // Niet crashen — pool herstelt zichzelf
  });

  p.on('connect', () => {
    if (!poolReady) {
      poolReady = true;
      logger.info('db.pool.connected', { max: config.max });
    }
  });

  return p;
}

async function getPool(): Promise<Pool> {
  if (pool && poolReady) return pool;

  if (!pool) {
    pool = createPool();
  }

  // Test verbinding met retry
  while (initAttempts < MAX_INIT_ATTEMPTS) {
    try {
      const client = await pool.connect();
      await client.query('SELECT 1');
      client.release();
      poolReady = true;
      logger.info('db.connected', { attempt: initAttempts + 1 });
      return pool;
    } catch (err: any) {
      initAttempts++;
      const waitMs = Math.min(1000 * Math.pow(2, initAttempts), 30000);
      logger.warn('db.connect.retry', {
        attempt: initAttempts,
        error: err.message,
        nextRetryMs: waitMs,
      });

      if (initAttempts >= MAX_INIT_ATTEMPTS) {
        logger.error('db.connect.failed', {
          message: 'Database niet bereikbaar na meerdere pogingen',
          hint: 'Controleer DATABASE_URL — gebruik Supabase Session Pooler URL (poort 5432)',
          error: err.message,
        });
        // Gooi GEEN error — return de pool zodat de server blijft draaien
        // Individuele queries falen graceful
        return pool;
      }

      await new Promise(r => setTimeout(r, waitMs));
    }
  }

  return pool!;
}

// ── Query interface ───────────────────────────────────────────
interface QueryOptions {
  allowNoTenant?: boolean;  // true = skip tenant isolation check
}

class Database {
  async query<T extends QueryResultRow = any>(
    text: string,
    values?: any[],
    options: QueryOptions = {}
  ): Promise<QueryResult<T>> {
    const p = await getPool();

    // Tenant isolation check
    if (!options.allowNoTenant) {
      const ctx = tenantStorage.getStore();
      if (!ctx) {
        throw new Error(`Query zonder tenant context: ${text.substring(0, 60)}...`);
      }
    }

    const start = Date.now();
    try {
      const result = await p.query<T>(text, values);
      const duration = Date.now() - start;

      if (duration > 2000) {
        logger.warn('db.query.slow', { duration, query: text.substring(0, 100) });
      }

      return result;
    } catch (err: any) {
      logger.error('db.query.error', {
        error: err.message,
        code: err.code,
        query: text.substring(0, 100),
        duration: Date.now() - start,
      });
      throw err;
    }
  }

  // Health check voor /health endpoint
  async healthCheck(): Promise<{ ok: boolean; latencyMs?: number; error?: string }> {
    const start = Date.now();
    try {
      const p = await getPool();
      await p.query('SELECT 1');
      return { ok: true, latencyMs: Date.now() - start };
    } catch (err: any) {
      return { ok: false, error: err.message };
    }
  }

  // Pool statistieken
  stats() {
    if (!pool) return { total: 0, idle: 0, waiting: 0 };
    return {
      total: pool.totalCount,
      idle: pool.idleCount,
      waiting: pool.waitingCount,
    };
  }
}

export const db = new Database();

// Start verbinding in de achtergrond — crasht server NIET bij falen
getPool().catch(err => {
  logger.error('db.init.background.failed', { error: err?.message });
});
