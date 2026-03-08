// ============================================================
// src/infrastructure/cache/redis.ts
// ============================================================

import Redis from 'ioredis';
import { logger } from '../../shared/logging/logger';

const redisUrl = process.env.REDIS_URL ?? 'redis://localhost:6379';

// Upstash en andere TLS Redis providers gebruiken rediss:// 
// ioredis heeft extra TLS opties nodig voor zelfgetekende certificaten
const redis = new Redis(redisUrl, {
  maxRetriesPerRequest: 3,
  lazyConnect:          true,
  retryStrategy: (times) => Math.min(times * 100, 3000),
  tls: redisUrl.startsWith('rediss://') ? { rejectUnauthorized: false } : undefined,
});

redis.on('error',   (err) => logger.error('redis.error',     { error: err.message }));
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
