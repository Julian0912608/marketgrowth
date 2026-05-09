// ============================================================
// src/modules/day-zero/api/day-zero.routes.ts
//
// Endpoints voor de tenant-facing Day Zero progress polling.
//
// FIX: tenantMiddleware mount alleen op de specifieke route, niet
// op de hele router. Anders wordt CORS preflight (OPTIONS) ook
// door auth-check gestuurd en faalt met 401 zonder CORS headers,
// waardoor de browser de echte request nooit verstuurt.
//
// Endpoints:
//   GET /api/day-zero/status
// ============================================================

import { Router, Request, Response, NextFunction } from 'express';
import { tenantMiddleware } from '../../../shared/middleware/tenant.middleware';
import { getTenantContext } from '../../../shared/middleware/tenant-context';
import { dayZeroService } from '../service/day-zero.service';

const router = Router();

// GET /api/day-zero/status
router.get('/status', tenantMiddleware, async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const ctx = getTenantContext();
    const dto = await dayZeroService.getStatusDTO(ctx.tenantId);

    if (!dto) {
      res.status(404).json({ error: 'No Day Zero job for this tenant' });
      return;
    }

    res.set('Cache-Control', 'private, no-store');
    res.json(dto);
  } catch (err) {
    next(err);
  }
});

export { router as dayZeroRouter };
