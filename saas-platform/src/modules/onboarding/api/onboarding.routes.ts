// saas-platform/src/modules/onboarding/api/onboarding.routes.ts
//
// SECURITY UPDATE: Zod validatie op complete-step endpoint

import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { OnboardingService, OnboardingStep } from '../service/onboarding.service';
import { tenantMiddleware } from '../../../shared/middleware/tenant.middleware';

const router = Router();
const onboardingService = new OnboardingService();

router.use(tenantMiddleware());

const VALID_STEPS: OnboardingStep[] = [
  'account_created',
  'plan_selected',
  'payment_completed',
  'shop_connected',
  'completed',
];

const CompleteStepSchema = z.object({
  step: z.enum(VALID_STEPS as [OnboardingStep, ...OnboardingStep[]]),
});

function validate<T>(schema: z.ZodSchema<T>, data: unknown): T {
  const result = schema.safeParse(data);
  if (!result.success) {
    const messages = result.error.errors.map(e => e.message).join(', ');
    throw Object.assign(new Error(messages), { httpStatus: 400 });
  }
  return result.data;
}

// GET /api/onboarding/status
router.get('/status', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const status = await onboardingService.getStatus();
    res.json(status);
  } catch (err) { next(err); }
});

// POST /api/onboarding/complete-step
router.post('/complete-step', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { step } = validate(CompleteStepSchema, req.body);
    const status   = await onboardingService.completeStep(step);
    res.json(status);
  } catch (err) { next(err); }
});

export { router as onboardingRouter };
