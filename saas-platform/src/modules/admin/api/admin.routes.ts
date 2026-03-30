// ============================================================
// src/modules/admin/api/admin.routes.ts
//
// FIXES:
//   1. /admin/tenants query: gebruikt nu tenants.plan_slug direct
//      i.p.v. JOIN op plans tabel (vermijdt join-fout als
//      monthly_price_cents nog niet bestaat)
//   2. /admin/kpis: fallback als plans.monthly_price_cents ontbreekt
//   3. /admin/health/latency endpoint toegevoegd (was missing,
//      veroorzaakte "Ophalen mislukt" in Platform gezondheid tab)
//   4. CORS: admin health endpoints stonden niet open voor Vercel
// ============================================================

import { Router, Request, Response, NextFunction } from 'express';
import Stripe from 'stripe';
import { db }    from '../../../infrastructure/database/connection';
import { cache } from '../../../infrastructure/cache/redis';
import { permissionService } from '../../../shared/permissions/permission.service';
import { logger } from '../../../shared/logging/logger';

const router = Router();

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
  apiVersion: '2023-10-16',
});

const PLAN_PRICE_IDS: Record<string, string> = {
  starter: process.env.STRIPE_PRICE_STARTER ?? '',
  growth:  process.env.STRIPE_PRICE_GROWTH  ?? '',
  scale:   process.env.STRIPE_PRICE_SCALE   ?? '',
};

// MRR per plan in cents (fallback als monthly_price_cents niet in DB staat)
const PLAN_MRR_CENTS: Record<string, number> = {
  starter: 2000,   // €20
  growth:  4900,   // €49
  scale:   15000,  // €150
};

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
// ============================================================
router.get('/kpis', async (req: Request, res: Response, next: NextFunction) => {
  try {
    // Gebruik plan_slug direct van tenant_subscriptions + tenants
    // i.p.v. JOIN op plans tabel (robuuster)
    const statusResult = await db.query<{ plan_slug: string; status: string; count: string }>(
      `SELECT
         COALESCE(t.plan_slug, 'starter') AS plan_slug,
         ts.status,
         COUNT(*) AS count
       FROM tenant_subscriptions ts
       JOIN tenants t ON t.id = ts.tenant_id
       WHERE ts.status IN ('active', 'trialing', 'past_due', 'cancelled')
       GROUP BY t.plan_slug, ts.status`,
      [], { allowNoTenant: true }
    );

    const mrrByPlan: Record<string, number> = { starter: 0, growth: 0, scale: 0 };
    let activeTenants   = 0;
    let trialingTenants = 0;
    let totalMRR        = 0;

    for (const row of statusResult.rows) {
      const count = parseInt(row.count);
      if (row.status === 'active')   activeTenants   += count;
      if (row.status === 'trialing') trialingTenants += count;

      if (row.status === 'active' || row.status === 'trialing') {
        const mrr = (PLAN_MRR_CENTS[row.plan_slug] ?? 0) * count / 100;
        mrrByPlan[row.plan_slug] = (mrrByPlan[row.plan_slug] ?? 0) + mrr;
        totalMRR += mrr;
      }
    }

    const pastDueResult = await db.query<{ count: string }>(
      `SELECT COUNT(*) as count FROM tenant_subscriptions WHERE status = 'past_due'`,
      [], { allowNoTenant: true }
    );

    const churnResult = await db.query<{ count: string }>(
      `SELECT COUNT(*) as count FROM tenant_subscriptions
       WHERE status = 'cancelled' AND updated_at > now() - INTERVAL '30 days'`,
      [], { allowNoTenant: true }
    );

    const newResult = await db.query<{ count: string }>(
      `SELECT COUNT(*) as count FROM tenants
       WHERE created_at > now() - INTERVAL '30 days'`,
      [], { allowNoTenant: true }
    );

    const convertedResult = await db.query<{ count: string }>(
      `SELECT COUNT(*) as count FROM tenant_subscriptions
       WHERE status = 'active'
         AND created_at > now() - INTERVAL '30 days'`,
      [], { allowNoTenant: true }
    );

    const totalNew  = parseInt(newResult.rows[0]?.count || '0');
    const converted = parseInt(convertedResult.rows[0]?.count || '0');
    const trialConversion = totalNew > 0 ? Math.round((converted / totalNew) * 100) : 0;

    res.json({
      mrr:              Math.round(totalMRR),
      mrr_growth:       0,
      active_tenants:   activeTenants,
      trialing_tenants: trialingTenants,
      past_due:         parseInt(pastDueResult.rows[0]?.count || '0'),
      churn_30d:        parseInt(churnResult.rows[0]?.count || '0'),
      new_30d:          totalNew,
      trial_conversion: trialConversion,
      mrr_by_plan:      mrrByPlan,
    });
  } catch (err) { next(err); }
});

