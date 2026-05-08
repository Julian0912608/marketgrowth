// ============================================================
// src/modules/onboarding/api/onboarding.routes.ts
//
// Endpoints:
//   GET   /api/onboarding/state         -> OnboardingState
//   POST  /api/onboarding/step-1        -> StepResult     (verplicht)
//   POST  /api/onboarding/step-2        -> StepResult     (skipbaar)
//   POST  /api/onboarding/step-3        -> StepResult     (skipbaar)
//   POST  /api/onboarding/complete      -> CompleteResult (na step 4)
//   POST  /api/onboarding/skip          -> StepResult     (vanaf step 2)
//   PATCH /api/onboarding/profile       -> OnboardingState (Settings edit)
//
// Validatie: zod, 422 op faal met field-level issues array.
// Tenant context: tenantMiddleware zet AsyncLocalStorage + RLS app.tenant_id.
// ============================================================

import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { tenantMiddleware } from '../../../shared/middleware/tenant.middleware';
import { getTenantContext } from '../../../shared/middleware/tenant-context';
import { onboardingService } from '../service/onboarding.service';
import {
  ALLOWED_COUNTRY_CODES,
  ALLOWED_SELLS_TO_CODES,
  BUSINESS_GOALS,
  MARKETING_STYLES,
  CountryCode,
  SellsToCode,
} from '../types/onboarding.types';
import { BusinessGoal, MarketingStyle } from '../../../shared/types/tenant';

// Zod-compatibele tuples afgeleid van de readonly constanten.
// z.enum vraagt mutable [T, ...T[]], dus spread + cast.
const COUNTRY_TUPLE         = [...ALLOWED_COUNTRY_CODES]   as [CountryCode, ...CountryCode[]];
const SELLS_TO_TUPLE        = [...ALLOWED_SELLS_TO_CODES]  as [SellsToCode, ...SellsToCode[]];
const BUSINESS_GOAL_TUPLE   = [...BUSINESS_GOALS]          as [BusinessGoal, ...BusinessGoal[]];
const MARKETING_STYLE_TUPLE = [...MARKETING_STYLES]        as [MarketingStyle, ...MarketingStyle[]];

const router = Router();
router.use(tenantMiddleware());

// ── Schemas ─────────────────────────────────────────────────

const step1Schema = z.object({
  countryCode:      z.enum(COUNTRY_TUPLE),
  sellsToCountries: z.array(z.enum(SELLS_TO_TUPLE))
                     .min(1, 'Select at least one country you sell to')
                     .max(30, 'Too many countries selected'),
});

const step2Schema = z.object({
  businessGoal: z.enum(BUSINESS_GOAL_TUPLE),
});

const step3Schema = z.object({
  marketingStyle: z.enum(MARKETING_STYLE_TUPLE),
});

const completeSchema = z.object({
  shopConnected: z.boolean(),
});

const updateProfileSchema = z.object({
  countryCode:      z.enum(COUNTRY_TUPLE).optional(),
  sellsToCountries: z.array(z.enum(SELLS_TO_TUPLE)).min(1).max(30).optional(),
  businessGoal:     z.enum(BUSINESS_GOAL_TUPLE).optional(),
  marketingStyle:   z.enum(MARKETING_STYLE_TUPLE).optional(),
}).refine(
  obj => Object.values(obj).some(v => v !== undefined),
  { message: 'At least one field must be provided' },
);

// ── Helper: uniforme zod errors ─────────────────────────────

function handleZodError(err: unknown, res: Response): boolean {
  if (err instanceof z.ZodError) {
    res.status(422).json({
      error:  'validation_failed',
      issues: err.issues.map(i => ({
        path:    i.path.join('.'),
        message: i.message,
      })),
    });
    return true;
  }
  return false;
}

// ── Routes ──────────────────────────────────────────────────

// GET /api/onboarding/state
router.get('/state', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const ctx = getTenantContext();
    const state = await onboardingService.getState(ctx.tenantId);
    res.set('Cache-Control', 'private, no-store');
    res.json(state);
  } catch (err) {
    next(err);
  }
});

// POST /api/onboarding/step-1
router.post('/step-1', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const ctx = getTenantContext();
    const input = step1Schema.parse(req.body);
    const result = await onboardingService.saveStep1(ctx.tenantId, input);
    res.json(result);
  } catch (err) {
    if (handleZodError(err, res)) return;
    next(err);
  }
});

// POST /api/onboarding/step-2
router.post('/step-2', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const ctx = getTenantContext();
    const input = step2Schema.parse(req.body);
    const result = await onboardingService.saveStep2(ctx.tenantId, input);
    res.json(result);
  } catch (err) {
    if (handleZodError(err, res)) return;
    next(err);
  }
});

// POST /api/onboarding/step-3
router.post('/step-3', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const ctx = getTenantContext();
    const input = step3Schema.parse(req.body);
    const result = await onboardingService.saveStep3(ctx.tenantId, input);
    res.json(result);
  } catch (err) {
    if (handleZodError(err, res)) return;
    next(err);
  }
});

// POST /api/onboarding/complete
router.post('/complete', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const ctx = getTenantContext();
    const input = completeSchema.parse(req.body);
    const result = await onboardingService.complete(ctx.tenantId, input);
    res.json(result);
  } catch (err) {
    if (handleZodError(err, res)) return;
    next(err);
  }
});

// POST /api/onboarding/skip
router.post('/skip', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const ctx = getTenantContext();
    const result = await onboardingService.skip(ctx.tenantId);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// PATCH /api/onboarding/profile (Settings edit)
router.patch('/profile', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const ctx = getTenantContext();
    const input = updateProfileSchema.parse(req.body);
    const state = await onboardingService.updateProfileFields(ctx.tenantId, input);
    res.json(state);
  } catch (err) {
    if (handleZodError(err, res)) return;
    next(err);
  }
});

export { router as onboardingRouter };
