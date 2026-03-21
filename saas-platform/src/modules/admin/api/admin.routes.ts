// ============================================================
// src/modules/admin/api/admin.routes.ts
// Backend admin API — draait op Railway
// Mount in app.ts: app.use('/api/admin', adminRouter)
//
// Beveiliging: alle routes controleren x-admin-token header
// Stel in Railway env: ADMIN_SECRET=jouw-geheime-sleutel
// ============================================================

import { Router, Request, Response, NextFunction } from 'express';
import Stripe from 'stripe';
import { db }    from '../../../infrastructure/database/connection';
import { cache } from '../../../infrastructure/cache/redis';
import { permissionService } from '../../../shared/permissions/permission.service';
import { logger } from '../../../shared/logging/logger';
import jwt from 'jsonwebtoken';

const router = Router();

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
  apiVersion: '2023-10-16',
});

// ── Admin authenticatie middleware ────────────────────────────
function adminAuth(req: Request, res: Response, next: NextFunction): void {
  const token = req.headers['x-admin-token'] || req.query.admin_token;
  if (!token || token !== process.env.ADMIN_SECRET) {
    res.status(401).json({ error: 'Onbevoegd' });
    return;
  }
  next();
}

router.use(adminAuth);

// ============================================================
// GET /admin/kpis
// KPI overzicht voor het dashboard
// ============================================================
router.get('/kpis', async (req: Request, res: Response, next: NextFunction) => {
  try {
    // MRR per plan
    const mrrResult = await db.query<{
      plan_slug: string;
      tenant_count: string;
      mrr_cents: string;
    }>(
      `SELECT
         p.slug AS plan_slug,
         COUNT(ts.tenant_id) AS tenant_count,
         SUM(p.monthly_price_cents) AS mrr_cents
       FROM tenant_subscriptions ts
       JOIN plans p ON p.id = ts.plan_id
       WHERE ts.status IN ('active', 'trialing')
       GROUP BY p.slug`,
      [], { allowNoTenant: true }
    );

    const mrrByPlan: Record<string, number> = { starter: 0, growth: 0, scale: 0 };
    let activeTenants  = 0;
    let trialingTenants = 0;
    let totalMRR       = 0;

    // Actieve vs trialing aparte query
    const statusResult = await db.query<{ status: string; count: string }>(
      `SELECT status, COUNT(*) as count
       FROM tenant_subscriptions
       WHERE status IN ('active', 'trialing', 'past_due')
       GROUP BY status`,
      [], { allowNoTenant: true }
    );

    for (const row of statusResult.rows) {
      if (row.status === 'active')   activeTenants   = parseInt(row.count);
      if (row.status === 'trialing') trialingTenants = parseInt(row.count);
    }

    for (const row of mrrResult.rows) {
      const mrr = parseInt(row.mrr_cents || '0') / 100;
      mrrByPlan[row.plan_slug] = mrr;
      totalMRR += mrr;
    }

    // Nieuwe klanten afgelopen 30 dagen
    const newResult = await db.query<{ count: string }>(
      `SELECT COUNT(*) as count FROM tenants
       WHERE created_at > now() - INTERVAL '30 days'`,
      [], { allowNoTenant: true }
    );

    // Churn afgelopen 30 dagen
    const churnResult = await db.query<{ count: string }>(
      `SELECT COUNT(*) as count FROM tenant_subscriptions
       WHERE status = 'cancelled'
         AND updated_at > now() - INTERVAL '30 days'`,
      [], { allowNoTenant: true }
    );

    // Past due
    const pastDueResult = await db.query<{ count: string }>(
      `SELECT COUNT(*) as count FROM tenant_subscriptions WHERE status = 'past_due'`,
      [], { allowNoTenant: true }
    );

    // Trial conversie (trialing → active in 30d)
    const convResult = await db.query<{ converted: string; total: string }>(
      `SELECT
         COUNT(CASE WHEN status = 'active' AND created_at > now() - INTERVAL '30 days' THEN 1 END) AS converted,
         COUNT(CASE WHEN created_at > now() - INTERVAL '30 days' THEN 1 END) AS total
       FROM tenant_subscriptions`,
      [], { allowNoTenant: true }
    );

    const converted       = parseInt(convResult.rows[0]?.converted || '0');
    const totalNew        = parseInt(convResult.rows[0]?.total || '1');
    const trialConversion = totalNew > 0 ? Math.round((converted / totalNew) * 100) : 0;

    res.json({
      mrr:              Math.round(totalMRR),
      mrr_growth:       0, // TODO: vergelijk met vorige maand
      active_tenants:   activeTenants,
      trialing_tenants: trialingTenants,
      past_due:         parseInt(pastDueResult.rows[0]?.count || '0'),
      churn_30d:        parseInt(churnResult.rows[0]?.count || '0'),
      new_30d:          parseInt(newResult.rows[0]?.count || '0'),
      trial_conversion: trialConversion,
      mrr_by_plan:      mrrByPlan,
    });
  } catch (err) { next(err); }
});