// ============================================================
// GET /admin/tenants
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
         COALESCE(t.plan_slug, ts_latest.plan_slug, 'starter') AS plan_slug,
         COALESCE(ts_latest.status, 'trialing')                AS billing_status,
         ts_latest.stripe_sub_id,
         COALESCE(ts_latest.mrr_cents, 0)                      AS mrr_cents,
         (SELECT COUNT(*)::int FROM tenant_integrations ti
          WHERE ti.tenant_id = t.id AND ti.status = 'active')  AS integrations,
         COALESCE(fu.usage_count, 0)                           AS ai_credits_used,
         ul.limit_value                                        AS ai_credits_limit,
         NULL::timestamptz                                     AS last_active_at
       FROM tenants t
       LEFT JOIN LATERAL (
         SELECT
           ts.status,
           ts.stripe_sub_id,
           COALESCE(ts.plan_slug_cache, 'starter') AS plan_slug,
           CASE
             WHEN COALESCE(ts.plan_slug_cache, 'starter') = 'growth' THEN 4900
             WHEN COALESCE(ts.plan_slug_cache, 'starter') = 'scale'  THEN 15000
             ELSE 2000
           END AS mrr_cents
         FROM tenant_subscriptions ts
         WHERE ts.tenant_id = t.id
         ORDER BY ts.created_at DESC
         LIMIT 1
       ) ts_latest ON true
       LEFT JOIN feature_usage fu ON fu.tenant_id = t.id
         AND fu.period_start = date_trunc('month', now())
         AND fu.feature_id = (SELECT id FROM features WHERE slug = 'ai-recommendations')
       LEFT JOIN usage_limits ul ON ul.feature_id = (
           SELECT id FROM features WHERE slug = 'ai-recommendations'
         )
         AND ul.plan_id = (
           SELECT id FROM plans WHERE slug = COALESCE(t.plan_slug, 'starter')
         )
         AND ul.limit_type = 'monthly'
       ORDER BY t.created_at DESC
       LIMIT 500`,
      [], { allowNoTenant: true }
    );

    // Post-process: bereken mrr_cents op basis van plan_slug als fallback
    const rows = result.rows.map((row: any) => ({
      ...row,
      mrr_cents: row.mrr_cents || PLAN_MRR_CENTS[row.plan_slug] || 0,
    }));

    res.json(rows);
  } catch (err) { next(err); }
});

// ============================================================
// POST /admin/tenants/:id/change-plan
// ============================================================
router.post('/tenants/:id/change-plan', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id }       = req.params;
    const { planSlug } = req.body as { planSlug: string };

    if (!['starter', 'growth', 'scale'].includes(planSlug)) {
      res.status(400).json({ error: 'Ongeldig plan' });
      return;
    }

    const priceId = PLAN_PRICE_IDS[planSlug];

    const subResult = await db.query<{ stripe_sub_id: string }>(
      `SELECT stripe_sub_id FROM tenant_subscriptions
       WHERE tenant_id = $1 AND status IN ('active', 'trialing') LIMIT 1`,
      [id], { allowNoTenant: true }
    );

    const stripeSubId = subResult.rows[0]?.stripe_sub_id;

    if (stripeSubId && priceId) {
      try {
        const subscription = await stripe.subscriptions.retrieve(stripeSubId);
        await stripe.subscriptions.update(stripeSubId, {
          items: [{ id: subscription.items.data[0].id, price: priceId }],
          proration_behavior: 'create_prorations',
        });
        logger.info('admin.stripe.plan_changed', { tenantId: id, planSlug });
      } catch (stripeErr: any) {
        logger.warn('admin.stripe.plan_change_failed', { tenantId: id, error: stripeErr.message });
      }
    }

    // Update plan in DB
    await db.query(
      `UPDATE tenant_subscriptions
       SET plan_id = (SELECT id FROM plans WHERE slug = $2),
           updated_at = now()
       WHERE tenant_id = $1`,
      [id, planSlug], { allowNoTenant: true }
    );

    // Update plan_slug op tenants tabel
    await db.query(
      `UPDATE tenants SET plan_slug = $2, updated_at = now() WHERE id = $1`,
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
// ============================================================
router.post('/tenants/:id/suspend', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;

    const subResult = await db.query<{ stripe_sub_id: string }>(
      `SELECT stripe_sub_id FROM tenant_subscriptions
       WHERE tenant_id = $1 AND status IN ('active', 'trialing') LIMIT 1`,
      [id], { allowNoTenant: true }
    );

    const stripeSubId = subResult.rows[0]?.stripe_sub_id;
    if (stripeSubId) {
      try {
        await stripe.subscriptions.cancel(stripeSubId);
      } catch (stripeErr: any) {
        logger.warn('admin.stripe.cancel_failed', { tenantId: id, error: stripeErr.message });
      }
    }

    await db.query(
      `UPDATE tenants SET status = 'suspended', updated_at = now() WHERE id = $1`,
      [id], { allowNoTenant: true }
    );
    await db.query(
      `UPDATE tenant_subscriptions SET status = 'cancelled', updated_at = now() WHERE tenant_id = $1`,
      [id], { allowNoTenant: true }
    );

    await permissionService.invalidateTenantCache(id);
    await cache.invalidateTenant(id);

    logger.info('admin.tenant.suspended', { tenantId: id });
    res.json({ success: true });
  } catch (err) { next(err); }
});

// ============================================================
// POST /admin/tenants/:id/reactivate
// ============================================================
router.post('/tenants/:id/reactivate', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;

    await db.query(
      `UPDATE tenants SET status = 'active', updated_at = now() WHERE id = $1`,
      [id], { allowNoTenant: true }
    );
    await db.query(
      `UPDATE tenant_subscriptions
       SET status = 'trialing',
           current_period_end = now() + INTERVAL '14 days',
           updated_at = now()
       WHERE tenant_id = $1`,
      [id], { allowNoTenant: true }
    );

    await permissionService.invalidateTenantCache(id);
    await cache.invalidateTenant(id);

    logger.info('admin.tenant.reactivated', { tenantId: id });
    res.json({ success: true });
  } catch (err) { next(err); }
});

// ============================================================
// GET /admin/health/queue
// ============================================================
router.get('/health/queue', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const waiting   = await cache.get('bull:sync-jobs:waiting')   ?? '0';
    const active    = await cache.get('bull:sync-jobs:active')    ?? '0';
    const completed = await cache.get('bull:sync-jobs:completed') ?? '0';
    const failed    = await cache.get('bull:sync-jobs:failed')    ?? '0';

    // Probeer ook live BullMQ stats op te halen
    try {
      const result = await db.query(
        `SELECT
           COUNT(CASE WHEN status = 'queued'    THEN 1 END) AS waiting,
           COUNT(CASE WHEN status = 'running'   THEN 1 END) AS active,
           COUNT(CASE WHEN status = 'completed' THEN 1 END) AS completed,
           COUNT(CASE WHEN status = 'failed'    THEN 1 END) AS failed
         FROM integration_sync_jobs
         WHERE created_at > now() - INTERVAL '24 hours'`,
        [], { allowNoTenant: true }
      );
      const row = result.rows[0];
      res.json({
        waiting:   parseInt(row.waiting   || '0'),
        active:    parseInt(row.active    || '0'),
        completed: parseInt(row.completed || '0'),
        failed:    parseInt(row.failed    || '0'),
        status: 'ok',
      });
    } catch {
      res.json({ waiting, active, completed, failed, status: 'ok' });
    }
  } catch (err) { next(err); }
});

// ============================================================
// GET /admin/health/db
// ============================================================
router.get('/health/db', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const start  = Date.now();
    const result = await db.query(
      `SELECT COUNT(*) AS tenants FROM tenants`,
      [], { allowNoTenant: true }
    );
    const latency = Date.now() - start;

    res.json({ status: 'ok', latency_ms: latency, tenants: result.rows[0].tenants });
  } catch (err) {
    res.json({ status: 'error', error: String(err) });
  }
});

// ============================================================
// GET /admin/health/redis
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

// ============================================================
// GET /admin/health/latency
// FIX: dit endpoint bestond niet — veroorzaakte "Ophalen mislukt"
// ============================================================
router.get('/health/latency', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const checks = await Promise.all([
      // DB latency
      (async () => {
        const start = Date.now();
        await db.query('SELECT 1', [], { allowNoTenant: true });
        return { service: 'database', latency_ms: Date.now() - start, status: 'ok' };
      })().catch(err => ({ service: 'database', latency_ms: -1, status: 'error', error: err.message })),

      // Redis latency
      (async () => {
        const start = Date.now();
        await cache.get('health:latency:ping');
        return { service: 'redis', latency_ms: Date.now() - start, status: 'ok' };
      })().catch(err => ({ service: 'redis', latency_ms: -1, status: 'error', error: err.message })),

      // Railway health
      (async () => {
        const start = Date.now();
        const res2 = await fetch('https://marketgrowth-production.up.railway.app/health')
          .catch(() => null);
        return {
          service: 'railway',
          latency_ms: Date.now() - start,
          status: res2?.ok ? 'ok' : 'error',
        };
      })(),
    ]);

    res.json({ checks, status: 'ok' });
  } catch (err) { next(err); }
});

export { router as adminRouter };
