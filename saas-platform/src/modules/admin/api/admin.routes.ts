// ============================================================
// src/modules/admin/api/admin.routes.ts
//
// SECURITY OVERHAUL (vervangt eerdere versie volledig):
//   1. Geen meer accept van admin_token via URL query parameter
//   2. Header: x-admin-session (een per-sessie token, geen plaintext secret)
//   3. Sessie-tokens zijn opaque random strings, hash-opgeslagen in DB
//   4. Elke admin actie wordt gelogd in admin_audit_log
//   5. Impersonate: korter token, bevat impersonationLogId, e-mail naar tenant
//   6. Login & logout endpoints toegevoegd
// ============================================================

import { Router, Request, Response, NextFunction } from 'express';
import Stripe from 'stripe';
import jwt from 'jsonwebtoken';
import { db }    from '../../../infrastructure/database/connection';
import { cache } from '../../../infrastructure/cache/redis';
import { permissionService } from '../../../shared/permissions/permission.service';
import { logger } from '../../../shared/logging/logger';
import { adminSessionService, AdminSession } from '../service/admin-session.service';

const router = Router();

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
  apiVersion: '2023-10-16',
});

const PLAN_PRICE_IDS: Record<string, string> = {
  starter: process.env.STRIPE_PRICE_STARTER ?? '',
  growth:  process.env.STRIPE_PRICE_GROWTH  ?? '',
  scale:   process.env.STRIPE_PRICE_SCALE   ?? '',
};

const RESEND_KEY = process.env.RESEND_API_KEY ?? '';

// ── Helpers ──────────────────────────────────────────────────
function getRequestMeta(req: Request) {
  return {
    ip: (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim()
        ?? req.ip
        ?? req.socket?.remoteAddress
        ?? '',
    userAgent: req.headers['user-agent']?.substring(0, 500) ?? '',
  };
}

interface AuthedRequest extends Request {
  adminSession?: AdminSession;
}

// ── Login endpoint (NO auth required) ────────────────────────
// Plaintext ADMIN_SECRET goes in here, session token comes out.
router.post('/login', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { password } = req.body as { password?: string };
    const meta = getRequestMeta(req);

    if (typeof password !== 'string' || password.length === 0 || password.length > 500) {
      res.status(400).json({ error: 'Wachtwoord ontbreekt of ongeldig' });
      return;
    }

    const result = await adminSessionService.login(password, {
      ip: meta.ip,
      userAgent: meta.userAgent,
    });

    if (!result) {
      logger.warn('admin.login.failed', { ip: meta.ip });
      // Constant-time-ish delay to absorb brute-force timing
      await new Promise(r => setTimeout(r, 500));
      res.status(401).json({ error: 'Onjuist wachtwoord' });
      return;
    }

    await adminSessionService.auditLog({
      sessionId: result.session.id,
      action:    'admin.login',
      ip:        meta.ip,
      userAgent: meta.userAgent,
    });

    logger.info('admin.login.success', { sessionId: result.session.id, ip: meta.ip });

    res.json({
      token:     result.token,
      expiresAt: result.session.expiresAt.toISOString(),
    });
  } catch (err) { next(err); }
});

// ── Logout endpoint ──────────────────────────────────────────
router.post('/logout', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const token = req.headers['x-admin-session'] as string | undefined;
    if (token) {
      await adminSessionService.revoke(token);
    }
    res.json({ success: true });
  } catch (err) { next(err); }
});

// ── Session verify (lightweight) ─────────────────────────────
// Used by Vercel middleware to confirm a session is still valid.
router.get('/session', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const token = req.headers['x-admin-session'] as string | undefined;
    const session = await adminSessionService.verify(token ?? null);

    if (!session) {
      res.status(401).json({ valid: false });
      return;
    }

    res.json({
      valid:     true,
      expiresAt: session.expiresAt.toISOString(),
    });
  } catch (err) { next(err); }
});

