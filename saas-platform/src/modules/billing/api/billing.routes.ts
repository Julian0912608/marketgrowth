// ============================================================
// src/modules/billing/api/billing.routes.ts
// ============================================================

import { Router, Request, Response, NextFunction } from 'express';
import Stripe from 'stripe';
import { db }               from '../../../infrastructure/database/connection';
import { logger }           from '../../../shared/logging/logger';
import { getTenantContext } from '../../../shared/middleware/tenant-context';
import { tenantMiddleware } from '../../../shared/middleware/tenant.middleware';

const router = Router();
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY ?? '', { apiVersion: '2023-10-16' });

const PLAN_PRICE_IDS: Record<string, string> = {
  starter: process.env.STRIPE_PRICE_STARTER ?? '',
  growth:  process.env.STRIPE_PRICE_GROWTH  ?? '',
  scale:   process.env.STRIPE_PRICE_SCALE   ?? '',
};

const PLAN_PRICES: Record<string, string> = {
  starter: '€20/maand',
  growth:  '€49/maand',
  scale:   '€150/maand',
};

const APP_URL      = process.env.APP_URL      || process.env.FRONTEND_URL || 'https://marketgrow.ai';
const RESEND_KEY   = process.env.RESEND_API_KEY ?? '';

// ── Email helper ──────────────────────────────────────────────
async function sendEmail(to: string, subject: string, html: string): Promise<void> {
  if (!RESEND_KEY) return;
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method:  'POST',
      headers: { 'Authorization': `Bearer ${RESEND_KEY}`, 'Content-Type': 'application/json' },
      body:    JSON.stringify({ from: 'MarketGrow <hello@marketgrow.ai>', to: [to], subject, html }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      logger.warn('email.send.failed', { to, status: res.status, body: body.slice(0, 200) });
    }
  } catch (err) {
    logger.error('email.send.error', { to, error: (err as Error).message });
  }
}

// ── Welkomstmail naar klant ───────────────────────────────────
async function sendWelcomeEmail(email: string, firstName: string, planSlug: string): Promise<void> {
  const planName  = planSlug.charAt(0).toUpperCase() + planSlug.slice(1);
  const planPrice = PLAN_PRICES[planSlug] ?? '€49/maand';

  const html = `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#f8fafc;font-family:'Helvetica Neue',Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="padding:40px 20px;">
    <tr><td align="center">
      <table width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;">

        <tr>
          <td style="background:#0f172a;border-radius:16px 16px 0 0;padding:28px 36px;">
            <span style="color:#fff;font-size:18px;font-weight:800;">⚡ MarketGrow</span>
          </td>
        </tr>

        <tr>
          <td style="background:#1e293b;padding:32px 36px;">
            <h1 style="color:#fff;font-size:22px;margin:0 0 12px;">
              Welkom bij MarketGrow, ${firstName}! 🎉
            </h1>
            <p style="color:#94a3b8;font-size:14px;line-height:1.7;margin:0 0 20px;">
              Je ${planName} plan is actief. Je hebt 14 dagen gratis toegang — geen kosten totdat
              je trial afloopt.
            </p>

            <div style="background:#0f172a;border:1px solid #334155;border-radius:12px;padding:20px;margin-bottom:24px;">
              <p style="color:#64748b;font-size:11px;text-transform:uppercase;letter-spacing:0.05em;margin:0 0 8px;">Jouw plan</p>
              <p style="color:#fff;font-size:18px;font-weight:700;margin:0 0 4px;">${planName}</p>
              <p style="color:#4f46e5;font-size:13px;margin:0;">${planPrice} · 14 dagen gratis trial</p>
            </div>

            <p style="color:#94a3b8;font-size:14px;line-height:1.7;margin:0 0 24px;">
              De eerste stap is je webshop koppelen. Zodra je Bol.com, Shopify of een ander
              platform hebt verbonden, begint MarketGrow direct met het analyseren van je data
              en ontvang je je eerste AI-acties.
            </p>

            <a href="${APP_URL}/dashboard/integrations"
               style="display:inline-block;background:#4f46e5;color:#fff;font-weight:700;font-size:14px;padding:14px 32px;border-radius:10px;text-decoration:none;">
              Koppel je eerste winkel →
            </a>

            <div style="margin-top:32px;padding-top:24px;border-top:1px solid #334155;">
              <p style="color:#64748b;font-size:13px;margin:0 0 12px;">Vragen? We helpen je graag:</p>
              <a href="mailto:hello@marketgrow.ai" style="color:#4f46e5;font-size:13px;">hello@marketgrow.ai</a>
            </div>
          </td>
        </tr>

        <tr>
          <td style="background:#0f172a;border-radius:0 0 16px 16px;padding:16px 36px;text-align:center;">
            <p style="color:#475569;font-size:11px;margin:0;">
              © ${new Date().getFullYear()} MarketGrow · marketgrow.ai
            </p>
          </td>
        </tr>

      </table>
    </td></tr>
  </table>
</body>
</html>`;

  await sendEmail(email, `Welkom bij MarketGrow — je ${planName} trial is actief 🎉`, html);
  logger.info('email.welcome.sent', { email, planSlug });
}

