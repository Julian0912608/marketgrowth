// ============================================================
// src/modules/feature-flags/service/feature-flags.service.ts
//
// Country-aware feature flag service.
//
// Resolutie regel voor (key, countryCode):
//   1. Als er een row bestaat voor (key, countryCode)
//      gebruik die enabled.
//   2. Anders: gebruik global row (country_code = NULL).
//   3. Geen match: false (gesloten by default).
//
// Cache: 5 min TTL per country (Architecture Plan v1.0 sectie 5).
// Invalidatie via invalidateAll() na admin updates.
// ============================================================

import { cache } from '../../../infrastructure/cache/redis';
import { logger } from '../../../shared/logging/logger';
import { FeatureFlagsRepository } from '../repository/feature-flags.repository';
import {
  FeatureFlagKey,
  FeatureFlagsMap,
  FeatureFlagRow,
} from '../types/feature-flags.types';

const CACHE_TTL_SECONDS = 300; // 5 min
const CACHE_KEY_PREFIX  = 'feature_flags:resolved';

export class FeatureFlagsService {
  constructor(
    private readonly repo: FeatureFlagsRepository = new FeatureFlagsRepository(),
  ) {}

  // Resolve alle flags voor 1 country in 1 map.
  // countryCode null/leeg betekent: alleen global defaults.
  async getFlagsForCountry(countryCode: string | null): Promise<FeatureFlagsMap> {
    const normalisedCountry = this.normaliseCountry(countryCode);
    const cacheKey = this.buildCacheKey(normalisedCountry);

    const cached = await cache.getJson<FeatureFlagsMap>(cacheKey);
    if (cached) {
      return cached;
    }

    const rows  = await this.repo.getAllRows();
    const flags = this.resolveFlags(rows, normalisedCountry);

    await cache.setJson(cacheKey, flags, CACHE_TTL_SECONDS);
    return flags;
  }

  // Snelle check voor 1 specifieke key. Hergebruikt de map cache.
  async isEnabled(featureKey: FeatureFlagKey, countryCode: string | null): Promise<boolean> {
    const flags = await this.getFlagsForCountry(countryCode);
    return flags[featureKey] === true;
  }

  // Invalideer alle gecachte flag maps. Aanroepen na admin update.
  async invalidateAll(): Promise<void> {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { redis } = require('../../../infrastructure/cache/redis');
      const r = redis as any;
      const pattern = `${CACHE_KEY_PREFIX}:*`;
      const keys = await r.keys(pattern);
      if (keys.length > 0) {
        await r.del(...keys);
        logger.info('feature_flags.cache_invalidated', { keysDeleted: keys.length });
      }
    } catch (err) {
      logger.warn('feature_flags.invalidate_failed', {
        error: (err as Error).message,
      });
    }
  }

  // ---- Private helpers ----

  private normaliseCountry(input: string | null): string | null {
    if (!input) return null;
    const trimmed = input.trim().toUpperCase();
    if (!/^[A-Z]{2}$/.test(trimmed)) return null;
    return trimmed;
  }

  private buildCacheKey(countryCode: string | null): string {
    return countryCode
      ? `${CACHE_KEY_PREFIX}:${countryCode}`
      : `${CACHE_KEY_PREFIX}:_global`;
  }

  // Resolveer rows naar 1 plain map: { feature_key: boolean }
  private resolveFlags(rows: FeatureFlagRow[], countryCode: string | null): FeatureFlagsMap {
    const result: FeatureFlagsMap = {};

    // Stap 1: bouw global map (country_code IS NULL)
    for (const row of rows) {
      if (row.country_code === null) {
        result[row.feature_key] = row.enabled;
      }
    }

    // Stap 2: overlay country-specifieke overrides
    if (countryCode) {
      for (const row of rows) {
        if (row.country_code === countryCode) {
          result[row.feature_key] = row.enabled;
        }
      }
    }

    return result;
  }
}

// Singleton voor consumers die geen DI nodig hebben
export const featureFlagsService = new FeatureFlagsService();