// ── Admin auth middleware (replaces previous adminAuth) ──────
async function adminAuth(req: AuthedRequest, res: Response, next: NextFunction): Promise<void> {
  // Only the header is accepted. Query parameters are explicitly rejected.
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

// All routes below require a valid session
router.use(adminAuth);

// ============================================================
// GET /admin/kpis
// ============================================================
router.get('/kpis', async (req: AuthedRequest, res: Response, next: NextFunction) => {
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
      `SELECT COUNT(*) as count FROM tenant_subscriptions
       WHERE status = 'past_due'`,
      [], { allowNoTenant: true }
    );

    const totalNew = parseInt(newResult.rows[0]?.count || '0');
    const converted = totalNew - parseInt(churnResult.rows[0]?.count || '0');
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
router.get('/tenants', async (req: AuthedRequest, res: Response, next: NextFunction) => {
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
// ============================================================
router.post('/tenants/:id/change-plan', async (req: AuthedRequest, res: Response, next: NextFunction) => {
  try {
    const { id }       = req.params;
    const { planSlug } = req.body as { planSlug: string };
    const meta         = getRequestMeta(req);

    if (!planSlug || !['starter', 'growth', 'scale'].includes(planSlug)) {
      res.status(400).json({ error: 'Ongeldig plan' });
      return;
    }

    const subResult = await db.query<{ stripe_sub_id: string | null }>(
      `SELECT stripe_sub_id FROM tenant_subscriptions
       WHERE tenant_id = $1 LIMIT 1`,
      [id], { allowNoTenant: true }
    );

    const stripeSubId = subResult.rows[0]?.stripe_sub_id;
    const newPriceId  = PLAN_PRICE_IDS[planSlug];

    if (stripeSubId && newPriceId) {
      try {
        const subscription = await stripe.subscriptions.retrieve(stripeSubId);
        const itemId = subscription.items.data[0]?.id;

        if (itemId) {
          await stripe.subscriptions.update(stripeSubId, {
            items: [{ id: itemId, price: newPriceId }],
            proration_behavior: 'create_prorations',
          });
        }
      } catch (stripeErr: any) {
        logger.warn('admin.stripe.update_failed', { tenantId: id, error: stripeErr.message });
      }
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

    await adminSessionService.auditLog({
      sessionId: req.adminSession!.id,
      action:    'admin.tenant.plan_changed',
      resource:  'tenant',
      targetId:  id,
      ip:        meta.ip,
      userAgent: meta.userAgent,
      metadata:  { planSlug },
    });

    logger.info('admin.tenant.plan_changed', { tenantId: id, planSlug });
    res.json({ success: true });
  } catch (err) { next(err); }
});

// ============================================================
// POST /admin/tenants/:id/suspend
// ============================================================
router.post('/tenants/:id/suspend', async (req: AuthedRequest, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;
    const meta   = getRequestMeta(req);

    const subResult = await db.query<{ stripe_sub_id: string }>(
      `SELECT stripe_sub_id FROM tenant_subscriptions
       WHERE tenant_id = $1 AND status IN ('active', 'trialing') LIMIT 1`,
      [id], { allowNoTenant: true }
    );

    const stripeSubId = subResult.rows[0]?.stripe_sub_id;

    if (stripeSubId) {
      try {
        await stripe.subscriptions.cancel(stripeSubId);
        logger.info('admin.stripe.subscription_cancelled', { tenantId: id });
      } catch (stripeErr: any) {
        logger.warn('admin.stripe.cancel_failed', { tenantId: id, error: stripeErr.message });
      }
    }

    await db.query(
      `UPDATE tenants SET status = 'suspended', updated_at = now() WHERE id = $1`,
      [id], { allowNoTenant: true }
    );

    await db.query(
      `UPDATE tenant_subscriptions
       SET status = 'cancelled', updated_at = now()
       WHERE tenant_id = $1`,
      [id], { allowNoTenant: true }
    );

    await permissionService.invalidateTenantCache(id);
    await cache.invalidateTenant(id);

    await adminSessionService.auditLog({
      sessionId: req.adminSession!.id,
      action:    'admin.tenant.suspended',
      resource:  'tenant',
      targetId:  id,
      ip:        meta.ip,
      userAgent: meta.userAgent,
    });

    logger.info('admin.tenant.suspended', { tenantId: id });
    res.json({ success: true });
  } catch (err) { next(err); }
});

// ============================================================
// POST /admin/tenants/:id/reset-credits
// ============================================================
router.post('/tenants/:id/reset-credits', async (req: AuthedRequest, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;
    const meta   = getRequestMeta(req);

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

    await adminSessionService.auditLog({
      sessionId: req.adminSession!.id,
      action:    'admin.tenant.credits_reset',
      resource:  'tenant',
      targetId:  id,
      ip:        meta.ip,
      userAgent: meta.userAgent,
    });

    logger.info('admin.tenant.credits_reset', { tenantId: id });
    res.json({ success: true });
  } catch (err) { next(err); }
});

// ============================================================
// POST /admin/tenants/:id/impersonate
// SECURITY UPDATES:
//   - Korte expiry (15 min ipv 30)
//   - Reden verplicht
//   - Logged in admin_impersonation_log
//   - Tenant ontvangt e-mail bij impersonate (transparantie)
//   - Token bevat impersonationLogId voor traceerbaarheid
// ============================================================
router.post('/tenants/:id/impersonate', async (req: AuthedRequest, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;
    const { reason } = (req.body ?? {}) as { reason?: string };
    const meta = getRequestMeta(req);

    if (!reason || typeof reason !== 'string' || reason.trim().length < 5) {
      res.status(400).json({ error: 'Reason required (minimum 5 characters)' });
      return;
    }

    // Find the tenant owner (not just any user) for impersonation
    const result = await db.query<{ id: string; tenant_id: string; email: string; first_name: string; tenant_name: string }>(
      `SELECT u.id, u.tenant_id, u.email, u.first_name, t.name AS tenant_name
       FROM users u
       JOIN tenants t ON t.id = u.tenant_id
       WHERE u.tenant_id = $1
         AND u.status = 'active'
       ORDER BY (u.role = 'owner') DESC, u.created_at ASC
       LIMIT 1`,
      [id], { allowNoTenant: true }
    );

    const user = result.rows[0];
    if (!user) {
      res.status(404).json({ error: 'Geen gebruiker gevonden voor deze tenant' });
      return;
    }

    const expiresAtMs = Date.now() + 15 * 60 * 1000; // 15 minutes
    const expiresAt   = new Date(expiresAtMs);

    const impersonationLogId = await adminSessionService.logImpersonation({
      sessionId:           req.adminSession!.id,
      tenantId:            user.tenant_id,
      impersonatedUserId:  user.id,
      reason:              reason.trim().substring(0, 500),
      ip:                  meta.ip,
      expiresAt,
    });

    const token = jwt.sign(
      {
        userId:               user.id,
        tenantId:             user.tenant_id,
        impersonated:         true,
        impersonationLogId,
        adminSessionId:       req.adminSession!.id,
      },
      process.env.JWT_SECRET!,
      { expiresIn: '15m' }
    );

    await adminSessionService.auditLog({
      sessionId: req.adminSession!.id,
      action:    'admin.tenant.impersonate_started',
      resource:  'tenant',
      targetId:  user.tenant_id,
      ip:        meta.ip,
      userAgent: meta.userAgent,
      metadata:  { reason: reason.trim().substring(0, 200), userId: user.id, impersonationLogId },
    });

    // Notify the tenant by email (transparency)
    if (RESEND_KEY) {
      const fromEmail = 'security@marketgrow.ai';
      fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${RESEND_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          from: fromEmail,
          to: user.email,
          subject: 'MarketGrow support session started on your account',
          html: `
            <div style="font-family:sans-serif;max-width:560px;margin:0 auto;padding:24px;color:#374151">
              <h2 style="color:#111827">Hi ${user.first_name},</h2>
              <p>A MarketGrow support team member has started a temporary support session on your account
              <strong>${user.tenant_name}</strong>.</p>
              <p style="background:#fef3c7;border-left:3px solid #f59e0b;padding:12px;border-radius:4px">
                <strong>Reason:</strong> ${reason.trim().substring(0, 200).replace(/[<>]/g, '')}
              </p>
              <p>The session will automatically end in 15 minutes. All actions taken during this session
              are recorded in our audit log.</p>
              <p>If you did not request support help, please reply to this email immediately or contact
              <a href="mailto:hello@marketgrow.ai">hello@marketgrow.ai</a>.</p>
              <p style="color:#6b7280;font-size:13px;margin-top:24px">
                Reference: <code>${impersonationLogId}</code>
              </p>
            </div>
          `,
        }),
      }).catch(err => logger.warn('admin.impersonate.email_failed', { error: err.message }));
    }

    const appUrl = process.env.APP_URL || process.env.FRONTEND_URL || 'https://marketgrow.ai';
    logger.warn('admin.tenant.impersonated', {
      adminAction: true,
      tenantId: user.tenant_id,
      impersonationLogId,
      reason: reason.trim().substring(0, 200),
    });

    res.json({
      token,
      url: `${appUrl}/dashboard`,
      impersonationLogId,
      expiresAt: expiresAt.toISOString(),
    });
  } catch (err) { next(err); }
});