// ── Admin signup notificatie ──────────────────────────────────
async function sendAdminSignupNotification(tenantId: string, planSlug: string): Promise<void> {
  try {
    // Haal klantinfo op
    const result = await db.query<{
      email: string; first_name: string; last_name: string; name: string;
    }>(
      `SELECT u.email, u.first_name, u.last_name, t.name
       FROM users u
       JOIN tenants t ON t.id = u.tenant_id
       WHERE u.tenant_id = $1 AND u.role = 'owner'
       LIMIT 1`,
      [tenantId], { allowNoTenant: true }
    );

    const user = result.rows[0];
    if (!user) return;

    // Haal totaal MRR en klanten op
    const statsResult = await db.query<{ total_customers: string; mrr: string }>(
      `SELECT
         COUNT(*)::int                                             AS total_customers,
         COALESCE(SUM(
           CASE p.slug
             WHEN 'starter' THEN 20
             WHEN 'growth'  THEN 49
             WHEN 'scale'   THEN 150
             ELSE 0
           END
         ), 0)                                                     AS mrr
       FROM tenant_subscriptions ts
       JOIN plans p ON p.id = ts.plan_id
       WHERE ts.status IN ('active', 'trialing')`,
      [], { allowNoTenant: true }
    );

    const stats     = statsResult.rows[0];
    const planName  = planSlug.charAt(0).toUpperCase() + planSlug.slice(1);
    const planPrice = PLAN_PRICES[planSlug] ?? '€49/maand';

    const html = `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#f8fafc;font-family:'Helvetica Neue',Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="padding:40px 20px;">
    <tr><td align="center">
      <table width="520" cellpadding="0" cellspacing="0" style="max-width:520px;width:100%;">

        <tr>
          <td style="background:#0f172a;border-radius:16px 16px 0 0;padding:24px 32px;">
            <span style="color:#10b981;font-size:16px;font-weight:800;">🎉 Nieuwe signup!</span>
          </td>
        </tr>

        <tr>
          <td style="background:#1e293b;padding:28px 32px;">
            <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:20px;">
              <tr>
                <td style="background:#0f172a;border:1px solid #334155;border-radius:10px;padding:16px;text-align:center;width:48%;">
                  <div style="color:#64748b;font-size:11px;margin-bottom:4px;">Klant</div>
                  <div style="color:#fff;font-size:14px;font-weight:600;">${user.first_name} ${user.last_name}</div>
                  <div style="color:#64748b;font-size:11px;">${user.email}</div>
                </td>
                <td width="4%"></td>
                <td style="background:#0f172a;border:1px solid #334155;border-radius:10px;padding:16px;text-align:center;width:48%;">
                  <div style="color:#64748b;font-size:11px;margin-bottom:4px;">Plan</div>
                  <div style="color:#4f46e5;font-size:14px;font-weight:600;">${planName}</div>
                  <div style="color:#64748b;font-size:11px;">${planPrice}</div>
                </td>
              </tr>
            </table>

            <table width="100%" cellpadding="0" cellspacing="0">
              <tr>
                <td style="background:#0f172a;border:1px solid #334155;border-radius:10px;padding:16px;text-align:center;width:48%;">
                  <div style="color:#64748b;font-size:11px;margin-bottom:4px;">Totaal klanten</div>
                  <div style="color:#fff;font-size:20px;font-weight:700;">${stats.total_customers}</div>
                </td>
                <td width="4%"></td>
                <td style="background:#0f172a;border:1px solid #334155;border-radius:10px;padding:16px;text-align:center;width:48%;">
                  <div style="color:#64748b;font-size:11px;margin-bottom:4px;">MRR</div>
                  <div style="color:#10b981;font-size:20px;font-weight:700;">€${stats.mrr}</div>
                </td>
              </tr>
            </table>

            <div style="margin-top:20px;text-align:center;">
              <a href="${APP_URL}/admin"
                 style="display:inline-block;background:#1e40af;color:#fff;font-size:13px;font-weight:600;padding:10px 24px;border-radius:8px;text-decoration:none;">
                Bekijk in admin dashboard →
              </a>
            </div>
          </td>
        </tr>

        <tr>
          <td style="background:#0f172a;border-radius:0 0 16px 16px;padding:12px 32px;text-align:center;">
            <p style="color:#475569;font-size:11px;margin:0;">MarketGrow Admin</p>
          </td>
        </tr>

      </table>
    </td></tr>
  </table>
</body>
</html>`;

    await sendEmail('hello@marketgrow.ai', `🎉 Nieuwe signup: ${user.first_name} ${user.last_name} (${planName})`, html);
    logger.info('email.admin_signup.sent', { tenantId, planSlug });
  } catch (err) {
    logger.error('email.admin_signup.failed', { tenantId, error: (err as Error).message });
  }
}

