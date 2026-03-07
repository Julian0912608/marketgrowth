// src/infrastructure/redis/client.ts
// Redis is OPTIONEEL — server draait altijd, ook zonder Redis.

import Redis from 'ioredis';
import { logger } from '../../shared/logging/logger';

let redisClient: Redis | null = null;
let _redisReady = false;

export function getRedis(): Redis {
  if (!redisClient) {
    redisClient = createRedisClient();
  }
  return redisClient;
}

function createRedisClient(): Redis {
  const url = process.env.REDIS_URL;

  if (!url) {
    logger.warn('redis.disabled', { reason: 'REDIS_URL niet ingesteld' });
    return new Redis({ lazyConnect: true, enableOfflineQueue: false, maxRetriesPerRequest: 0 });
  }

  let hostname = 'localhost';
  try { hostname = new URL(url).hostname; } catch {}

  const isTLS = url.startsWith('rediss://');

  const client = new Redis(url, {
    tls: isTLS ? { rejectUnauthorized: false, servername: hostname } : undefined,
    connectTimeout:       15000,
    commandTimeout:       10000,
    retryStrategy: (times) => {
      if (times > 5) { logger.error('redis.giving_up'); return null; }
      return Math.min(times * 1000, 5000);
    },
    maxRetriesPerRequest: null,
    enableOfflineQueue:   true,
    lazyConnect:          false,
    keepAlive:            5000,
    family:               4,
  });

  client.on('connect',      () => { _redisReady = true;  logger.info('redis.connected'); });
  client.on('ready',        () => { _redisReady = true;  logger.info('redis.ready'); });
  client.on('error',   (e) => logger.error('redis.error', { message: e.message, code: (e as any).code }));
  client.on('close',        () => { _redisReady = false; logger.warn('redis.closed'); });
  client.on('reconnecting', (ms: number) => logger.info('redis.reconnecting', { ms }));

  return client;
}

export async function redisHealthCheck(): Promise<{ ok: boolean; latencyMs?: number; error?: string }> {
  if (!_redisReady) return { ok: false, error: 'niet verbonden' };
  const start = Date.now();
  try {
    await getRedis().ping();
    return { ok: true, latencyMs: Date.now() - start };
  } catch (err: any) {
    return { ok: false, error: err.message };
  }
}

export { _redisReady as redisReady };
