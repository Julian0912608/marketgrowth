// ============================================================
// src/shared/middleware/rate-limit.ts
//
// Rate limiting voor gevoelige routes (login, register).
// Voorkomt brute-force aanvallen op wachtwoorden.
// Gebruikt Redis als teller zodat het werkt over meerdere servers.
// ============================================================

import { Request, Response, NextFunction } from 'express';
import { redis } from '../../infrastructure/cache/redis';
import { logger } from '../logging/logger';

interface RateLimitOptions {
  windowSeconds: number;  // tijdvenster
  maxRequests:   number;  // max verzoeken in het venster
  keyPrefix:     string;  // voor onderscheid per endpoint
}

function createRateLimiter(options: RateLimitOptions) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    // Gebruik IP-adres als identifier voor publieke routes
    const identifier = req.ip ?? 'unknown';
    const key = `ratelimit:${options.keyPrefix}:${identifier}`;

    try {
      const current = await redis.incr(key);

      if (current === 1) {
        // Eerste hit: stel verlooptijd in
        await redis.expire(key, options.windowSeconds);
      }

      if (current > options.maxRequests) {
        logger.warn('rate_limit.exceeded', {
          keyPrefix: options.keyPrefix,
          identifier,
          current,
          max: options.maxRequests,
        });

        res.status(429).json({
          error: 'too_many_requests',
          message: 'Te veel pogingen. Probeer het over enkele minuten opnieuw.',
          retryAfter: options.windowSeconds,
        });
        return;
      }
    } catch (err) {
      // Als Redis niet beschikbaar is: laat request door (fail open)
      // Beter dan alle gebruikers buiten sluiten
      logger.warn('rate_limit.redis_error', { error: (err as Error).message });
    }

    next();
  };
}

// Auth routes: max 10 pogingen per 15 minuten per IP
export const rateLimitAuth = createRateLimiter({
  windowSeconds: 15 * 60,
  maxRequests:   10,
  keyPrefix:     'auth',
});

// API routes: wordt per-tenant afgehandeld door tenant middleware
export const rateLimitApi = createRateLimiter({
  windowSeconds: 60,
  maxRequests:   200,  // algemene fallback
  keyPrefix:     'api',
});
