// saas-platform/src/shared/middleware/feature-gate.middleware.ts
//
// Gebruik: router.get('/ads', featureGate('ad-analytics'), handler)
// Blokkeert automatisch op basis van het plan van de tenant.

import { Request, Response, NextFunction } from 'express';
import { getTenantContext } from './tenant-context';
import { db }   from '../../infrastructure/database/connection';
import { cache } from '../../infrastructure/cache/redis';

type FeatureSlug =
  | 'sales-dashboard'
  | 'order-analytics'
  | 'ai-recommendations'
  | 'ad-analytics'
  | 'ai-ad-optimization'
  | 'customer-ltv'
  | 'multi-shop'
  | 'report-export'
  | 'api-access'
  | 'white-label'
  | 'team-accounts';

const PLAN_FEATURES: Record<string, FeatureSlug[]> = {
  starter: ['sales-dashboard', 'order-analytics'],
  growth:  ['sales-dashboard', 'order-analytics', 'ai-recommendations', 'ad-analytics', 'customer-ltv', 'multi-shop', 'report-export'],
  scale:   ['sales-dashboard', 'order-analytics', 'ai-recommendations', 'ad-analytics', 'ai-ad-optimization', 'customer-ltv', 'multi-shop', 'report-export', 'api-access', 'white-label', 'team-accounts'],
};

async function tenantHasFeature(tenantId: string, planSlug: string, feature: FeatureSlug): Promise<boolean> {
  const cacheKey = `feature:${tenantId}:${feature}`;
  const cached   = await cache.get(cacheKey);
  if (cached !== null) return cached === 'true';

  // Check plan features + account overrides
  const result = await db.query(
    `SELECT 1 FROM plan_features pf
     JOIN plans p ON p.id = pf.plan_id
     JOIN features f ON f.id = pf.feature_id
     WHERE p.slug = $1 AND f.slug = $2
     UNION
     SELECT 1 FROM account_feature_overrides afo
     JOIN features f ON f.id = afo.feature_id
     WHERE afo.tenant_id = $3 AND f.slug = $2
       AND afo.granted = true
       AND (afo.expires_at IS NULL OR afo.expires_at > now())
     LIMIT 1`,
    [planSlug, feature, tenantId],
    { allowNoTenant: true }
  );

  const allowed = result.rows.length > 0;
  await cache.set(cacheKey, String(allowed), 300); // 5 min cache
  return allowed;
}

export function featureGate(feature: FeatureSlug) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { tenantId, planSlug } = getTenantContext();

      // Scale heeft altijd alles
      if (planSlug === 'scale') { next(); return; }

      // Snelle check via in-memory plan map
      const planFeatures = PLAN_FEATURES[planSlug] ?? PLAN_FEATURES['starter'];
      if (planFeatures.includes(feature)) { next(); return; }

      // Controleer account overrides in DB
      const hasAccess = await tenantHasFeature(tenantId, planSlug, feature);
      if (hasAccess) { next(); return; }

      res.status(403).json({
        error:    'feature_not_available',
        message:  `Deze functie is niet beschikbaar in je ${planSlug} abonnement.`,
        feature,
        upgrade:  planSlug === 'starter' ? 'growth' : 'scale',
      });
    } catch (err) {
      next(err);
    }
  };
}
