// ============================================================
// src/infrastructure/cache/redis.ts
//
// Redis client with tenant-scoped helper methods.
// Cache keys are ALWAYS prefixed with tenantId to prevent
// cross-tenant cache pollution.
// ============================================================

import Redis from 'ioredis';
import { logger } from '../../shared/logging/logger';

const redis = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379', {
  maxRetriesPerRequest: 3,
  lazyConnect: true,
  retryStrategy: (times) => Math.min(times * 50, 2000),
});

redis.on('error', (err) => {
  logger.error('redis.error', { error: err.message });
});

redis.on('connect', () => {
  logger.info('redis.connected');
});

// ─── Tenant-scoped cache helpers ─────────────────────────────

const cache = {
  // Get a value. Returns null if not found or Redis is unavailable.
  async get(key: string): Promise<string | null> {
    try {
      return await redis.get(key);
    } catch (err) {
      logger.warn('cache.get.error', { key, error: (err as Error).message });
      return null;   // degrade gracefully — never throw on cache miss
    }
  },

  // Set a value with optional TTL in seconds
  async set(key: string, value: string, ttlSeconds?: number): Promise<void> {
    try {
      if (ttlSeconds) {
        await redis.set(key, value, 'EX', ttlSeconds);
      } else {
        await redis.set(key, value);
      }
    } catch (err) {
      logger.warn('cache.set.error', { key, error: (err as Error).message });
    }
  },

  // Delete a key
  async del(key: string): Promise<void> {
    try {
      await redis.del(key);
    } catch (err) {
      logger.warn('cache.del.error', { key, error: (err as Error).message });
    }
  },

  // Build a tenant-scoped cache key
  // Usage: cache.key(tenantId, 'dashboard', 'sales', '2024-01')
  key(tenantId: string, ...parts: string[]): string {
    return `t:${tenantId}:${parts.join(':')}`;
  },

  // Get a JSON value
  async getJson<T>(key: string): Promise<T | null> {
    const raw = await this.get(key);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return null;
    }
  },

  // Set a JSON value
  async setJson<T>(key: string, value: T, ttlSeconds?: number): Promise<void> {
    await this.set(key, JSON.stringify(value), ttlSeconds);
  },

  // Invalidate all cache keys for a tenant
  // Use sparingly — only on major state changes like plan changes
  async invalidateTenant(tenantId: string): Promise<void> {
    try {
      const pattern = `t:${tenantId}:*`;
      const keys = await redis.keys(pattern);
      if (keys.length > 0) {
        await redis.del(...keys);
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

export { cache, redis };
