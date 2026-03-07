// src/modules/onboarding/api/onboarding.routes.ts
//
// FIX: getTenantContext() heeft geen argumenten

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { db, getTenantContext } from '../../../infrastructure/database/connection';
import { authenticate } from '../../../shared/middleware/auth.middleware';
import { logger } from '../../../shared/logging/logger';

export const onboardingRouter = Router();

// Alle onboarding routes vereisen authenticatie
onboardingRouter.use(authenticate);

// ── GET /api/onboarding/status ────────────────────────────────
onboardingRouter.get('/status', async (req: Request, res: Response) => {
  try {
    const userId   = (req as any).user.userId;
    const tenantId = (req as any).user.tenantId;

    const result = await db.query(
      `SELECT onboarding_completed, onboarding_step
       FROM tenants WHERE id = $1`,
      [tenantId],
      { allowNoTenant: true }
    );

    const tenant = result.rows[0];
    res.json({
      completed: tenant?.onboarding_completed || false,
      step:      tenant?.onboarding_step      || 'welcome',
    });
  } catch (err: any) {
    logger.error('onboarding.status.error', { error: err.message });
    res.status(500).json({ error: 'Kon status niet ophalen' });
  }
});

// ── POST /api/onboarding/complete ─────────────────────────────
onboardingRouter.post('/complete', async (req: Request, res: Response) => {
  try {
    const tenantId = (req as any).user.tenantId;
    const { step } = z.object({ step: z.string().optional() }).parse(req.body);

    await db.query(
      `UPDATE tenants SET
         onboarding_completed = true,
         onboarding_step      = $2,
         updated_at           = now()
       WHERE id = $1`,
      [tenantId, step || 'done'],
      { allowNoTenant: true }
    );

    res.json({ message: 'Onboarding voltooid' });
  } catch (err: any) {
    logger.error('onboarding.complete.error', { error: err.message });
    res.status(500).json({ error: 'Kon onboarding niet voltooien' });
  }
});

// ── POST /api/onboarding/step ─────────────────────────────────
onboardingRouter.post('/step', async (req: Request, res: Response) => {
  try {
    const tenantId = (req as any).user.tenantId;
    const { step } = z.object({ step: z.string() }).parse(req.body);

    await db.query(
      `UPDATE tenants SET onboarding_step = $2, updated_at = now() WHERE id = $1`,
      [tenantId, step],
      { allowNoTenant: true }
    );

    res.json({ step });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});
