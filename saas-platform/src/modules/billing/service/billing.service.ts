// ============================================================
// src/modules/billing/service/billing.service.ts  (FIXED)
//
// Fixes:
//  1. onCheckoutCompleted: gebruik UPSERT zodat de starter-rij
//     (zonder stripe_sub_id) correct wordt bijgewerkt
//  2. changePlan: ook 'trialing' status meenemen
//  3. cancelSubscription: ook 'trialing' meenemen
//  4. getBillingOverview: robuuster wanneer stripe_sub_id nog null is
// ============================================================

import Stripe from 'stripe';
import { db } from '../../../infrastructure/database/connection';
import { getTenantContext } from '../../../shared/middleware/tenant-context';
import { permissionService } from '../../../shared/permissions/permission.service';
import { eventBus } from '../../../shared/events/event-bus';
import { logger } from '../../../shared/logging/logger';
import { cache } from '../../../infrastructure/cache/redis';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
  apiVersion: '2023-10-16',
});

const PLAN_PRICE_IDS: Record<string, string> = {
  starter: process.env.STRIPE_PRICE_STARTER ?? '',
  growth:  process.env.STRIPE_PRICE_GROWTH  ?? '',
  scale:   process.env.STRIPE_PRICE_SCALE   ?? '',
};

export interface CheckoutSession {
  url:       string;
  sessionId: string;
}

export interface BillingOverview {
  planSlug:          string;
  planName:          string;
  status:            string;
  currentPeriodEnd:  Date;
  cancelAtPeriodEnd: boolean;
  invoices:          Invoice[];
}

export interface Invoice {
  id:          string;
  date:        Date;
  amount:      number;
  currency:    string;
  status:      string;
  downloadUrl: string | null;
}

export class BillingService {

