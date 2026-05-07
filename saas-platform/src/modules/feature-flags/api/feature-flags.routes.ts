// ============================================================
// src/modules/feature-flags/api/feature-flags.routes.ts
//
// Endpoints:
//   GET /api/feature-flags
//     -> { countryCode, flags, fetchedAt }
//
// De country komt uit de tenant context (gezet door
// tenant.middleware.ts).
// ============================================================

import { Router, Request, Response, NextFunction } from 'express';
import { tenantMiddleware }    from '../../../shared/middleware/tenant.middleware';
import { getTenantContext }    from '../../../shared/middleware/tenant-context';
import { featureFlagsService } from '../service/feature-flags.service';
import { FeatureFlagsResponse } from '../types/feature-flags.types';

const router = Router();
router.use(tenantMiddleware());

router.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const ctx         = getTenantContext();
    const countryCode = ctx.countryCode ?? null;

    const flags = await featureFlagsService.getFlagsForCountry(countryCode);

    const response: FeatureFlagsResponse = {
      countryCode,
      flags,
      fetchedAt: new Date().toISOString(),
    };

    // Frontend mag 60s browser-cache, maar admin toggles moeten
    // snel propageren, dus geen lange Cache-Control.
    res.set('Cache-Control', 'private, max-age=60');
    res.json(response);
  } catch (err) {
    next(err);
  }
});

export { router as featureFlagsRouter };
