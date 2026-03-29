// ============================================================
// src/modules/billing/api/billing.routes.ts
//
// FIXES:
//   1. Stripe webhook: idempotency check op stripe_sub_id
//      zodat dubbele delivery geen duplicate subscriptions maakt
//   2. tenants.plan_slug wordt synchroon bijgewerkt bij alle
//      webhook events zodat die kolom nooit afwijkt van
//      tenant_subscriptions (de echte bron van waarheid)
//   3. customer.subscription.updated invalideert de plan cache
//      zodat plan-wijzigingen direct doorwerken zonder re-login
// ============================================================

import { Router, Request, Response, NextFunction } from 'express';
import Stripe from 'stripe';
import { db }              from '../../../infrastructure/database/connection';
import { cache }           from '../../../infrastructure/cache/redis';
import { getTenantContext } from '../../../shared/middleware/tenant-context';
import { tenantMiddleware } from '../../../shared/middleware/tenant.middleware';
import { permissionService } from '../../../shared/permissions/permission.service';
import { logger }          from '../../../shared/logging/logger';

const router = Router();

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY ?? '', {
  apiVersion: '2023-10-16',
});

const RESEND_KEY = process.env.RESEND_API_KEY ?? '';
const APP_URL    = process.env.APP_URL ?? process.env.FRONTEND_URL ?? 'https://marketgrow.ai';

const PLAN_PRICE_IDS: Record<string, string> = {
  starter: process.env.STRIPE_PRICE_STARTER ?? '',
  growth:  process.env.STRIPE_PRICE_GROWTH  ?? '',
  scale:   process.env.STRIPE_PRICE_SCALE   ?? '',
};
// ── Timestamp helper — voorkomt PostgreSQL crash ──────────────
// Stripe geeft current_period_end als Unix integer (seconden).
// Forceer parseInt zodat floats of strings geen issue geven.
function stripeTimestampTo(ts: number | null | undefined):  {
  if (!ts) return new Date(Date.now() + 30 * 24 * 3600 * 1000); // fallback: +30 dagen
  return new Date(parseInt(String(ts), 10) * 1000);
}
// ── Email via fetch (geen resend package nodig) ───────────────
async function sendEmail(to: string, subject: string, html: string): Promise<void> {
  if (!RESEND_KEY) return;
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method:  'POST',
      headers: { 'Authorization': `Bearer ${RESEND_KEY}`, 'Content-Type': 'application/json' },
      body:    JSON.stringify({ from: 'MarketGrow <hello@marketgrow.ai>', to: [to], subject, html }),
    });
    if (!res.ok) logger.warn('email.send.failed', { to, status: res.status });
  } catch (err) {
    logger.error('email.send.error', { to, error: (err as Error).message });
  }
}

async function invalidatePlanCache(tenantId: string): Promise<void> {
  try {
    await cache.del(`perm:plan:${tenantId}`);
    await permissionService.invalidateTenantCache(tenantId);
  } catch {
    // Cache invalidatie niet kritiek — gaat vanzelf verlopen
  }
}

async function sendWelcomeEmail(email: string, firstName: string, planSlug: string): Promise<void> {
  await sendEmail(
    email,
    'Welcome to MarketGrow — your 14-day trial has started',
    `<p>Hi ${firstName},</p><p>Your ${planSlug} trial is active. Connect your first store to get started.</p><p><a href="${APP_URL}/dashboard/integrations">Connect your store →</a></p>`
  );
}

async function sendAdminSignupNotification(tenantId: string, planSlug: string): Promise<void> {
  const adminEmail = process.env.ADMIN_EMAIL ?? 'hello@marketgrow.ai';
  await sendEmail(
    adminEmail,
    `New signup — ${planSlug} plan`,
    `<p>New tenant signed up.</p><p>Tenant ID: ${tenantId}<br>Plan: ${planSlug}</p>`
  );
  logger.info('email.admin_signup.sent', { tenantId, planSlug });
}

