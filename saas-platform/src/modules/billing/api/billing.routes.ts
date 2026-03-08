import { Router, Request, Response, NextFunction } from 'express';
import Stripe from 'stripe';
import { db } from '../../../infrastructure/database/connection';
import { getTenantContext } from '../../../shared/middleware/tenant-context';
import { tenantMiddleware } from '../../../shared/middleware/tenant.middleware';
import { logger } from '../../../shared/logging/logger';

const router = Router();

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || '', {
  apiVersion: '2023-10-16' as any,
});

const priceMap: Record<string, string> = {
  starter: process.env.STRIPE_PRICE_STARTER || '',
  growth:  process.env.STRIPE_PRICE_GROWTH  || '',
  scale:   process.env.STRIPE_PRICE_SCALE   || '',
};

// ── POST /api/billing/checkout ────────────────────────────────
router.post('/checkout', tenantMiddleware(), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { tenantId } = getTenantContext();
    const { planSlug } = req.body;

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
      mode:                 'subscription',
      payment_method_types: ['card'],
      customer:             existingCustomerId || undefined,
      customer_email:       existingCustomerId ? undefined : email,
      line_items:           [{ price: priceId, quantity: 1 }],
      success_url:          `${process.env.APP_URL || 'https://marketgrowth-frontend.vercel.app'}/dashboard?upgraded=true`,
      cancel_url:           `${process.env.APP_URL || 'https://marketgrowth-frontend.vercel.app'}/onboarding`,
      metadata:             { tenantId, planSlug },
    });

    res.json({ url: session.url });
  } catch (err) { next(err); }
});

// ── GET /api/billing/subscription ────────────────────────────
router.get('/subscription', tenantMiddleware(), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { tenantId } = getTenantContext();

    const result = await db.query(
      `SELECT plan_slug, billing_status FROM tenants WHERE id = $1`,
      [tenantId]
    );

    res.json(result.rows[0] || { plan_slug: 'starter', billing_status: 'active' });
  } catch (err) { next(err); }
});

// ── POST /api/billing/portal ──────────────────────────────────
router.post('/portal', tenantMiddleware(), async (req: Request, res: Response, next: NextFunction) => {
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
  } catch (err) { next(err); }
});

// ── POST /api/billing/webhook ─────────────────────────────────
// Geen tenantMiddleware — komt van Stripe
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
  } catch (err: any) {
    res.status(400).json({ error: 'Ongeldige webhook' });
    return;
  }

  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const session  = event.data.object as Stripe.Checkout.Session;
        const tenantId = session.metadata?.tenantId;
        const planSlug = session.metadata?.planSlug;
        if (!tenantId) break;

        await db.query(
          `UPDATE tenants SET
             stripe_customer_id     = $2,
             stripe_subscription_id = $3,
             plan_slug              = $4,
             billing_status         = 'active',
             updated_at             = now()
           WHERE id = $1`,
          [tenantId, session.customer, session.subscription, planSlug],
          { allowNoTenant: true }
        );
        break;
      }
    }

    res.json({ received: true });
  } catch (err) { next(err); }
});

export { router as billingRouter };
