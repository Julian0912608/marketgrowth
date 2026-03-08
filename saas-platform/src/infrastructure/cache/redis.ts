import Redis from 'ioredis';
import { logger } from '../../shared/logging/logger';

let _redis: Redis | null = null;

function getRedis(): Redis {
  if (_redis) return _redis;

  const url = process.env.REDIS_URL ?? 'redis://localhost:6379';

  _redis = new Redis(url, {
    maxRetriesPerRequest: null,
    lazyConnect:          true,
    retryStrategy:        (times) => {
      if (times > 10) return null; // stop retrying na 10x
      return Math.min(times * 200, 5000);
    },
    enableOfflineQueue: true,
  });

  _redis.on('error', (err) => {
    // Log maar gooi NOOIT een uncaught exception — anders crasht het proces
    logger.error('redis.error', { error: err.message });
  });

  _redis.on('connect', () => {
    logger.info('redis.connected', {
      url: url.replace(/:\/\/[^@]+@/, '://***@'),
    });
  });

  // Verbinding initiëren (niet-blokkerend)
  _redis.connect().catch((err) => {
    logger.warn('redis.connect.failed', { error: err.message });
  });

  return _redis;
}

// Proxy zodat imports gewoon `redis.get(...)` kunnen doen
export const redis = new Proxy({} as Redis, {
  get(_target, prop) {
    return (getRedis() as any)[prop];
  },
});

const cache = {
  async get(key: string): Promise<string | null> {
    try {
      return await getRedis().get(key);
    } catch (err) {
      logger.warn('cache.get.error', { key, error: (err as Error).message });
      return null;
    }
  },

  async set(key: string, value: string, ttlSeconds?: number): Promise<void> {
    try {
      if (ttlSeconds) {
        await getRedis().set(key, value, 'EX', ttlSeconds);
      } else {
        await getRedis().set(key, value);
      }
    } catch (err) {
      logger.warn('cache.set.error', { key, error: (err as Error).message });
    }
  },

  async del(key: string): Promise<void> {
    try {
      await getRedis().del(key);
    } catch (err) {
      logger.warn('cache.del.error', { key, error: (err as Error).message });
    }
  },

  key(tenantId: string, ...parts: string[]): string {
    return `t:${tenantId}:${parts.join(':')}`;
  },

  async getJson<T>(key: string): Promise<T | null> {
    const raw = await this.get(key);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return null;
    }
  },

  async setJson<T>(key: string, value: T, ttlSeconds?: number): Promise<void> {
    await this.set(key, JSON.stringify(value), ttlSeconds);
  },

  async invalidateTenant(tenantId: string): Promise<void> {
    try {
      const pattern = `t:${tenantId}:*`;
      const keys = await getRedis().keys(pattern);
      if (keys.length > 0) {
        await getRedis().del(...keys);
        logger.info('cache.tenant_invalidated', { tenantId, keysDeleted: keys.length });
      }
    } catch (err) {
      logger.warn('cache.invalidate_tenant.error', {
        tenantId,
        error: (err as Error).message,
      });
    }
  },
};

export { cache };
