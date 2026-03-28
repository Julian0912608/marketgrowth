// ============================================================
// src/shared/middleware/feature-gate.middleware.ts
//
// FIX: In-memory PLAN_FEATURES map verwijderd.
// Delegeert nu volledig naar permissionService zodat:
//   - account overrides correct worden meegenomen
//   - er één enkele source of truth is
//   - geen sync-problemen meer tussen twee systemen
//
// Gebruik: router.get('/ads', featureGate('ad-analytics'), handler)
// ============================================================

import { Request, Response, NextFunction } from 'express';
import { getTenantContext } from './tenant-context';
import { permissionService } from '../permissions/permission.service';
import { FeatureSlug } from '../types/tenant';

export function featureGate(feature: FeatureSlug) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { tenantId, planSlug } = getTenantContext();

      const result = await permissionService.check({ tenantId, feature });

      if (!result.allowed) {
        const upgradeTarget = planSlug === 'starter' ? 'growth' : 'scale';
        res.status(403).json({
          error:        'feature_not_available',
          message:      `Deze functie is niet beschikbaar in je ${planSlug} abonnement.`,
          feature,
          requiredPlan: result.requiredPlan,
          upgrade:      upgradeTarget,
          upgradeUrl:   '/settings?tab=billing',
        });
        return;
      }

      next();
    } catch (err) {
      next(err);
    }
  };
}
