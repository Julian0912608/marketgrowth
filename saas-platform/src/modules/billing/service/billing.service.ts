// ============================================================
// src/modules/billing/service/billing.service.ts
//
// Beheert Stripe-abonnementen:
//  - Checkout sessie aanmaken (klant kiest plan en betaalt)
//  - Abonnement upgraden / downgraden
//  - Webhook verwerking (Stripe stuurt events als status verandert)
//  - Facturatie-overzicht ophalen
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

// Stripe Price IDs per plan — stel deze in als environment variables
// zodat je eenvoudig kunt wisselen tussen test en productie
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

    // Haal Stripe customer ID op (of maak nieuw aan)
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

    // Haal huidige Stripe subscription op
    const subResult = await db.query<{ stripe_sub_id: string; plan_slug: string }>(
      `SELECT ts.stripe_sub_id, p.slug AS plan_slug
       FROM tenant_subscriptions ts
       JOIN plans p ON p.id = ts.plan_id
       WHERE ts.tenant_id = $1 AND ts.status = 'active'
       LIMIT 1`,
      [tenantId], { allowNoTenant: true }
    );

    const currentSub = subResult.rows[0];
    if (!currentSub?.stripe_sub_id) {
      throw new Error('Geen actief abonnement gevonden.');
    }

    // Stripe abonnement aanpassen
    const subscription = await stripe.subscriptions.retrieve(currentSub.stripe_sub_id);
    await stripe.subscriptions.update(currentSub.stripe_sub_id, {
      items: [{
        id:    subscription.items.data[0].id,
        price: priceId,
      }],
      proration_behavior: 'create_prorations',  // klant betaalt/ontvangt verschil
    });

    logger.info('billing.plan.changed', {
      tenantId,
      oldPlan: currentSub.plan_slug,
      newPlan: newPlanSlug,
    });

    // Plan cache invalideren zodat permissies direct worden bijgewerkt
    await permissionService.invalidateTenantCache(tenantId);
    await cache.invalidateTenant(tenantId);
  }

  // ── Abonnement opzeggen (aan einde van periode) ───────────────
  async cancelSubscription(): Promise<void> {
    const { tenantId } = getTenantContext();

    const subResult = await db.query<{ stripe_sub_id: string }>(
      `SELECT stripe_sub_id FROM tenant_subscriptions
       WHERE tenant_id = $1 AND status = 'active' LIMIT 1`,
      [tenantId], { allowNoTenant: true }
    );

    const stripeSubId = subResult.rows[0]?.stripe_sub_id;
    if (!stripeSubId) throw new Error('Geen actief abonnement gevonden.');

    // Cancel at period end: klant behoudt toegang tot einde van betaalde periode
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

    // Facturen ophalen uit Stripe
    const stripeCustomerId = await this.getOrCreateStripeCustomer(tenantId);
    const stripeInvoices = await stripe.invoices.list({
      customer: stripeCustomerId,
      limit:    12,
    });

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

    await cache.setJson(cacheKey, overview, 300);  // 5 minuten cache
    return overview;
  }

  // ── Stripe webhook verwerking ────────────────────────────────
  // Wordt aangeroepen door de webhook route (niet door tenantMiddleware!)
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
    const tenantId  = session.metadata?.tenantId;
    const planSlug  = session.metadata?.planSlug;
    const stripeSubId = session.subscription as string;

    if (!tenantId || !planSlug) return;

    // Abonnement bijwerken in database
    await db.query(
      `UPDATE tenant_subscriptions
       SET plan_id = (SELECT id FROM plans WHERE slug = $1),
           stripe_sub_id = $2,
           status = 'active',
           updated_at = now()
       WHERE tenant_id = $3`,
      [planSlug, stripeSubId, tenantId],
      { allowNoTenant: true }
    );

    // Cache leegmaken zodat nieuwe permissies direct actief zijn
    await permissionService.invalidateTenantCache(tenantId);
    await cache.invalidateTenant(tenantId);

    await eventBus.publish({
      type: 'subscription.changed',
      tenantId,
      occurredAt: new Date(),
      payload: { newPlanSlug: planSlug, changeType: 'upgrade', oldPlanSlug: 'starter' },
    });

    logger.info('billing.checkout.completed', { tenantId, planSlug });
  }

  private async onSubscriptionUpdated(sub: Stripe.Subscription): Promise<void> {
    const tenantId = sub.metadata?.tenantId;
    if (!tenantId) return;

    await db.query(
      `UPDATE tenant_subscriptions
       SET status = $1,
           current_period_start = to_timestamp($2),
           current_period_end   = to_timestamp($3),
           updated_at = now()
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

    // Terug naar Starter na opzegging
    await db.query(
      `INSERT INTO tenant_subscriptions (tenant_id, plan_id, status)
       SELECT $1, p.id, 'active' FROM plans p WHERE p.slug = 'starter'`,
      [tenantId], { allowNoTenant: true }
    );

    await permissionService.invalidateTenantCache(tenantId);
    await cache.invalidateTenant(tenantId);

    await eventBus.publish({
      type: 'subscription.changed',
      tenantId,
      occurredAt: new Date(),
      payload: { newPlanSlug: 'starter', changeType: 'cancelled', oldPlanSlug: sub.metadata?.planSlug },
    });

    logger.info('billing.subscription.cancelled_by_stripe', { tenantId });
  }

  private async onPaymentFailed(invoice: Stripe.Invoice): Promise<void> {
    const customerId = invoice.customer as string;
    logger.warn('billing.payment.failed', { stripeCustomerId: customerId });
    // In productie: stuur dunning email via email service
  }

  // ── Stripe customer ophalen of aanmaken ──────────────────────
  private async getOrCreateStripeCustomer(tenantId: string): Promise<string> {
    const cacheKey = cache.key(tenantId, 'stripe', 'customer_id');
    const cached = await cache.get(cacheKey);
    if (cached) return cached;

    // Kijk of tenant al een Stripe customer ID heeft
    const result = await db.query<{ email: string; name: string; stripe_customer_id: string | null }>(
      `SELECT t.email, t.name,
              (SELECT stripe_sub_id FROM tenant_subscriptions
               WHERE tenant_id = t.id LIMIT 1) AS stripe_customer_id
       FROM tenants t WHERE t.id = $1`,
      [tenantId], { allowNoTenant: true }
    );

    const tenant = result.rows[0];
    if (!tenant) throw new Error('Tenant niet gevonden.');

    // Maak nieuwe Stripe customer aan als die nog niet bestaat
    const customer = await stripe.customers.create({
      email:    tenant.email,
      name:     tenant.name,
      metadata: { tenantId },
    });

    await cache.set(cacheKey, customer.id, 86400);  // 24 uur cache
    return customer.id;
  }
}