// ============================================================
// GET /admin/tenants
// Alle tenants met subscription info
// ============================================================
router.get('/tenants', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const result = await db.query(
      `SELECT
         t.id,
         t.name,
         t.email,
         t.slug,
         t.status,
         t.stripe_customer_id,
         t.created_at,
         p.slug           AS plan_slug,
         ts.status        AS billing_status,
         p.monthly_price_cents AS mrr_cents,
         (SELECT COUNT(*) FROM tenant_integrations ti WHERE ti.tenant_id = t.id AND ti.status = 'active') AS integrations,
         COALESCE(fu.usage_count, 0) AS ai_credits_used,
         ul.limit_value              AS ai_credits_limit,
         (SELECT MAX(created_at) FROM sync_jobs sj WHERE sj.tenant_id = t.id) AS last_active_at
       FROM tenants t
       LEFT JOIN tenant_subscriptions ts ON ts.tenant_id = t.id
       LEFT JOIN plans p ON p.id = ts.plan_id
       LEFT JOIN feature_usage fu ON fu.tenant_id = t.id
         AND fu.period_start <= now() AND fu.period_end >= now()
         AND fu.feature_id = (SELECT id FROM features WHERE slug = 'ai-recommendations')
       LEFT JOIN usage_limits ul ON ul.plan_id = ts.plan_id
         AND ul.feature_id = (SELECT id FROM features WHERE slug = 'ai-recommendations')
         AND ul.limit_type = 'monthly'
       ORDER BY t.created_at DESC
       LIMIT 500`,
      [], { allowNoTenant: true }
    );

    res.json(result.rows);
  } catch (err) { next(err); }
});

// ============================================================
// POST /admin/tenants/:id/change-plan
// Plan handmatig wijzigen voor een klant
// ============================================================
router.post('/tenants/:id/change-plan', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id }       = req.params;
    const { planSlug } = req.body as { planSlug: string };

    if (!['starter', 'growth', 'scale'].includes(planSlug)) {
      res.status(400).json({ error: 'Ongeldig plan' });
      return;
    }

    await db.query(
      `UPDATE tenant_subscriptions
       SET plan_id = (SELECT id FROM plans WHERE slug = $2),
           updated_at = now()
       WHERE tenant_id = $1`,
      [id, planSlug], { allowNoTenant: true }
    );

    await permissionService.invalidateTenantCache(id);
    await cache.invalidateTenant(id);

    logger.info('admin.tenant.plan_changed', { tenantId: id, planSlug });
    res.json({ success: true });
  } catch (err) { next(err); }
});

