// ============================================================
// src/infrastructure/cache/redis.ts  (FIXED)
//
// FIX: Redis client wordt nu lazy aangemaakt — pas bij het eerste
// gebruik wordt de connectie opgezet. Hierdoor wordt REDIS_URL
// gelezen op het moment dat de server al draait en env vars
// beschikbaar zijn, niet tijdens module-load.
// ============================================================

import Redis from 'ioredis';
import { logger } from '../../shared/logging/logger';

let _redis: Redis | null = null;

function getRedis(): Redis {
  if (_redis) return _redis;

  const url = process.env.REDIS_URL;

  if (!url) {
    logger.warn('redis.no_url', { message: 'REDIS_URL niet ingesteld, Redis wordt overgeslagen' });
  }

  _redis = new Redis(url ?? 'redis://localhost:6379', {
    maxRetriesPerRequest: 3,
    lazyConnect:          false,
    retryStrategy:        (times) => Math.min(times * 100, 3000),
    // Upstash vereist TLS — wordt automatisch afgehandeld via rediss://
    enableOfflineQueue:   false,
  });

  _redis.on('error', (err) => {
    logger.error('redis.error', { error: err.message, url: url ? url.replace(/:\/\/[^@]+@/, '://***@') : 'none' });
  });

  _redis.on('connect', () => {
    logger.info('redis.connected', { url: url ? url.replace(/:\/\/[^@]+@/, '://***@') : 'none' });
  });

  return _redis;
}

// Exporteer als proxy zodat alle imports gewoon `redis.get(...)` kunnen doen
// maar de client pas aangemaakt wordt bij eerste gebruik
export const redis = new Proxy({} as Redis, {
  get(_target, prop) {
    return (getRedis() as any)[prop];
  },
});

// ─── Tenant-scoped cache helpers ─────────────────────────────

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