// ============================================================
// POST /admin/tenants/:id/end-impersonation
// Optional: explicit end (token still expires automatically)
// ============================================================
router.post('/tenants/:id/end-impersonation', async (req: AuthedRequest, res: Response, next: NextFunction) => {
  try {
    const { impersonationLogId } = (req.body ?? {}) as { impersonationLogId?: string };
    const meta = getRequestMeta(req);

    if (impersonationLogId) {
      await db.query(
        `UPDATE admin_impersonation_log
         SET ended_at = now()
         WHERE id = $1 AND ended_at IS NULL`,
        [impersonationLogId], { allowNoTenant: true }
      );
    }

    await adminSessionService.auditLog({
      sessionId: req.adminSession!.id,
      action:    'admin.tenant.impersonate_ended',
      resource:  'tenant',
      targetId:  req.params.id,
      ip:        meta.ip,
      userAgent: meta.userAgent,
      metadata:  { impersonationLogId },
    });

    res.json({ success: true });
  } catch (err) { next(err); }
});

// ============================================================
// GET /admin/audit-log
// View recent admin actions
// ============================================================
router.get('/audit-log', async (req: AuthedRequest, res: Response, next: NextFunction) => {
  try {
    const { limit = '100' } = req.query as { limit?: string };
    const lim = Math.min(parseInt(limit, 10) || 100, 500);

    const result = await db.query(
      `SELECT id, session_id, action, resource, target_id, ip_address, metadata, created_at
       FROM admin_audit_log
       ORDER BY created_at DESC
       LIMIT $1`,
      [lim], { allowNoTenant: true }
    );

    res.json({ entries: result.rows });
  } catch (err) { next(err); }
});

// ============================================================
// GET /admin/health/queue
// ============================================================
router.get('/health/queue', async (req: AuthedRequest, res: Response, next: NextFunction) => {
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
router.get('/health/db', async (req: AuthedRequest, res: Response, next: NextFunction) => {
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
router.get('/health/redis', async (req: AuthedRequest, res: Response, next: NextFunction) => {
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