// ── POST /api/billing/checkout ────────────────────────────────
router.post('/checkout', tenantMiddleware(), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { tenantId } = getTenantContext();
    const { planSlug } = req.body as { planSlug: string };

    const priceId = PLAN_PRICE_IDS[planSlug];
    if (!priceId) {
      res.status(400).json({ error: 'Ongeldig plan' });
      return;
    }

    const tenantResult = await db.query<{ email: string; name: string; stripe_customer_id: string | null }>(
      `SELECT email, name, stripe_customer_id FROM tenants WHERE id = $1`,
      [tenantId], { allowNoTenant: true }
    );
    const tenant = tenantResult.rows[0];
    if (!tenant) { res.status(404).json({ error: 'Tenant niet gevonden' }); return; }

    let customerId = tenant.stripe_customer_id;
    if (!customerId) {
      const customer = await stripe.customers.create({
        email:    tenant.email,
        name:     tenant.name,
        metadata: { tenantId },
      });
      customerId = customer.id;
      await db.query(
        `UPDATE tenants SET stripe_customer_id = $2 WHERE id = $1`,
        [tenantId, customerId], { allowNoTenant: true }
      );
    }

    const session = await stripe.checkout.sessions.create({
      customer:   customerId,
      mode:       'subscription',
      line_items: [{ price: priceId, quantity: 1 }],
      subscription_data: {
        trial_period_days: 14,
        metadata: { tenantId, planSlug },
      },
      success_url: `${APP_URL}/onboarding?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url:  `${APP_URL}/onboarding`,
      metadata:    { tenantId, planSlug },
      allow_promotion_codes: true,
    });

    logger.info('billing.checkout.created', { tenantId, planSlug });
    res.json({ url: session.url });
  } catch (err) { next(err); }
});

// ── GET /api/billing/overview ─────────────────────────────────
router.get('/overview', tenantMiddleware(), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { tenantId } = getTenantContext();

    const subResult = await db.query<{
      plan_slug: string; status: string; current_period_end: Date; stripe_sub_id: string;
    }>(
      `SELECT p.slug AS plan_slug, ts.status, ts.current_period_end, ts.stripe_sub_id
       FROM tenant_subscriptions ts
       JOIN plans p ON p.id = ts.plan_id
       WHERE ts.tenant_id = $1 AND ts.status IN ('active', 'trialing', 'past_due')
       ORDER BY ts.created_at DESC LIMIT 1`,
      [tenantId], { allowNoTenant: true }
    );

    const sub = subResult.rows[0];
    if (!sub) {
      res.json({ planSlug: 'starter', status: 'trialing', currentPeriodEnd: null, invoices: [] });
      return;
    }

    // Haal invoices op via Stripe
    let invoices: any[] = [];
    try {
      const tenantResult = await db.query<{ stripe_customer_id: string }>(
        `SELECT stripe_customer_id FROM tenants WHERE id = $1`,
        [tenantId], { allowNoTenant: true }
      );
      const customerId = tenantResult.rows[0]?.stripe_customer_id;
      if (customerId) {
        const stripeInvoices = await stripe.invoices.list({ customer: customerId, limit: 12 });
        invoices = stripeInvoices.data.map(inv => ({
          id:          inv.id,
          date:        new Date(inv.created * 1000),
          amount:      inv.amount_paid / 100,
          currency:    inv.currency.toUpperCase(),
          status:      inv.status ?? 'unknown',
          downloadUrl: inv.invoice_pdf ?? null,
        }));
      }
    } catch {}

    res.json({
      planSlug:         sub.plan_slug,
      status:           sub.status,
      currentPeriodEnd: sub.current_period_end,
      invoices,
    });
  } catch (err) { next(err); }
});

// ── POST /api/billing/portal ──────────────────────────────────
router.post('/portal', tenantMiddleware(), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { tenantId } = getTenantContext();
    const result = await db.query<{ stripe_customer_id: string }>(
      `SELECT stripe_customer_id FROM tenants WHERE id = $1`,
      [tenantId], { allowNoTenant: true }
    );
    const customerId = result.rows[0]?.stripe_customer_id;
    if (!customerId) { res.status(400).json({ error: 'Geen Stripe klant gevonden' }); return; }

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

  if (!sig || !secret) {
    res.status(400).json({ error: 'Webhook configuratie ontbreekt' });
    return;
  }

  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, secret);
  } catch {
    res.status(400).json({ error: 'Ongeldige webhook signature' });
    return;
  }

  logger.info('billing.webhook.received', { type: event.type });

  try {
    if (event.type === 'checkout.session.completed') {
      const session  = event.data.object as Stripe.Checkout.Session;
      const tenantId = session.metadata?.tenantId;
      const planSlug = session.metadata?.planSlug ?? 'starter';

      if (!tenantId) {
        res.json({ received: true });
        return;
      }

      // Update tenant subscriptions
      const stripeSubId = session.subscription as string;
      let status = 'trialing';
      let periodEnd = new Date(Date.now() + 14 * 86400000);

      if (stripeSubId) {
        try {
          const stripeSub = await stripe.subscriptions.retrieve(stripeSubId);
          status    = stripeSub.status;
          periodEnd = new Date(stripeSub.current_period_end * 1000);
        } catch {}
      }

      await db.query(
        `UPDATE tenants SET
           stripe_customer_id = $2,
           stripe_subscription_id = $3,
           plan_slug = $4,
           billing_status = 'active',
           updated_at = now()
         WHERE id = $1`,
        [tenantId, session.customer, session.subscription, planSlug],
        { allowNoTenant: true }
      );

      await db.query(
        `INSERT INTO tenant_subscriptions (tenant_id, plan_id, stripe_sub_id, status, current_period_end)
         VALUES ($1, (SELECT id FROM plans WHERE slug = $2), $3, $4, $5)
         ON CONFLICT (tenant_id) DO UPDATE SET
           plan_id = EXCLUDED.plan_id,
           stripe_sub_id = EXCLUDED.stripe_sub_id,
           status = EXCLUDED.status,
           current_period_end = EXCLUDED.current_period_end,
           updated_at = now()`,
        [tenantId, planSlug, stripeSubId, status, periodEnd],
        { allowNoTenant: true }
      );

      logger.info('billing.webhook.checkout_completed', { tenantId, planSlug, status });

      // Haal klantgegevens op voor emails
      const userResult = await db.query<{ email: string; first_name: string }>(
        `SELECT email, first_name FROM users WHERE tenant_id = $1 AND role = 'owner' LIMIT 1`,
        [tenantId], { allowNoTenant: true }
      );
      const user = userResult.rows[0];

      if (user) {
        // Welkomstmail naar klant (fire and forget)
        sendWelcomeEmail(user.email, user.first_name || 'daar', planSlug).catch(err =>
          logger.error('welcome.email.failed', { tenantId, error: err.message })
        );

        // Admin signup notificatie (fire and forget)
        sendAdminSignupNotification(tenantId, planSlug).catch(err =>
          logger.error('admin.signup.email.failed', { tenantId, error: err.message })
        );
      }
    }

    if (event.type === 'customer.subscription.updated') {
      const sub      = event.data.object as Stripe.Subscription;
      const tenantId = sub.metadata?.tenantId;
      if (tenantId) {
        await db.query(
          `UPDATE tenant_subscriptions
           SET status = $2, current_period_end = $3, updated_at = now()
           WHERE tenant_id = $1`,
          [tenantId, sub.status, new Date(sub.current_period_end * 1000)],
          { allowNoTenant: true }
        );
        logger.info('billing.webhook.subscription_updated', { tenantId, status: sub.status });
      }
    }

    if (event.type === 'customer.subscription.deleted') {
      const sub      = event.data.object as Stripe.Subscription;
      const tenantId = sub.metadata?.tenantId;
      if (tenantId) {
        await db.query(
          `UPDATE tenant_subscriptions SET status = 'cancelled', updated_at = now()
           WHERE tenant_id = $1`,
          [tenantId], { allowNoTenant: true }
        );
        logger.info('billing.webhook.subscription_deleted', { tenantId });
      }
    }

    res.json({ received: true });
  } catch (err) {
    logger.error('billing.webhook.error', { error: (err as Error).message });
    next(err);
  }
});

export { router as billingRouter };