// ── POST /api/billing/checkout ────────────────────────────────
router.post('/checkout', tenantMiddleware(), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { tenantId } = getTenantContext();
    const { planSlug } = req.body as { planSlug: string };

    const priceId = PLAN_PRICE_IDS[planSlug];
    if (!priceId) { res.status(400).json({ error: 'Invalid plan' }); return; }

    const tenantResult = await db.query<{ email: string; name: string; stripe_customer_id: string | null }>(
      `SELECT email, name, stripe_customer_id FROM tenants WHERE id = $1`,
      [tenantId], { allowNoTenant: true }
    );
    const tenant = tenantResult.rows[0];
    if (!tenant) { res.status(404).json({ error: 'Tenant not found' }); return; }

    let customerId = tenant.stripe_customer_id;
    if (!customerId) {
      const customer = await stripe.customers.create({ email: tenant.email, name: tenant.name, metadata: { tenantId } });
      customerId = customer.id;
      await db.query(`UPDATE tenants SET stripe_customer_id = $2 WHERE id = $1`, [tenantId, customerId], { allowNoTenant: true });
    }

    const session = await stripe.checkout.sessions.create({
      customer:   customerId,
      mode:       'subscription',
      line_items: [{ price: priceId, quantity: 1 }],
      subscription_data: { trial_period_days: 14, metadata: { tenantId, planSlug } },
      success_url: `${APP_URL}/onboarding?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url:  `${APP_URL}/onboarding`,
      metadata:    { tenantId, planSlug },
      allow_promotion_codes: true,
    });

    logger.info('billing.checkout.created', { tenantId, planSlug });
    res.json({ url: session.url });
  } catch (err) { next(err); }
});

// ── POST /api/billing/change-plan ────────────────────────────
router.post('/change-plan', tenantMiddleware(), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { tenantId } = getTenantContext();
    const { planSlug: newPlanSlug } = req.body as { planSlug: string };

    const priceId = PLAN_PRICE_IDS[newPlanSlug];
    if (!priceId) { res.status(400).json({ error: 'Invalid plan' }); return; }

    const subResult = await db.query<{ stripe_sub_id: string; plan_slug: string }>(
      `SELECT ts.stripe_sub_id, p.slug AS plan_slug
       FROM tenant_subscriptions ts JOIN plans p ON p.id = ts.plan_id
       WHERE ts.tenant_id = $1 AND ts.status IN ('active','trialing') LIMIT 1`,
      [tenantId], { allowNoTenant: true }
    );

    const currentSub = subResult.rows[0];
    if (!currentSub?.stripe_sub_id) { res.status(400).json({ error: 'Geen actief abonnement gevonden.' }); return; }

    const subscription = await stripe.subscriptions.retrieve(currentSub.stripe_sub_id);
    await stripe.subscriptions.update(currentSub.stripe_sub_id, {
      items: [{ id: subscription.items.data[0].id, price: priceId }],
      proration_behavior: 'create_prorations',
    });

    // Direct bijwerken — niet wachten op webhook
    await db.query(
      `UPDATE tenant_subscriptions SET plan_id = (SELECT id FROM plans WHERE slug = $2), updated_at = now()
       WHERE tenant_id = $1`,
      [tenantId, newPlanSlug], { allowNoTenant: true }
    );
    await db.query(
      `UPDATE tenants SET plan_slug = $2, updated_at = now() WHERE id = $1`,
      [tenantId, newPlanSlug], { allowNoTenant: true }
    );

    await invalidatePlanCache(tenantId);

    logger.info('billing.plan.changed', { tenantId, oldPlan: currentSub.plan_slug, newPlan: newPlanSlug });
    res.json({ success: true, planSlug: newPlanSlug });
  } catch (err) { next(err); }
});

// ── GET /api/billing/overview ─────────────────────────────────
router.get('/overview', tenantMiddleware(), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { tenantId } = getTenantContext();

    const subResult = await db.query<{
      plan_slug: string; status: string; current_period_end: Date;
    }>(
      `SELECT p.slug AS plan_slug, ts.status, ts.current_period_end
       FROM tenant_subscriptions ts JOIN plans p ON p.id = ts.plan_id
       WHERE ts.tenant_id = $1 AND ts.status IN ('active', 'trialing', 'past_due')
       ORDER BY ts.created_at DESC LIMIT 1`,
      [tenantId], { allowNoTenant: true }
    );

    const sub = subResult.rows[0];
    if (!sub) {
      res.json({ planSlug: 'starter', planName: 'Starter', status: 'trialing', currentPeriodEnd: null, cancelAtPeriodEnd: false, invoices: [] });
      return;
    }

    let invoices: any[] = [];
    try {
      const tenantResult = await db.query<{ stripe_customer_id: string }>(
        `SELECT stripe_customer_id FROM tenants WHERE id = $1`, [tenantId], { allowNoTenant: true }
      );
      const customerId = tenantResult.rows[0]?.stripe_customer_id;
      if (customerId) {
        const stripeInvoices = await stripe.invoices.list({ customer: customerId, limit: 12 });
        invoices = stripeInvoices.data.map(inv => ({
          id: inv.id, date: new Date(inv.created * 1000), amount: inv.amount_paid / 100,
          currency: inv.currency.toUpperCase(), status: inv.status ?? 'unknown', downloadUrl: inv.invoice_pdf ?? null,
        }));
      }
    } catch {}

    const planNames: Record<string, string> = { starter: 'Starter', growth: 'Growth', scale: 'Scale' };

    res.json({
      planSlug:          sub.plan_slug,
      planName:          planNames[sub.plan_slug] ?? sub.plan_slug,
      status:            sub.status,
      currentPeriodEnd:  sub.current_period_end,
      cancelAtPeriodEnd: false,
      invoices,
    });
  } catch (err) { next(err); }
});

// ── POST /api/billing/portal ──────────────────────────────────
router.post('/portal', tenantMiddleware(), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { tenantId } = getTenantContext();
    const result = await db.query<{ stripe_customer_id: string }>(
      `SELECT stripe_customer_id FROM tenants WHERE id = $1`, [tenantId], { allowNoTenant: true }
    );
    const customerId = result.rows[0]?.stripe_customer_id;
    if (!customerId) { res.status(400).json({ error: 'No Stripe customer found' }); return; }

    const session = await stripe.billingPortal.sessions.create({
      customer:   customerId,
      return_url: `${APP_URL}/settings?tab=billing`,
    });
    res.json({ url: session.url });
  } catch (err) { next(err); }
});

// ── POST /api/billing/webhook ─────────────────────────────────
router.post('/webhook', async (req: Request, res: Response, next: NextFunction) => {
  const sig    = req.headers['stripe-signature'];
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!sig || !secret) { res.status(400).json({ error: 'Webhook config missing' }); return; }

  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, secret);
  } catch {
    res.status(400).json({ error: 'Invalid webhook signature' });
    return;
  }

  logger.info('billing.webhook.received', { type: event.type });

  try {
    // ── checkout.session.completed ────────────────────────────
    if (event.type === 'checkout.session.completed') {
      const session  = event.data.object as Stripe.Checkout.Session;
      const tenantId = session.metadata?.tenantId;
      const planSlug = session.metadata?.planSlug ?? 'starter';
      if (!tenantId) { res.json({ received: true }); return; }

      const stripeSubId = session.subscription as string;

      // ── IDEMPOTENCY CHECK: voorkom duplicate subscriptions ──
      if (stripeSubId) {
        const existing = await db.query(
          `SELECT id FROM tenant_subscriptions WHERE stripe_sub_id = $1`,
          [stripeSubId], { allowNoTenant: true }
        );
        if (existing.rows.length > 0) {
          logger.info('billing.webhook.duplicate_ignored', { stripeSubId, tenantId });
          res.json({ received: true });
          return;
        }
      }

      let status    = 'trialing';
      let periodEnd = new Date(Date.now() + 14 * 86400000);

      if (stripeSubId) {
        try {
          const stripeSub = await stripe.subscriptions.retrieve(stripeSubId);
          status    = stripeSub.status;
          periodEnd = stripeTimestampToDate(sub.current_period_end);
        } catch {}
      }

      // Update tenants tabel (inclusief plan_slug sync)
      await db.query(
        `UPDATE tenants
         SET stripe_customer_id = $2,
             stripe_subscription_id = $3,
             plan_slug = $4,
             billing_status = 'active',
             updated_at = now()
         WHERE id = $1`,
        [tenantId, session.customer, session.subscription, planSlug],
        { allowNoTenant: true }
      );

      // Upsert subscription record
      await db.query(
        `INSERT INTO tenant_subscriptions (tenant_id, plan_id, stripe_sub_id, status, current_period_end)
         VALUES ($1, (SELECT id FROM plans WHERE slug = $2), $3, $4, $5)
         ON CONFLICT (tenant_id) DO UPDATE SET
           plan_id             = EXCLUDED.plan_id,
           stripe_sub_id       = EXCLUDED.stripe_sub_id,
           status              = EXCLUDED.status,
           current_period_end  = EXCLUDED.current_period_end,
           updated_at          = now()`,
        [tenantId, planSlug, stripeSubId, status, periodEnd],
        { allowNoTenant: true }
      );

      await invalidatePlanCache(tenantId);

      logger.info('billing.webhook.checkout_completed', { tenantId, planSlug, status });

      const userResult = await db.query<{ email: string; first_name: string }>(
        `SELECT email, first_name FROM users WHERE tenant_id = $1 AND role = 'owner' LIMIT 1`,
        [tenantId], { allowNoTenant: true }
      );
      const user = userResult.rows[0];
      if (user) {
        sendWelcomeEmail(user.email, user.first_name || 'there', planSlug).catch(() => {});
        sendAdminSignupNotification(tenantId, planSlug).catch(() => {});
      }
    }

    // ── customer.subscription.updated ─────────────────────────
    if (event.type === 'customer.subscription.updated') {
      const sub      = event.data.object as Stripe.Subscription;
      const tenantId = sub.metadata?.tenantId;
      if (tenantId) {
        // Haal planSlug op via price ID
        const priceId    = sub.items.data[0]?.price?.id;
        const planSlug   = Object.entries(PLAN_PRICE_IDS).find(([, id]) => id === priceId)?.[0] ?? null;
        const periodEnd  = stripeTimestampToDate(sub.current_period_end);

        await db.query(
          `UPDATE tenant_subscriptions
           SET status             = $2,
               current_period_end = $3,
               ${planSlug ? 'plan_id = (SELECT id FROM plans WHERE slug = $4),' : ''}
               updated_at         = now()
           WHERE tenant_id = $1`,
          planSlug
            ? [tenantId, sub.status, periodEnd, planSlug]
            : [tenantId, sub.status, periodEnd],
          { allowNoTenant: true }
        );

        if (planSlug) {
          await db.query(
            `UPDATE tenants SET plan_slug = $2, updated_at = now() WHERE id = $1`,
            [tenantId, planSlug], { allowNoTenant: true }
          );
        }

        await invalidatePlanCache(tenantId);
        logger.info('billing.webhook.subscription_updated', { tenantId, status: sub.status, planSlug });
      }
    }

    // ── customer.subscription.deleted ─────────────────────────
    if (event.type === 'customer.subscription.deleted') {
      const sub      = event.data.object as Stripe.Subscription;
      const tenantId = sub.metadata?.tenantId;
      if (tenantId) {
        await db.query(
          `UPDATE tenant_subscriptions SET status = 'cancelled', updated_at = now() WHERE tenant_id = $1`,
          [tenantId], { allowNoTenant: true }
        );
        await db.query(
          `UPDATE tenants SET plan_slug = 'starter', billing_status = 'cancelled', updated_at = now() WHERE id = $1`,
          [tenantId], { allowNoTenant: true }
        );
        await invalidatePlanCache(tenantId);
        logger.info('billing.webhook.subscription_deleted', { tenantId });
      }
    }

    // ── invoice.payment_failed ─────────────────────────────────
    if (event.type === 'invoice.payment_failed') {
      const invoice  = event.data.object as Stripe.Invoice;
      const tenantId = (invoice as any).subscription_details?.metadata?.tenantId
                    ?? (invoice as any).metadata?.tenantId;
      if (tenantId) {
        await db.query(
          `UPDATE tenant_subscriptions SET status = 'past_due', updated_at = now() WHERE tenant_id = $1`,
          [tenantId], { allowNoTenant: true }
        );
        await invalidatePlanCache(tenantId);
        logger.info('billing.webhook.payment_failed', { tenantId });
      }
    }

    res.json({ received: true });
  } catch (err) {
    logger.error('billing.webhook.error', { error: (err as Error).message });
    next(err);
  }
});

export { router as billingRouter };
