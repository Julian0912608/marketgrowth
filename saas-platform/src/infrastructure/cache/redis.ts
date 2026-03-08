// ============================================================
// src/infrastructure/cache/redis.ts
// ============================================================

import Redis from 'ioredis';
import { logger } from '../../shared/logging/logger';

function createRedisClient(): Redis {
  const url = process.env.REDIS_URL ?? '';

  if (!url) {
    logger.warn('redis.no_url', { message: 'REDIS_URL niet ingesteld, gebruik localhost' });
    return new Redis({ host: 'localhost', port: 6379, lazyConnect: true, maxRetriesPerRequest: 1 });
  }

  // Parse de URL handmatig voor maximale compatibiliteit met Upstash
  const parsed = new URL(url);
  const isTls  = parsed.protocol === 'rediss:';

  logger.info('redis.init', { host: parsed.hostname, port: parsed.port, tls: isTls });

  return new Redis({
    host:     parsed.hostname,
    port:     parseInt(parsed.port || '6379', 10),
    password: parsed.password ? decodeURIComponent(parsed.password) : undefined,
    username: parsed.username ? decodeURIComponent(parsed.username) : undefined,
    tls:      isTls ? { rejectUnauthorized: false } : undefined,
    lazyConnect:          true,
    maxRetriesPerRequest: 3,
    retryStrategy: (times) => Math.min(times * 200, 5000),
  });
}

const redis = createRedisClient();

redis.on('error',   (err) => logger.error('redis.error',   { error: err.message }));
redis.on('connect', ()    => logger.info('redis.connected'));

const cache = {
  async get(key: string): Promise<string | null> {
    try { return await redis.get(key); }
    catch (err) { logger.warn('cache.get.error', { key, error: (err as Error).message }); return null; }
  },

  async set(key: string, value: string, ttlSeconds?: number): Promise<void> {
    try {
      if (ttlSeconds) await redis.set(key, value, 'EX', ttlSeconds);
      else            await redis.set(key, value);
    } catch (err) { logger.warn('cache.set.error', { key, error: (err as Error).message }); }
  },

  async del(key: string): Promise<void> {
    try { await redis.del(key); }
    catch (err) { logger.warn('cache.del.error', { key, error: (err as Error).message }); }
  },

  key(tenantId: string, ...parts: string[]): string {
    return `t:${tenantId}:${parts.join(':')}`;
  },

  async getJson<T>(key: string): Promise<T | null> {
    const raw = await this.get(key);
    if (!raw) return null;
    try { return JSON.parse(raw) as T; } catch { return null; }
  },

  async setJson<T>(key: string, value: T, ttlSeconds?: number): Promise<void> {
    await this.set(key, JSON.stringify(value), ttlSeconds);
  },

  async invalidateTenant(tenantId: string): Promise<void> {
    try {
      const keys = await redis.keys(`t:${tenantId}:*`);
      if (keys.length > 0) {
        await redis.del(...keys);
        logger.info('cache.tenant_invalidated', { tenantId, keysDeleted: keys.length });
      }
    } catch (err) { logger.warn('cache.invalidate_tenant.error', { tenantId, error: (err as Error).message }); }
  },
};

export { cache, redis };