  // ── Checkout: klant kiest een plan en betaalt ────────────────
  async createCheckoutSession(planSlug: string): Promise<CheckoutSession> {
    const { tenantId, userId } = getTenantContext();

    const priceId = PLAN_PRICE_IDS[planSlug];
    if (!priceId) {
      throw new Error(`Onbekend plan: ${planSlug}`);
    }

    const stripeCustomerId = await this.getOrCreateStripeCustomer(tenantId);

    const session = await stripe.checkout.sessions.create({
      customer:   stripeCustomerId,
      mode:       'subscription',
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: `${process.env.APP_URL}/onboarding/payment-success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url:  `${process.env.APP_URL}/onboarding/plan`,
      metadata: {
        tenantId,
        userId,
        planSlug,
      },
      subscription_data: {
        metadata: { tenantId, planSlug },
      },
      allow_promotion_codes: true,
    });

    logger.info('billing.checkout.created', { tenantId, planSlug });

    return {
      url:       session.url!,
      sessionId: session.id,
    };
  }

  // ── Plan wijzigen (upgrade of downgrade) ────────────────────
  async changePlan(newPlanSlug: string): Promise<void> {
    const { tenantId } = getTenantContext();

    const priceId = PLAN_PRICE_IDS[newPlanSlug];
    if (!priceId) throw new Error(`Onbekend plan: ${newPlanSlug}`);

    // FIX: ook 'trialing' meenemen — klant kan vanuit trial upgraden
    const subResult = await db.query<{ stripe_sub_id: string; plan_slug: string }>(
      `SELECT ts.stripe_sub_id, p.slug AS plan_slug
       FROM tenant_subscriptions ts
       JOIN plans p ON p.id = ts.plan_id
       WHERE ts.tenant_id = $1 AND ts.status IN ('active', 'trialing')
       ORDER BY ts.created_at DESC
       LIMIT 1`,
      [tenantId], { allowNoTenant: true }
    );

    const currentSub = subResult.rows[0];

    // Als er nog geen stripe_sub_id is (starter zonder betaling),
    // maak dan een nieuwe checkout sessie in plaats van update
    if (!currentSub?.stripe_sub_id) {
      throw new Error(
        'Geen Stripe abonnement gevonden. Gebruik /billing/checkout om een abonnement te starten.'
      );
    }

    const subscription = await stripe.subscriptions.retrieve(currentSub.stripe_sub_id);
    await stripe.subscriptions.update(currentSub.stripe_sub_id, {
      items: [{
        id:    subscription.items.data[0].id,
        price: priceId,
      }],
      proration_behavior: 'create_prorations',
    });

    logger.info('billing.plan.changed', {
      tenantId,
      oldPlan: currentSub.plan_slug,
      newPlan: newPlanSlug,
    });

    await permissionService.invalidateTenantCache(tenantId);
    await cache.invalidateTenant(tenantId);
  }

  // ── Abonnement opzeggen ──────────────────────────────────────
  async cancelSubscription(): Promise<void> {
    const { tenantId } = getTenantContext();

    // FIX: ook 'trialing' meenemen
    const subResult = await db.query<{ stripe_sub_id: string }>(
      `SELECT stripe_sub_id FROM tenant_subscriptions
       WHERE tenant_id = $1 AND status IN ('active', 'trialing')
       ORDER BY created_at DESC LIMIT 1`,
      [tenantId], { allowNoTenant: true }
    );

    const stripeSubId = subResult.rows[0]?.stripe_sub_id;
    if (!stripeSubId) throw new Error('Geen actief abonnement gevonden.');

    await stripe.subscriptions.update(stripeSubId, {
      cancel_at_period_end: true,
    });

    logger.info('billing.subscription.cancelled', { tenantId });
  }

  // ── Factuur-overzicht ────────────────────────────────────────
  async getBillingOverview(): Promise<BillingOverview> {
    const { tenantId } = getTenantContext();
    const cacheKey = cache.key(tenantId, 'billing', 'overview');

    const cached = await cache.getJson<BillingOverview>(cacheKey);
    if (cached) return cached;

    const subResult = await db.query<{
      stripe_sub_id: string | null;
      plan_slug: string;
      plan_name: string;
      status: string;
      current_period_end: Date;
    }>(
      `SELECT ts.stripe_sub_id, p.slug AS plan_slug, p.name AS plan_name,
              ts.status, ts.current_period_end
       FROM tenant_subscriptions ts
       JOIN plans p ON p.id = ts.plan_id
       WHERE ts.tenant_id = $1 AND ts.status IN ('active','trialing','past_due')
       ORDER BY ts.created_at DESC LIMIT 1`,
      [tenantId], { allowNoTenant: true }
    );

    const sub = subResult.rows[0];
    if (!sub) throw new Error('Geen abonnement gevonden.');

    // FIX: alleen Stripe aanroepen als er een stripe_sub_id is
    const stripeCustomerId = await this.getOrCreateStripeCustomer(tenantId);

    const [stripeInvoices, stripeSub] = await Promise.all([
      stripe.invoices.list({ customer: stripeCustomerId, limit: 12 }),
      sub.stripe_sub_id
        ? stripe.subscriptions.retrieve(sub.stripe_sub_id)
        : Promise.resolve(null),
    ]);

    const overview: BillingOverview = {
      planSlug:          sub.plan_slug,
      planName:          sub.plan_name,
      status:            sub.status,
      currentPeriodEnd:  sub.current_period_end,
      cancelAtPeriodEnd: stripeSub?.cancel_at_period_end ?? false,
      invoices: stripeInvoices.data.map(inv => ({
        id:          inv.id,
        date:        new Date(inv.created * 1000),
        amount:      inv.amount_paid / 100,
        currency:    inv.currency.toUpperCase(),
        status:      inv.status ?? 'unknown',
        downloadUrl: inv.invoice_pdf ?? null,
      })),
    };

    await cache.setJson(cacheKey, overview, 300);
    return overview;
  }

  // ── Stripe webhook verwerking ────────────────────────────────
  async handleWebhook(payload: Buffer, signature: string): Promise<void> {
    let event: Stripe.Event;

    try {
      event = stripe.webhooks.constructEvent(
        payload,
        signature,
        process.env.STRIPE_WEBHOOK_SECRET!
      );
    } catch (err) {
      throw Object.assign(new Error('Webhook signature verificatie mislukt'), { httpStatus: 400 });
    }

    logger.info('billing.webhook.received', { type: event.type });

    switch (event.type) {
      case 'checkout.session.completed':
        await this.onCheckoutCompleted(event.data.object as Stripe.Checkout.Session);
        break;
      case 'customer.subscription.updated':
        await this.onSubscriptionUpdated(event.data.object as Stripe.Subscription);
        break;
      case 'customer.subscription.deleted':
        await this.onSubscriptionDeleted(event.data.object as Stripe.Subscription);
        break;
      case 'invoice.payment_failed':
        await this.onPaymentFailed(event.data.object as Stripe.Invoice);
        break;
      default:
        logger.debug('billing.webhook.unhandled', { type: event.type });
    }
  }

  // ── Private webhook handlers ─────────────────────────────────

  private async onCheckoutCompleted(session: Stripe.Checkout.Session): Promise<void> {
    const tenantId   = session.metadata?.tenantId;
    const planSlug   = session.metadata?.planSlug;
    const stripeSubId = session.subscription as string;

    if (!tenantId || !planSlug) {
      logger.warn('billing.checkout.missing_metadata', { sessionId: session.id });
      return;
    }

    // FIX: gebruik UPSERT-patroon.
    // De starter-rij (zonder stripe_sub_id) matcht op tenant_id.
    // We updaten die rij met het nieuwe plan + stripe_sub_id.
    // Als er om een of andere reden geen rij is, voegen we een nieuwe in.
    await db.query(
      `INSERT INTO tenant_subscriptions
         (tenant_id, plan_id, stripe_sub_id, status, current_period_start, current_period_end)
       SELECT
         $1,
         (SELECT id FROM plans WHERE slug = $2),
         $3,
         'active',
         now(),
         now() + INTERVAL '30 days'
       ON CONFLICT (tenant_id)
         -- Als er al een rij is (bv. de starter-rij), update die dan
         DO UPDATE SET
           plan_id       = EXCLUDED.plan_id,
           stripe_sub_id = EXCLUDED.stripe_sub_id,
           status        = 'active',
           updated_at    = now()`,
      [tenantId, planSlug, stripeSubId],
      { allowNoTenant: true }
    );

    // Onboarding stap afronden: zowel plan_selected als payment_completed
    await db.query(
      `UPDATE onboarding_progress
       SET current_step    = 'payment_completed',
           completed_steps = array_append(
             array_append(
               completed_steps,
               'plan_selected'
             ),
             'payment_completed'
           ),
           updated_at = now()
       WHERE tenant_id = $1
         AND NOT ('payment_completed' = ANY(completed_steps))`,
      [tenantId],
      { allowNoTenant: true }
    );

    await permissionService.invalidateTenantCache(tenantId);
    await cache.invalidateTenant(tenantId);

    await eventBus.publish({
      type:       'subscription.changed',
      tenantId,
      occurredAt: new Date(),
      payload: {
        newPlanSlug: planSlug,
        changeType:  'new',
        stripeSubId,
      },
    });

    logger.info('billing.checkout.completed', { tenantId, planSlug, stripeSubId });
  }

  private async onSubscriptionUpdated(sub: Stripe.Subscription): Promise<void> {
    const tenantId = sub.metadata?.tenantId;
    if (!tenantId) return;

    await db.query(
      `UPDATE tenant_subscriptions
       SET status               = $1,
           current_period_start = to_timestamp($2),
           current_period_end   = to_timestamp($3),
           updated_at           = now()
       WHERE stripe_sub_id = $4`,
      [sub.status, sub.current_period_start, sub.current_period_end, sub.id],
      { allowNoTenant: true }
    );

    await permissionService.invalidateTenantCache(tenantId);
    logger.info('billing.subscription.updated', { tenantId, status: sub.status });
  }

  private async onSubscriptionDeleted(sub: Stripe.Subscription): Promise<void> {
    const tenantId = sub.metadata?.tenantId;
    if (!tenantId) return;

    await db.query(
      `UPDATE tenant_subscriptions SET status = 'cancelled', updated_at = now()
       WHERE stripe_sub_id = $1`,
      [sub.id], { allowNoTenant: true }
    );

    // Terugvallen op gratis Starter plan
    await db.query(
      `INSERT INTO tenant_subscriptions (tenant_id, plan_id, status)
       SELECT $1, p.id, 'active'
       FROM plans p WHERE p.slug = 'starter'`,
      [tenantId], { allowNoTenant: true }
    );

    await permissionService.invalidateTenantCache(tenantId);
    logger.info('billing.subscription.deleted', { tenantId });
  }

  private async onPaymentFailed(invoice: Stripe.Invoice): Promise<void> {
    const tenantId = (invoice as any).subscription_details?.metadata?.tenantId
      ?? invoice.metadata?.tenantId;
    if (!tenantId) return;

    await db.query(
      `UPDATE tenant_subscriptions SET status = 'past_due', updated_at = now()
       WHERE stripe_sub_id = $1`,
      [invoice.subscription as string], { allowNoTenant: true }
    );

    logger.warn('billing.payment.failed', { tenantId, invoiceId: invoice.id });
  }

  // ── Helper: Stripe Customer ophalen of aanmaken ──────────────
  private async getOrCreateStripeCustomer(tenantId: string): Promise<string> {
    const result = await db.query<{ stripe_customer_id: string | null; email: string; name: string }>(
      `SELECT stripe_customer_id, email, name FROM tenants WHERE id = $1`,
      [tenantId], { allowNoTenant: true }
    );

    const tenant = result.rows[0];
    if (!tenant) throw new Error(`Tenant niet gevonden: ${tenantId}`);

    if (tenant.stripe_customer_id) return tenant.stripe_customer_id;

    // Nieuw Stripe customer aanmaken
    const customer = await stripe.customers.create({
      email:    tenant.email,
      name:     tenant.name,
      metadata: { tenantId },
    });

    await db.query(
      `UPDATE tenants SET stripe_customer_id = $1 WHERE id = $2`,
      [customer.id, tenantId], { allowNoTenant: true }
    );

    logger.info('billing.customer.created', { tenantId, stripeCustomerId: customer.id });
    return customer.id;
  }
}
