// ============================================================
// src/modules/billing/service/billing.service.ts
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

  async createCheckoutSession(planSlug: string): Promise<CheckoutSession> {
    const { tenantId, userId } = getTenantContext();

    const priceId = PLAN_PRICE_IDS[planSlug];
    if (!priceId) {
      throw Object.assign(new Error(`Ongeldig plan: ${planSlug}`), { httpStatus: 400, error: 'Ongeldig plan' });
    }

    const stripeCustomerId = await this.getOrCreateStripeCustomer(tenantId);

    const session = await stripe.checkout.sessions.create({
      customer:   stripeCustomerId,
      mode:       'subscription',
      line_items: [{ price: priceId, quantity: 1 }],
      // 14-dagen gratis trial
      subscription_data: {
        trial_period_days: 14,
        metadata: { tenantId, planSlug },
      },
      success_url: `${process.env.APP_URL}/onboarding?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url:  `${process.env.APP_URL}/onboarding`,
      metadata: { tenantId, userId, planSlug },
      allow_promotion_codes: true,
    });

    logger.info('billing.checkout.created', { tenantId, planSlug });

    return { url: session.url!, sessionId: session.id };
  }

  async changePlan(newPlanSlug: string): Promise<void> {
    const { tenantId } = getTenantContext();

    const priceId = PLAN_PRICE_IDS[newPlanSlug];
    if (!priceId) throw new Error(`Onbekend plan: ${newPlanSlug}`);

    const subResult = await db.query<{ stripe_sub_id: string; plan_slug: string }>(
      `SELECT ts.stripe_sub_id, p.slug AS plan_slug
       FROM tenant_subscriptions ts
       JOIN plans p ON p.id = ts.plan_id
       WHERE ts.tenant_id = $1 AND ts.status IN ('active','trialing')
       LIMIT 1`,
      [tenantId], { allowNoTenant: true }
    );

    const currentSub = subResult.rows[0];
    if (!currentSub?.stripe_sub_id) throw new Error('Geen actief abonnement gevonden.');

    const subscription = await stripe.subscriptions.retrieve(currentSub.stripe_sub_id);
    await stripe.subscriptions.update(currentSub.stripe_sub_id, {
      items: [{ id: subscription.items.data[0].id, price: priceId }],
      proration_behavior: 'create_prorations',
    });

    logger.info('billing.plan.changed', { tenantId, oldPlan: currentSub.plan_slug, newPlan: newPlanSlug });

    await permissionService.invalidateTenantCache(tenantId);
    await cache.invalidateTenant(tenantId);
  }

  async cancelSubscription(): Promise<void> {
    const { tenantId } = getTenantContext();

    const subResult = await db.query<{ stripe_sub_id: string }>(
      `SELECT stripe_sub_id FROM tenant_subscriptions
       WHERE tenant_id = $1 AND status IN ('active','trialing') LIMIT 1`,
      [tenantId], { allowNoTenant: true }
    );

    const stripeSubId = subResult.rows[0]?.stripe_sub_id;
    if (!stripeSubId) throw new Error('Geen actief abonnement gevonden.');

    await stripe.subscriptions.update(stripeSubId, { cancel_at_period_end: true });
    logger.info('billing.subscription.cancelled', { tenantId });
  }

  async getBillingOverview(): Promise<BillingOverview> {
    const { tenantId } = getTenantContext();
    const cacheKey = cache.key(tenantId, 'billing', 'overview');

    const cached = await cache.getJson<BillingOverview>(cacheKey);
    if (cached) return cached;

    const subResult = await db.query<{
      stripe_sub_id: string; plan_slug: string; plan_name: string;
      status: string; current_period_end: Date;
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

    const stripeCustomerId = await this.getOrCreateStripeCustomer(tenantId);
    const stripeInvoices = await stripe.invoices.list({ customer: stripeCustomerId, limit: 12 });

    const stripeSub = sub.stripe_sub_id
      ? await stripe.subscriptions.retrieve(sub.stripe_sub_id)
      : null;

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

  async handleWebhook(payload: Buffer, signature: string): Promise<void> {
    let event: Stripe.Event;

    try {
      event = stripe.webhooks.constructEvent(payload, signature, process.env.STRIPE_WEBHOOK_SECRET!);
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

  private async onCheckoutCompleted(session: Stripe.Checkout.Session): Promise<void> {
    const tenantId    = session.metadata?.tenantId;
    const planSlug    = session.metadata?.planSlug;
    const stripeSubId = session.subscription as string;

    if (!tenantId || !planSlug) return;

    // Haal trial end op uit Stripe subscription
    const stripeSub = await stripe.subscriptions.retrieve(stripeSubId);
    const status = stripeSub.status; // 'trialing' of 'active'
    const periodEnd = new Date(stripeSub.current_period_end * 1000);

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

    // Onboarding stappen bijwerken
    await db.query(
      `UPDATE onboarding_progress
       SET current_step = 'shop_connected',
           completed_steps = array_append(
             array_append(completed_steps, 'plan_selected'),
             'payment_completed'
           ),
           updated_at = now()
       WHERE tenant_id = $1`,
      [tenantId], { allowNoTenant: true }
    );

    await permissionService.invalidateTenantCache(tenantId);
    await cache.invalidateTenant(tenantId);

    logger.info('billing.checkout.completed', { tenantId, planSlug, status });

    await eventBus.publish({
      type: 'subscription.created',
      tenantId,
      occurredAt: new Date(),
      payload: { planSlug, status },
    });
  }

  private async onSubscriptionUpdated(subscription: Stripe.Subscription): Promise<void> {
    const tenantId = subscription.metadata?.tenantId;
    if (!tenantId) return;

    await db.query(
      `UPDATE tenant_subscriptions
       SET status = $2, current_period_end = $3, updated_at = now()
       WHERE tenant_id = $1`,
      [tenantId, subscription.status, new Date(subscription.current_period_end * 1000)],
      { allowNoTenant: true }
    );

    await permissionService.invalidateTenantCache(tenantId);
    await cache.invalidateTenant(tenantId);

    logger.info('billing.subscription.updated', { tenantId, status: subscription.status });
  }

  private async onSubscriptionDeleted(subscription: Stripe.Subscription): Promise<void> {
    const tenantId = subscription.metadata?.tenantId;
    if (!tenantId) return;

    await db.query(
      `UPDATE tenant_subscriptions SET status = 'cancelled', updated_at = now()
       WHERE tenant_id = $1`,
      [tenantId], { allowNoTenant: true }
    );

    // Terugvallen op starter plan
    await db.query(
      `UPDATE tenant_subscriptions
       SET plan_id = (SELECT id FROM plans WHERE slug = 'starter'), updated_at = now()
       WHERE tenant_id = $1`,
      [tenantId], { allowNoTenant: true }
    );

    await permissionService.invalidateTenantCache(tenantId);
    await cache.invalidateTenant(tenantId);

    logger.info('billing.subscription.deleted', { tenantId });
  }

  private async onPaymentFailed(invoice: Stripe.Invoice): Promise<void> {
    const customerId = invoice.customer as string;
    logger.warn('billing.payment.failed', { stripeCustomerId: customerId });
  }

  private async getOrCreateStripeCustomer(tenantId: string): Promise<string> {
    const cacheKey = cache.key(tenantId, 'stripe', 'customer_id');
    const cached = await cache.get(cacheKey);
    if (cached) return cached;

    const result = await db.query<{ email: string; name: string; stripe_customer_id: string | null }>(
      `SELECT t.email, t.name, t.stripe_customer_id FROM tenants t WHERE t.id = $1`,
      [tenantId], { allowNoTenant: true }
    );

    const tenant = result.rows[0];
    if (!tenant) throw new Error('Tenant niet gevonden.');

    // Gebruik bestaande stripe customer ID als die er is
    if (tenant.stripe_customer_id) {
      await cache.set(cacheKey, tenant.stripe_customer_id, 86400);
      return tenant.stripe_customer_id;
    }

    const customer = await stripe.customers.create({
      email:    tenant.email,
      name:     tenant.name,
      metadata: { tenantId },
    });

    // Sla stripe_customer_id op in tenants tabel
    await db.query(
      `UPDATE tenants SET stripe_customer_id = $2 WHERE id = $1`,
      [tenantId, customer.id], { allowNoTenant: true }
    );

    await cache.set(cacheKey, customer.id, 86400);
    return customer.id;
  }
}
