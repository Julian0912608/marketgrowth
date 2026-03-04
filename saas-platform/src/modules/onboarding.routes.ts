// ============================================================
// src/modules/onboarding/api/onboarding.routes.ts
// ============================================================

import { Router, Request, Response, NextFunction } from 'express';
import { OnboardingService } from '../service/onboarding.service';
import { tenantMiddleware } from '../../../shared/middleware/tenant.middleware';
import { OnboardingStep } from '../service/onboarding.service';

const router = Router();
const onboardingService = new OnboardingService();

// Alle onboarding routes vereisen een ingelogde gebruiker
router.use(tenantMiddleware());

// ── GET /api/onboarding/status ────────────────────────────────
router.get('/status', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const status = await onboardingService.getStatus();
    res.json(status);
  } catch (err) { next(err); }
});

// ── POST /api/onboarding/complete-step ───────────────────────
router.post('/complete-step', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { step } = req.body as { step: OnboardingStep };
    if (!step) {
      res.status(400).json({ error: 'step is verplicht' });
      return;
    }
    const status = await onboardingService.completeStep(step);
    res.json(status);
  } catch (err) { next(err); }
});

export { router as onboardingRouter };
