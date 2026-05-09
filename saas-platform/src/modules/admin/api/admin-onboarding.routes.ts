// ============================================================
// src/modules/admin/api/admin-onboarding.routes.ts
//
// Admin endpoint voor klantenservice/support: bekijk de
// onboarding-keuzes van een tenant.
//
// Gemount op /api/admin parallel aan admin.routes.ts. Eigen
// adminAuth middleware (kleine duplicaat van admin.routes.ts;
// kan later naar shared file als de admin module groeit).
//
// Endpoints:
//   GET /admin/tenants/:id/onboarding
//     -> volledige onboarding state inclusief raw veldwaarden
// ============================================================

import { Router, Request, Response, NextFunction } from 'express';
import { db } from '../../../infrastructure/database/connection';
import { adminSessionService } from '../service/admin-session.service';

interface AuthedRequest extends Request {
  adminSession?: { id: string };
}

interface OnboardingRow {
  onboarding_status:       'in_progress' | 'skipped' | 'completed';
  onboarding_step:         number;
  onboarding_completed_at: Date | null;
  country_code:            string | null;
  sells_to_countries:      string[] | null;
  business_goal:           string | null;
  marketing_style:         string | null;
  shop_connected:          boolean;
}

const router = Router();

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

// ── GET /admin/tenants/:id/onboarding ────────────────────────
// Read-only. Laat zien wat de tenant in de wizard heeft gekozen
// (of overgeslagen) plus of er een actieve store-connectie is.
router.get('/tenants/:id/onboarding', async (req: AuthedRequest, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;

    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
      res.status(400).json({ error: 'Ongeldig tenant id' });
      return;
    }

    const result = await db.query<OnboardingRow>(
      `SELECT
         t.onboarding_status,
         t.onboarding_step,
         t.onboarding_completed_at,
         t.country_code,
         t.sells_to_countries,
         t.business_goal,
         t.marketing_style,
         EXISTS (
           SELECT 1 FROM tenant_integrations ti
           WHERE ti.tenant_id = t.id
             AND ti.status = 'active'
         ) AS shop_connected
       FROM tenants t
       WHERE t.id = $1
       LIMIT 1`,
      [id],
      { allowNoTenant: true }
    );

    if (result.rows.length === 0) {
      res.status(404).json({ error: 'Tenant niet gevonden' });
      return;
    }

    const row = result.rows[0];
    res.json({
      status:           row.onboarding_status,
      step:             row.onboarding_step,
      completedAt:      row.onboarding_completed_at?.toISOString() ?? null,
      countryCode:      row.country_code,
      sellsToCountries: row.sells_to_countries,
      businessGoal:     row.business_goal,
      marketingStyle:   row.marketing_style,
      shopConnected:    row.shop_connected,
    });
  } catch (err) {
    next(err);
  }
});

export { router as adminOnboardingRouter };
