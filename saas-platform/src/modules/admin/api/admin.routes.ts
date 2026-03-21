// ============================================================
// src/modules/admin/api/admin.routes.ts
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

const PLAN_PRICE_IDS: Record<string, string> = {
  starter: process.env.STRIPE_PRICE_STARTER ?? '',
  growth:  process.env.STRIPE_PRICE_GROWTH  ?? '',
  scale:   process.env.STRIPE_PRICE_SCALE   ?? '',
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

    const statusResult = await db.query<{ status: string; count: string }>(
      `SELECT status, COUNT(*) as count
       FROM tenant_subscriptions
       WHERE status IN ('active', 'trialing', 'past_due')
       GROUP BY status`,
      [], { allowNoTenant: true }
    );

    const mrrByPlan: Record<string, number> = { starter: 0, growth: 0, scale: 0 };
    let activeTenants   = 0;
    let trialingTenants = 0;
    let totalMRR        = 0;

    for (const row of statusResult.rows) {
      if (row.status === 'active')   activeTenants   = parseInt(row.count);
      if (row.status === 'trialing') trialingTenants = parseInt(row.count);
    }

    for (const row of mrrResult.rows) {
      const mrr = parseInt(row.mrr_cents || '0') / 100;
      mrrByPlan[row.plan_slug] = mrr;
      totalMRR += mrr;
    }

    const newResult = await db.query<{ count: string }>(
      `SELECT COUNT(*) as count FROM tenants
       WHERE created_at > now() - INTERVAL '30 days'`,
      [], { allowNoTenant: true }
    );

    const churnResult = await db.query<{ count: string }>(
      `SELECT COUNT(*) as count FROM tenant_subscriptions
       WHERE status = 'cancelled'
         AND updated_at > now() - INTERVAL '30 days'`,
      [], { allowNoTenant: true }
    );

    const pastDueResult = await db.query<{ count: string }>(
      `SELECT COUNT(*) as count FROM tenant_subscriptions WHERE status = 'past_due'`,
      [], { allowNoTenant: true }
    );

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
      mrr_growth:       0,
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
         ts.stripe_sub_id,
         COALESCE(p.monthly_price_cents, 0) AS mrr_cents,
         (SELECT COUNT(*) FROM tenant_integrations ti WHERE ti.tenant_id = t.id AND ti.status = 'active') AS integrations,
         COALESCE(fu.usage_count, 0) AS ai_credits_used,
         ul.limit_value              AS ai_credits_limit,
         NULL::timestamptz           AS last_active_at
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
// Wijzigt plan in DB + Stripe
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

    // Haal huidige Stripe subscription op
    const subResult = await db.query<{ stripe_sub_id: string }>(
      `SELECT stripe_sub_id FROM tenant_subscriptions
       WHERE tenant_id = $1 AND status IN ('active', 'trialing') LIMIT 1`,
      [id], { allowNoTenant: true }
    );

    const stripeSubId = subResult.rows[0]?.stripe_sub_id;

    // Update Stripe als er een actieve subscription is en een price ID beschikbaar
    if (stripeSubId && priceId) {
      try {
        const subscription = await stripe.subscriptions.retrieve(stripeSubId);
        await stripe.subscriptions.update(stripeSubId, {
          items: [{ id: subscription.items.data[0].id, price: priceId }],
          proration_behavior: 'create_prorations',
        });
        logger.info('admin.stripe.plan_changed', { tenantId: id, planSlug });
      } catch (stripeErr: any) {
        // Log maar stop niet — DB update gaat altijd door
        logger.warn('admin.stripe.plan_change_failed', { tenantId: id, error: stripeErr.message });
      }
    }

    // Update database
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
// Schorst account op in DB + annuleert Stripe subscription
// ============================================================
router.post('/tenants/:id/suspend', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;

    // Haal Stripe subscription op
    const subResult = await db.query<{ stripe_sub_id: string }>(
      `SELECT stripe_sub_id FROM tenant_subscriptions
       WHERE tenant_id = $1 AND status IN ('active', 'trialing') LIMIT 1`,
      [id], { allowNoTenant: true }
    );

    const stripeSubId = subResult.rows[0]?.stripe_sub_id;

    // Annuleer Stripe subscription direct (niet einde periode)
    if (stripeSubId) {
      try {
        await stripe.subscriptions.cancel(stripeSubId);
        logger.info('admin.stripe.subscription_cancelled', { tenantId: id });
      } catch (stripeErr: any) {
        logger.warn('admin.stripe.cancel_failed', { tenantId: id, error: stripeErr.message });
      }
    }

    // Zet tenant op suspended
    await db.query(
      `UPDATE tenants SET status = 'suspended', updated_at = now() WHERE id = $1`,
      [id], { allowNoTenant: true }
    );

    // Zet subscription op cancelled
    await db.query(
      `UPDATE tenant_subscriptions
       SET status = 'cancelled', updated_at = now()
       WHERE tenant_id = $1`,
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

    const cacheKey = `usage:${id}:ai-recommendations`;
    await cache.del(cacheKey);

    logger.info('admin.tenant.credits_reset', { tenantId: id });
    res.json({ success: true });
  } catch (err) { next(err); }
});

// ============================================================
// POST /admin/tenants/:id/impersonate
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
      { userId: user.id, tenantId: user.tenant_id, impersonated: true },
      process.env.JWT_SECRET!,
      { expiresIn: '30m' }
    );

    const appUrl = process.env.APP_URL || 'https://marketgrow.ai';
    logger.warn('admin.tenant.impersonated', { adminAction: true, tenantId: id });

    res.json({ token, url: `${appUrl}/dashboard` });
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

    res.json({ waiting, active, completed, failed, status: 'ok' });
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

export { router as adminRouter };
