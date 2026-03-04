// ============================================================
// src/modules/billing/api/billing.routes.ts
// ============================================================

import { Router, Request, Response, NextFunction } from 'express';
import { BillingService } from '../service/billing.service';
import { tenantMiddleware } from '../../../shared/middleware/tenant.middleware';

const router = Router();
const billingService = new BillingService();

// ── POST /api/billing/checkout ───────────────────────────────
// Maakt een Stripe Checkout sessie aan voor plan-selectie
router.post('/checkout', tenantMiddleware(), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { planSlug } = req.body;
    if (!planSlug) {
      res.status(400).json({ error: 'planSlug is verplicht' });
      return;
    }
    const session = await billingService.createCheckoutSession(planSlug);
    res.json(session);
  } catch (err) { next(err); }
});

// ── POST /api/billing/change-plan ────────────────────────────
router.post('/change-plan', tenantMiddleware(), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { planSlug } = req.body;
    await billingService.changePlan(planSlug);
    res.json({ success: true, message: `Plan gewijzigd naar ${planSlug}` });
  } catch (err) { next(err); }
});

// ── POST /api/billing/cancel ─────────────────────────────────
router.post('/cancel', tenantMiddleware(), async (req: Request, res: Response, next: NextFunction) => {
  try {
    await billingService.cancelSubscription();
    res.json({ success: true, message: 'Abonnement wordt opgezegd aan het einde van de periode.' });
  } catch (err) { next(err); }
});

// ── GET /api/billing/overview ────────────────────────────────
router.get('/overview', tenantMiddleware(), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const overview = await billingService.getBillingOverview();
    res.json(overview);
  } catch (err) { next(err); }
});

// ── POST /api/billing/webhook ────────────────────────────────
// BELANGRIJK: raw body vereist voor Stripe signature verificatie
// Dit endpoint heeft GEEN tenantMiddleware — Stripe stuurt hier naartoe
router.post('/webhook',
  // express.raw() wordt in de main app geconfigureerd voor dit pad
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const signature = req.headers['stripe-signature'] as string;
      if (!signature) {
        res.status(400).json({ error: 'Stripe-Signature header ontbreekt' });
        return;
      }

      await billingService.handleWebhook(req.body as Buffer, signature);
      res.json({ received: true });
    } catch (err) { next(err); }
  }
);

export { router as billingRouter };