// ============================================================
// POST /admin/tenants/:id/suspend
// Account opschorten
// ============================================================
router.post('/tenants/:id/suspend', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;

    await db.query(
      `UPDATE tenants SET status = 'suspended', updated_at = now() WHERE id = $1`,
      [id], { allowNoTenant: true }
    );

    await permissionService.invalidateTenantCache(id);
    await cache.invalidateTenant(id);

    logger.info('admin.tenant.suspended', { tenantId: id });
    res.json({ success: true });
  } catch (err) { next(err); }
});

// ============================================================
// POST /admin/tenants/:id/reset-credits
// AI credits voor deze maand resetten
// ============================================================
router.post('/tenants/:id/reset-credits', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;

    await db.query(
      `UPDATE feature_usage
       SET usage_count = 0, updated_at = now()
       WHERE tenant_id = $1
         AND period_start <= now()
         AND period_end   >= now()
         AND feature_id = (SELECT id FROM features WHERE slug = 'ai-recommendations')`,
      [id], { allowNoTenant: true }
    );

    // Cache entry verwijderen zodat de credit check opnieuw berekend wordt
    const cacheKey = `usage:${id}:ai-recommendations`;
    await cache.del(cacheKey);

    logger.info('admin.tenant.credits_reset', { tenantId: id });
    res.json({ success: true });
  } catch (err) { next(err); }
});

// ============================================================
// POST /admin/tenants/:id/impersonate
// Tijdelijk JWT aanmaken om in te loggen als klant
// Token verloopt na 30 minuten
// ============================================================
router.post('/tenants/:id/impersonate', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;

    const result = await db.query<{ id: string; tenant_id: string }>(
      `SELECT id, tenant_id FROM users WHERE tenant_id = $1 LIMIT 1`,
      [id], { allowNoTenant: true }
    );

    const user = result.rows[0];
    if (!user) {
      res.status(404).json({ error: 'Geen gebruiker gevonden voor deze tenant' });
      return;
    }

    const token = jwt.sign(
      {
        userId:       user.id,
        tenantId:     user.tenant_id,
        impersonated: true,       // vlag zodat je dit kan loggen/zien in de UI
      },
      process.env.JWT_SECRET!,
      { expiresIn: '30m' }
    );

    const appUrl = process.env.APP_URL || 'https://marketgrowth-frontend.vercel.app';

    logger.warn('admin.tenant.impersonated', { adminAction: true, tenantId: id });

    res.json({
      token,
      url: `${appUrl}/dashboard`,
    });
  } catch (err) { next(err); }
});

// ============================================================
// GET /admin/health/queue
// BullMQ queue status
// ============================================================
router.get('/health/queue', async (req: Request, res: Response, next: NextFunction) => {
  try {
    // Haal queue dieptes op uit Redis (BullMQ slaat ze op als keys)
    const waiting   = await cache.get('bull:sync-jobs:waiting')   ?? '0';
    const active    = await cache.get('bull:sync-jobs:active')    ?? '0';
    const completed = await cache.get('bull:sync-jobs:completed') ?? '0';
    const failed    = await cache.get('bull:sync-jobs:failed')    ?? '0';

    res.json({ waiting, active, completed, failed, status: 'ok' });
  } catch (err) { next(err); }
});

// ============================================================
// GET /admin/health/db
// Database verbinding en query latency
// ============================================================
router.get('/health/db', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const start  = Date.now();
    const result = await db.query(
      `SELECT COUNT(*) AS tenants FROM tenants`,
      [], { allowNoTenant: true }
    );
    const latency = Date.now() - start;

    res.json({
      status:  'ok',
      latency_ms: latency,
      tenants: result.rows[0].tenants,
    });
  } catch (err) {
    res.json({ status: 'error', error: String(err) });
  }
});

// ============================================================
// GET /admin/health/redis
// Redis ping
// ============================================================
router.get('/health/redis', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const start = Date.now();
    await cache.get('health:ping');
    const latency = Date.now() - start;

    res.json({ status: 'ok', latency_ms: latency });
  } catch (err) {
    res.json({ status: 'error', error: String(err) });
  }
});

export { router as adminRouter };
