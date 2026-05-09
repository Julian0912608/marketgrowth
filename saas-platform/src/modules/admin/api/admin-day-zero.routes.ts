// ============================================================
// src/modules/admin/api/admin-day-zero.routes.ts
//
// Mini admin endpoint om Day Zero handmatig te (re)triggeren
// tijdens V0 development. Wordt later vervangen door een knop
// in de admin UI.
//
// Pattern overgenomen van admin-onboarding.routes.ts: lokale
// adminAuth middleware + adminSessionService import.
//
// Endpoints:
//   POST /admin/tenants/:id/day-zero/trigger
//     Wist eventuele bestaande progress row + baseline plan en
//     queued een nieuwe Day Zero job. Idempotent veilig.
//
//   GET /admin/tenants/:id/day-zero/status
//     Inspect endpoint. Returnt huidige status + stage_data
//     voor admin debugging.
// ============================================================

import { Router, Request, Response, NextFunction } from 'express';
import { db } from '../../../infrastructure/database/connection';
import { logger } from '../../../shared/logging/logger';
import { dayZeroService } from '../../day-zero/service/day-zero.service';
import { adminSessionService } from '../service/admin-session.service';

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

// ============================================================
// POST /admin/tenants/:id/day-zero/trigger
// ============================================================
router.post('/tenants/:id/day-zero/trigger', async (req: AuthedRequest, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;

    if (!UUID_REGEX.test(id)) {
      res.status(400).json({ error: 'Ongeldig tenant id' });
      return;
    }

    // Wis bestaande progress row en baseline plan zodat we vers beginnen.
    await db.query(
      `DELETE FROM tenant_day_zero_progress WHERE tenant_id = $1`,
      [id], { allowNoTenant: true }
    );

    await db.query(
      `DELETE FROM baseline_marketing_plans WHERE tenant_id = $1`,
      [id], { allowNoTenant: true }
    );

    const result = await dayZeroService.initForTenant(id);

    logger.info('admin.day_zero.triggered', { tenantId: id, ...result });
    res.json({ success: true, tenantId: id, ...result });
  } catch (err) {
    logger.error('admin.day_zero.trigger_failed', {
      tenantId: req.params.id,
      error: (err as Error).message,
    });
    next(err);
  }
});

// ============================================================
// GET /admin/tenants/:id/day-zero/status
// ============================================================
router.get('/tenants/:id/day-zero/status', async (req: AuthedRequest, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;

    if (!UUID_REGEX.test(id)) {
      res.status(400).json({ error: 'Ongeldig tenant id' });
      return;
    }

    const progress = await db.query(
      `SELECT status, current_stage, started_at, completed_at,
              error_message, error_stage, error_count, stage_data
       FROM tenant_day_zero_progress
       WHERE tenant_id = $1`,
      [id], { allowNoTenant: true }
    );

    const baseline = await db.query(
      `SELECT brand_voice_model, brand_voice_input_tokens, brand_voice_output_tokens, brand_voice_generated_at,
              patterns_model, patterns_input_tokens, patterns_output_tokens, patterns_generated_at,
              plan_model, plan_input_tokens, plan_output_tokens, plan_generated_at
       FROM baseline_marketing_plans
       WHERE tenant_id = $1`,
      [id], { allowNoTenant: true }
    );

    res.json({
      progress: progress.rows[0] ?? null,
      baseline: baseline.rows[0] ?? null,
    });
  } catch (err) { next(err); }
});

export { router as adminDayZeroRouter };
