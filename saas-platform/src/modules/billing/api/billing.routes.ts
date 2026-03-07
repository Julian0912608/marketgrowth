// src/modules/billing/api/billing.routes.ts
//
// FIX: getTenantContext() heeft geen argumenten nodig
// FIX: errorHandler is geen functie-aanroep meer

import { Router, Request, Response } from 'express';
import Stripe from 'stripe';
import { db } from '../../../infrastructure/database/connection';
import { getTenantContext } from '../../../infrastructure/database/connection';
import { logger } from '../../../shared/logging/logger';

export const billingRouter = Router();

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || '', {
  apiVersion: '2023-10-16' as any,
});

// ── GET /api/billing/subscription ────────────────────────────
billingRouter.get('/subscription', async (req: Request, res: Response) => {
  try {
    const { tenantId } = getTenantContext();

    const result = await db.query(
      `SELECT t.plan_slug, t.stripe_customer_id, t.stripe_subscription_id,
              t.billing_status, t.trial_ends_at, t.current_period_end
       FROM tenants t
       WHERE t.id = $1`,
      [tenantId]
    );

    res.json(result.rows[0] || { plan_slug: 'starter', billing_status: 'active' });
  } catch (err: any) {
    logger.error('billing.subscription.error', { error: err.message });
    res.status(500).json({ error: 'Kon abonnement niet ophalen' });
  }
});

// ── POST /api/billing/portal ──────────────────────────────────
billingRouter.post('/portal', async (req: Request, res: Response) => {
  try {
    const { tenantId } = getTenantContext();

    const result = await db.query(
      'SELECT stripe_customer_id FROM tenants WHERE id = $1',
      [tenantId]
    );

    const customerId = result.rows[0]?.stripe_customer_id;
    if (!customerId) {
      res.status(400).json({ error: 'Geen Stripe klant gevonden' });
      return;
    }

    const session = await stripe.billingPortal.sessions.create({
      customer:   customerId,
      return_url: `${process.env.APP_URL || 'https://marketgrowth-frontend.vercel.app'}/dashboard/settings`,
    });

    res.json({ url: session.url });
  } catch (err: any) {
    logger.error('billing.portal.error', { error: err.message });
    res.status(500).json({ error: 'Kon portal niet openen' });
  }
});

// ── POST /api/billing/checkout ────────────────────────────────
billingRouter.post('/checkout', async (req: Request, res: Response) => {
  try {
    const { tenantId } = getTenantContext();
    const { planSlug } = req.body;

    const priceMap: Record<string, string> = {
      growth: process.env.STRIPE_PRICE_GROWTH || '',
      pro:    process.env.STRIPE_PRICE_PRO    || '',
    };

    const priceId = priceMap[planSlug];
    if (!priceId) {
      res.status(400).json({ error: 'Ongeldig plan' });
      return;
    }

    const userResult = await db.query(
      'SELECT u.email, t.stripe_customer_id FROM users u JOIN tenants t ON t.id = u.tenant_id WHERE t.id = $1 LIMIT 1',
      [tenantId]
    );

    const { email, stripe_customer_id: existingCustomerId } = userResult.rows[0] || {};

    const session = await stripe.checkout.sessions.create({
      mode:               'subscription',
      payment_method_types: ['card'],
      customer:           existingCustomerId || undefined,
      customer_email:     existingCustomerId ? undefined : email,
      line_items:         [{ price: priceId, quantity: 1 }],
      success_url:        `${process.env.APP_URL || 'https://marketgrowth-frontend.vercel.app'}/dashboard?upgraded=true`,
      cancel_url:         `${process.env.APP_URL || 'https://marketgrowth-frontend.vercel.app'}/dashboard/settings`,
      metadata:           { tenantId },
    });

    res.json({ url: session.url });
  } catch (err: any) {
    logger.error('billing.checkout.error', { error: err.message });
    res.status(500).json({ error: 'Kon checkout niet starten' });
  }
});

// ── POST /api/billing/webhook ─────────────────────────────────
billingRouter.post('/webhook', async (req: Request, res: Response) => {
  const sig    = req.headers['stripe-signature'];
  const secret = process.env.STRIPE_WEBHOOK_SECRET;

  if (!sig || !secret) {
    res.status(400).json({ error: 'Webhook configuratie ontbreekt' });
    return;
  }

  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, secret);
  } catch (err: any) {
    logger.warn('billing.webhook.invalid', { error: err.message });
    res.status(400).json({ error: 'Ongeldige webhook' });
    return;
  }

  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const session  = event.data.object as Stripe.Checkout.Session;
        const tenantId = session.metadata?.tenantId;
        if (!tenantId) break;

        await db.query(
          `UPDATE tenants SET
             stripe_customer_id     = $2,
             stripe_subscription_id = $3,
             billing_status         = 'active',
             updated_at             = now()
           WHERE id = $1`,
          [tenantId, session.customer, session.subscription],
          { allowNoTenant: true }
        );
        break;
      }

      case 'customer.subscription.updated':
      case 'customer.subscription.deleted': {
        const sub = event.data.object as Stripe.Subscription;
        await db.query(
          `UPDATE tenants SET
             billing_status   = $2,
             current_period_end = to_timestamp($3),
             updated_at       = now()
           WHERE stripe_subscription_id = $1`,
          [
            sub.id,
            sub.status === 'active' ? 'active' : 'cancelled',
            (sub as any).current_period_end,
          ],
          { allowNoTenant: true }
        );
        break;
      }
    }

    res.json({ received: true });
  } catch (err: any) {
    logger.error('billing.webhook.processing.error', { type: event.type, error: err.message });
    res.status(500).json({ error: 'Webhook verwerking mislukt' });
  }
});
