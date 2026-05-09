// ============================================================
// src/modules/day-zero/controller/day-zero.controller.ts
//
// HTTP controller voor /api/day-zero/* endpoints.
// Tenant context komt uit auth middleware (AsyncLocalStorage of req).
// ============================================================

import { Request, Response, NextFunction } from 'express';
import { dayZeroService } from '../service/day-zero.service';
import { logger } from '../../../shared/logging/logger';

/**
 * GET /api/day-zero/status
 *
 * Polling endpoint voor /dashboard/setup. Returns shape die de UI
 * direct kan renderen (progress %, stage naam, ETA, error).
 *
 * 404 als de tenant nog geen Day Zero job heeft gestart.
 * 200 met { status: 'pending' | 'running' | 'completed' | 'failed' }
 */
export async function getDayZeroStatus(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const tenantId = getTenantIdFromReq(req);
    if (!tenantId) {
      res.status(401).json({ error: 'Unauthenticated' });
      return;
    }

    const dto = await dayZeroService.getStatusDTO(tenantId);
    if (!dto) {
      res.status(404).json({ error: 'Day Zero not started yet' });
      return;
    }

    res.json(dto);
  } catch (err) {
    logger.error('day_zero.controller.status.error', {
      error: (err as Error).message,
    });
    next(err);
  }
}

// --------------------------------------------------------------
// Helper: tenant ID extractie
// --------------------------------------------------------------

/**
 * Haalt tenantId uit het request object. ALIGN MET JE AUTH MIDDLEWARE.
 *
 * Als jouw bestaande onboarding controller `(req as any).tenant.id` gebruikt,
 * vervang dan onderstaande regel daarmee.
 *
 * Als je een AsyncLocalStorage helper hebt (bijv. getCurrentTenantId()),
 * importeer die en gebruik hem hier.
 */
function getTenantIdFromReq(req: Request): string | null {
  const r = req as any;
  return (
    r.tenant?.id ??
    r.tenantId ??
    r.auth?.tenantId ??
    r.user?.tenantId ??
    null
  );
}
