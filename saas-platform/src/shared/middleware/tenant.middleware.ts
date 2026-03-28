// ============================================================
// src/shared/middleware/tenant.middleware.ts
//
// FIX: planSlug wordt nu live opgehaald uit Redis/DB zodat
// plan-upgrades direct effect hebben zonder opnieuw inloggen.
// Ook: per-tenant rate limiting toegevoegd naast IP-limiet.
// ============================================================

import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { v4 as uuidv4 } from 'uuid';
import { runWithTenantContext } from './tenant-context';
import { db } from '../../infrastructure/database/connection';
import { redis } from '../../infrastructure/cache/redis';
import { logger } from '../logging/logger';

const PLAN_CACHE_TTL = 300; // 5 minuten — kort genoeg voor snelle upgrades

async function getLivePlanSlug(tenantId: string): Promise<string> {
  const cacheKey = `perm:plan:${tenantId}`;

  try {
    const cached = await redis.get(cacheKey);
    if (cached) return cached;
  } catch {
    // Redis niet beschikbaar — val terug op DB
  }

  try {
    const result = await db.query<{ plan_slug: string }>(
      `SELECT p.slug AS plan_slug
       FROM tenant_subscriptions ts
       JOIN plans p ON p.id = ts.plan_id
       WHERE ts.tenant_id = $1
         AND ts.status IN ('active', 'trialing')
       ORDER BY ts.created_at DESC
       LIMIT 1`,
      [tenantId],
      { allowNoTenant: true }
    );

    const planSlug = result.rows[0]?.plan_slug ?? 'starter';

    try {
      await redis.set(cacheKey, planSlug, 'EX', PLAN_CACHE_TTL);
    } catch {
      // Redis set mislukt — geen probleem, gewoon niet cachen
    }

    return planSlug;
  } catch (err) {
    logger.warn('tenant.middleware.plan_lookup_failed', {
      tenantId,
      error: (err as Error).message,
    });
    return 'starter'; // safe fallback
  }
}

// Per-tenant rate limiting: max 300 req/min
async function checkTenantRateLimit(tenantId: string): Promise<boolean> {
  const key = `ratelimit:tenant:${tenantId}`;
  try {
    const current = await redis.incr(key);
    if (current === 1) await redis.expire(key, 60);
    return current <= 300;
  } catch {
    return true; // Redis down → doorlaten
  }
}

export function tenantMiddleware() {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const authHeader = req.headers.authorization;

    if (!authHeader?.startsWith('Bearer ')) {
      res.status(401).json({ error: 'Niet ingelogd' });
      return;
    }

    const token = authHeader.split(' ')[1];

    let payload: any;
    try {
      payload = jwt.verify(token, process.env.JWT_SECRET || 'dev-secret-change-in-production');
    } catch (err) {
      res.status(401).json({ error: 'Ongeldige of verlopen sessie' });
      return;
    }

    const tenantId = payload.tenantId;

    // Per-tenant rate limit check
    const withinLimit = await checkTenantRateLimit(tenantId);
    if (!withinLimit) {
      res.status(429).json({
        error: 'too_many_requests',
        message: 'Te veel verzoeken. Probeer het over een minuut opnieuw.',
        retryAfter: 60,
      });
      return;
    }

    // Live planSlug ophalen — niet vertrouwen op JWT
    const planSlug = await getLivePlanSlug(tenantId);

    const context = {
      tenantId,
      tenantSlug:       payload.tenantSlug || '',
      userId:           payload.sub,
      planSlug,
      traceId:          uuidv4(),
      requestStartedAt: new Date(),
    };

    try {
      await db.query(
        `SELECT set_config('app.tenant_id', $1, true)`,
        [context.tenantId]
      );
    } catch {
      // Doorgaan ook als set_config faalt
    }

    runWithTenantContext(context, () => next());
  };
}
