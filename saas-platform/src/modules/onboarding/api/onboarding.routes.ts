import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { db } from '../../../infrastructure/database/connection';
import { getTenantContext } from '../../../shared/middleware/tenant-context';
import { tenantMiddleware } from '../../../shared/middleware/tenant.middleware';
import { logger } from '../../../shared/logging/logger';

const router = Router();

router.use(tenantMiddleware());

router.get('/status', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { tenantId } = getTenantContext();
    const result = await db.query(
      `SELECT onboarding_completed, onboarding_step FROM tenants WHERE id = $1`,
      [tenantId]
    );
    res.json({
      completed: result.rows[0]?.onboarding_completed || false,
      step:      result.rows[0]?.onboarding_step      || 'welcome',
    });
  } catch (err) { next(err); }
});

router.post('/complete', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { tenantId } = getTenantContext();
    const { step } = z.object({ step: z.string().optional() }).parse(req.body);
    await db.query(
      `UPDATE tenants SET onboarding_completed=true, onboarding_step=$2, updated_at=now() WHERE id=$1`,
      [tenantId, step || 'done']
    );
    res.json({ message: 'Onboarding voltooid' });
  } catch (err) { next(err); }
});

router.post('/step', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { tenantId } = getTenantContext();
    const { step } = z.object({ step: z.string() }).parse(req.body);
    await db.query(
      `UPDATE tenants SET onboarding_step=$2, updated_at=now() WHERE id=$1`,
      [tenantId, step]
    );
    res.json({ step });
  } catch (err) { next(err); }
});

export { router as onboardingRouter };
