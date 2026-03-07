// ============================================================
// src/infrastructure/redis/client.ts
//
// Robuuste Redis verbinding voor Upstash via ioredis.
//
// KRITIEKE FIXES:
// 1. Crasht de server NIET bij connectie fout
// 2. Graceful degradation — als Redis niet werkt, werkt auth nog
// 3. TLS correct ingesteld voor Upstash (rediss://)
// 4. Retry met exponential backoff
// 5. BullMQ-compatibel
// ============================================================

import Redis, { RedisOptions } from 'ioredis';
import { logger } from '../../shared/logging/logger';

let redisClient: Redis | null = null;
let redisReady = false;

function buildRedisOptions(): RedisOptions {
  const url = process.env.REDIS_URL;
  if (!url) {
    logger.warn('redis.no_url', { message: 'REDIS_URL niet ingesteld — Redis functies uitgeschakeld' });
    return {};
  }

  // Upstash gebruikt rediss:// (TLS) — ioredis heeft speciale config nodig
  const isTLS = url.startsWith('rediss://');

  return {
    // Retry strategie — max 10 pogingen met exponential backoff
    retryStrategy: (times: number) => {
      if (times > 10) {
        logger.error('redis.max_retries', { message: 'Redis niet bereikbaar na 10 pogingen' });
        return null; // Stop met retrying
      }
      const delay = Math.min(times * 500, 5000);
      logger.warn('redis.retry', { attempt: times, delayMs: delay });
      return delay;
    },

    // TLS voor Upstash
    tls: isTLS ? { rejectUnauthorized: false } : undefined,

    // Connectie timeout
    connectTimeout: 10000,
    commandTimeout: 5000,

    // Maximaal 3 reconnect pogingen bij verlies verbinding
    maxRetriesPerRequest: 3,

    // Geen abrupte crash bij connectie fout
    lazyConnect: true,

    // Logging
    enableOfflineQueue: true,
  };
}

export function createRedisClient(): Redis {
  const url = process.env.REDIS_URL;

  if (!url) {
    // Return een nep-client die nooit verbinding maakt
    // zodat de server niet crasht
    const fakeClient = new Redis({ lazyConnect: true, enableOfflineQueue: false });
    return fakeClient;
  }

  const options = buildRedisOptions();
  const client = new Redis(url, options);

  client.on('connect', () => {
    redisReady = true;
    logger.info('redis.connected');
  });

  client.on('ready', () => {
    redisReady = true;
    logger.info('redis.ready');
  });

  client.on('error', (err) => {
    // Niet crashen — alleen loggen
    logger.error('redis.error', { error: err.message, code: (err as any).code });
  });

  client.on('close', () => {
    redisReady = false;
    logger.warn('redis.disconnected');
  });

  client.on('reconnecting', (delay: number) => {
    logger.info('redis.reconnecting', { delayMs: delay });
  });

  // Verbinding starten (lazyConnect = false impliciet via connect())
  client.connect().catch(err => {
    logger.error('redis.initial_connect.failed', {
      error: err.message,
      hint: 'Controleer REDIS_URL in Railway — gebruik rediss:// URL van Upstash',
    });
  });

  return client;
}

// Singleton
export function getRedis(): Redis {
  if (!redisClient) {
    redisClient = createRedisClient();
  }
  return redisClient;
}

// Health check
export async function redisHealthCheck(): Promise<{ ok: boolean; latencyMs?: number; error?: string }> {
  const start = Date.now();
  try {
    const client = getRedis();
    await client.ping();
    return { ok: true, latencyMs: Date.now() - start };
  } catch (err: any) {
    return { ok: false, error: err.message };
  }
}

export { redisReady };
