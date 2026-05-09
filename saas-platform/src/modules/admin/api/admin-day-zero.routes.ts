// ============================================================
// src/modules/admin/api/admin-day-zero.routes.ts
//
// Admin endpoints voor Day Zero AI setup.
// Sprint 3a: smoke test endpoint om de pipeline handmatig te triggeren.
//
// Endpoints:
//   POST /admin/day-zero/trigger/:tenantId
//     -> enqueue Day Zero stage 1 voor de gegeven tenant
//   GET  /admin/day-zero/:tenantId
//     -> huidige progress, status, stage_data
// ============================================================

import { Router, Request, Response, NextFunction } from 'express';
import { adminSessionService } from '../service/admin-session.service';
import { dayZeroService }      from '../../day-zero/service/day-zero.service';
import { dayZeroRepository }   from '../../day-zero/repository/day-zero.repository';
import { logger }              from '../../../shared/logging/logger';

interface AuthedRequest extends Request {
  adminSession?: { id: string };
}

const router = Router();

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ── Admin auth middleware ────────────────────────────────────
async function adminAuth(req: AuthedRequest, res: Response, next: NextFunction): Promise<void> {
  const token = req.headers['x-admin-session'];

  if (typeof token !== 'string') {
    res.status(401).json({ error: 'Onbevoegd' });
    return;
  }

  const session = await adminSessionService.verify(token);
  if (!session) {
    res.status(401).json({ error: 'Sessie verlopen of ongeldig' });
    return;
  }

  req.adminSession = session;
  next();
}

router.use(adminAuth);

// ── POST /admin/day-zero/trigger/:tenantId ───────────────────
// Smoke test: handmatig Day Zero pipeline starten voor een tenant.
router.post('/trigger/:tenantId', async (req: AuthedRequest, res: Response, next: NextFunction) => {
  try {
    const tenantId = req.params.tenantId;

    if (!UUID_REGEX.test(tenantId)) {
      res.status(400).json({ error: 'Ongeldige tenant ID' });
      return;
    }

    const result = await dayZeroService.initForTenant(tenantId);

    logger.info('admin.day_zero.trigger', {
      tenantId,
      adminSessionId: req.adminSession?.id,
      result,
    });

    res.json({
      ok: true,
      tenantId,
      ...result,
    });
  } catch (err) {
    next(err);
  }
});

// ── GET /admin/day-zero/:tenantId ────────────────────────────
// Read-only progress check. Returns volledige rij inclusief stage_data.
router.get('/:tenantId', async (req: AuthedRequest, res: Response, next: NextFunction) => {
  try {
    const tenantId = req.params.tenantId;

    if (!UUID_REGEX.test(tenantId)) {
      res.status(400).json({ error: 'Ongeldige tenant ID' });
      return;
    }

    const row = await dayZeroRepository.getByTenantId(tenantId);
    if (!row) {
      res.status(404).json({ error: 'Geen Day Zero job voor deze tenant' });
      return;
    }

    const dto = await dayZeroService.getStatusDTO(tenantId);

    res.json({
      tenantId,
      summary: dto,
      raw:     row,
    });
  } catch (err) {
    next(err);
  }
});

export { router as adminDayZeroRouter };
