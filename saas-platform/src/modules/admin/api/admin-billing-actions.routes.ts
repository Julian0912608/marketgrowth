// ============================================================
// src/modules/admin/api/admin-billing-actions.routes.ts
//
// Admin endpoints voor pause / cancel / reactivate van tenant
// abonnementen. Vervangt het oude /tenants/:id/suspend gedrag
// (de oude endpoint blijft bestaan voor backwards compat,
// maar wordt door de admin UI niet meer aangeroepen).
//
// Fail-fast principe: als de Stripe call faalt, return 500 en
// doe GEEN DB update. Voorkomt mismatch waarbij de tenant
// lokaal geblokkeerd is maar Stripe blijft factureren.
//
// Endpoints:
//   GET  /admin/tenants/:id/billing-status
//   POST /admin/tenants/:id/pause
//   POST /admin/tenants/:id/cancel
//   POST /admin/tenants/:id/reactivate
// ============================================================

import { Router, Request, Response, NextFunction } from 'express';
import Stripe from 'stripe';
import { db }    from '../../../infrastructure/database/connection';
import { cache } from '../../../infrastructure/cache/redis';
import { permissionService } from '../../../shared/permissions/permission.service';
import { logger } from '../../../shared/logging/logger';
import { adminSessionService } from '../service/admin-session.service';

const router = Router();

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
  apiVersion: '2023-10-16',
});

interface AuthedRequest extends Request {
  adminSession?: { id: string };
}

interface TenantBillingRow {
  tenant_status:        'active' | 'suspended' | 'cancelled';
  paused_at:            Date | null;
  subscription_status:  'active' | 'trialing' | 'past_due' | 'cancelled' | null;
  stripe_sub_id:        string | null;
  stripe_customer_id:   string | null;
}

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ── Helpers ──────────────────────────────────────────────────
function getRequestMeta(req: Request) {
  return {
    ip: (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim()
        ?? req.ip
        ?? '',
    userAgent: req.headers['user-agent']?.substring(0, 500) ?? '',
  };
}

async function adminAuth(req: AuthedRequest, res: Response, next: NextFunction): Promise<void> {
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

router.use(adminAuth);

async function loadBillingState(tenantId: string): Promise<TenantBillingRow | null> {
  const result = await db.query<TenantBillingRow>(
    `SELECT
       t.status              AS tenant_status,
       t.paused_at           AS paused_at,
       t.stripe_customer_id  AS stripe_customer_id,
       ts.status             AS subscription_status,
       ts.stripe_sub_id      AS stripe_sub_id
     FROM tenants t
     LEFT JOIN tenant_subscriptions ts ON ts.tenant_id = t.id
     WHERE t.id = $1
     LIMIT 1`,
    [tenantId],
    { allowNoTenant: true }
  );
  return result.rows[0] ?? null;
}

async function invalidateAllTenantCaches(tenantId: string): Promise<void> {
  await Promise.all([
    permissionService.invalidateTenantCache(tenantId),
    cache.invalidateTenant(tenantId),
  ]);
}

// ── GET /admin/tenants/:id/billing-status ────────────────────
router.get('/tenants/:id/billing-status', async (req: AuthedRequest, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;
    if (!UUID_REGEX.test(id)) {
      res.status(400).json({ error: 'Ongeldig tenant id' });
      return;
    }

    const row = await loadBillingState(id);
    if (!row) {
      res.status(404).json({ error: 'Tenant niet gevonden' });
      return;
    }

    res.json({
      tenantStatus:       row.tenant_status,
      pausedAt:           row.paused_at?.toISOString() ?? null,
      subscriptionStatus: row.subscription_status,
      hasStripeSub:       Boolean(row.stripe_sub_id),
      hasStripeCustomer:  Boolean(row.stripe_customer_id),
      canPause:           row.tenant_status === 'active' && Boolean(row.stripe_sub_id),
      canCancel:          row.tenant_status !== 'cancelled',
      canReactivate:      row.tenant_status === 'suspended' && row.paused_at !== null && Boolean(row.stripe_sub_id),
    });
  } catch (err) {
    next(err);
  }
});

// ── POST /admin/tenants/:id/pause ────────────────────────────
// Stripe: pause_collection met 'mark_uncollectible' behavior.
// Subscription blijft bestaan, geen incasso gedurende pauze.
// Reactivate herstelt de incasso vanaf de volgende cycle.
router.post('/tenants/:id/pause', async (req: AuthedRequest, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;
    if (!UUID_REGEX.test(id)) {
      res.status(400).json({ error: 'Ongeldig tenant id' });
      return;
    }

    const meta = getRequestMeta(req);
    const row  = await loadBillingState(id);
    if (!row) {
      res.status(404).json({ error: 'Tenant niet gevonden' });
      return;
    }

    if (row.tenant_status !== 'active') {
      res.status(409).json({
        error:   'invalid_state',
        message: 'Alleen actieve tenants kunnen worden gepauzeerd.',
      });
      return;
    }

    if (!row.stripe_sub_id) {
      res.status(409).json({
        error:   'no_stripe_subscription',
        message: 'Geen Stripe subscription gekoppeld. Pauzeren niet mogelijk.',
      });
      return;
    }

    // Stripe-call EERST. Geen DB update bij falen.
    try {
      await stripe.subscriptions.update(row.stripe_sub_id, {
        pause_collection: { behavior: 'mark_uncollectible' },
      });
    } catch (stripeErr: any) {
      logger.error('admin.stripe.pause_failed', {
        tenantId:   id,
        subId:      row.stripe_sub_id,
        error:      stripeErr.message,
      });
      res.status(502).json({
        error:   'stripe_failed',
        message: `Stripe pauze mislukt: ${stripeErr.message}. DB niet gewijzigd.`,
      });
      return;
    }

    // Stripe succes -> DB update
    await db.query(
      `UPDATE tenants
       SET status     = 'suspended',
           paused_at  = NOW(),
           updated_at = NOW()
       WHERE id = $1`,
      [id], { allowNoTenant: true }
    );

    await invalidateAllTenantCaches(id);

    await adminSessionService.auditLog({
      sessionId: req.adminSession!.id,
      action:    'admin.tenant.paused',
      resource:  'tenant',
      targetId:  id,
      ip:        meta.ip,
      userAgent: meta.userAgent,
      metadata:  { stripeSubId: row.stripe_sub_id },
    });

    logger.info('admin.tenant.paused', { tenantId: id });
    res.json({ success: true, action: 'paused' });
  } catch (err) {
    next(err);
  }
});

// ── POST /admin/tenants/:id/cancel ───────────────────────────
// Permanent: Stripe subscription wordt gecanceld. Klant moet
// een nieuwe checkout doorlopen om terug te komen.
router.post('/tenants/:id/cancel', async (req: AuthedRequest, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;
    if (!UUID_REGEX.test(id)) {
      res.status(400).json({ error: 'Ongeldig tenant id' });
      return;
    }

    const meta = getRequestMeta(req);
    const row  = await loadBillingState(id);
    if (!row) {
      res.status(404).json({ error: 'Tenant niet gevonden' });
      return;
    }

    if (row.tenant_status === 'cancelled') {
      res.status(409).json({
        error:   'already_cancelled',
        message: 'Tenant is al geannuleerd.',
      });
      return;
    }

    // Als er een Stripe sub is, eerst Stripe. Bij falen: geen DB update.
    // Als er GEEN Stripe sub is (bv. nooit doorbetaald), gewoon DB update.
    if (row.stripe_sub_id) {
      try {
        await stripe.subscriptions.cancel(row.stripe_sub_id);
      } catch (stripeErr: any) {
        // 404/resource_missing acceptabel (al gecanceld in Stripe)
        const isAlreadyGone = stripeErr?.code === 'resource_missing'
                            || stripeErr?.statusCode === 404;

        if (!isAlreadyGone) {
          logger.error('admin.stripe.cancel_failed', {
            tenantId:   id,
            subId:      row.stripe_sub_id,
            error:      stripeErr.message,
          });
          res.status(502).json({
            error:   'stripe_failed',
            message: `Stripe cancel mislukt: ${stripeErr.message}. DB niet gewijzigd.`,
          });
          return;
        }

        logger.warn('admin.stripe.cancel_already_gone', {
          tenantId: id,
          subId:    row.stripe_sub_id,
        });
      }
    }

    // DB updates
    await db.query(
      `UPDATE tenants
       SET status     = 'cancelled',
           paused_at  = NULL,
           updated_at = NOW()
       WHERE id = $1`,
      [id], { allowNoTenant: true }
    );

    await db.query(
      `UPDATE tenant_subscriptions
       SET status     = 'cancelled',
           updated_at = NOW()
       WHERE tenant_id = $1`,
      [id], { allowNoTenant: true }
    );

    await invalidateAllTenantCaches(id);

    await adminSessionService.auditLog({
      sessionId: req.adminSession!.id,
      action:    'admin.tenant.cancelled',
      resource:  'tenant',
      targetId:  id,
      ip:        meta.ip,
      userAgent: meta.userAgent,
      metadata:  { stripeSubId: row.stripe_sub_id },
    });

    logger.info('admin.tenant.cancelled', { tenantId: id });
    res.json({ success: true, action: 'cancelled' });
  } catch (err) {
    next(err);
  }
});

// ── POST /admin/tenants/:id/reactivate ───────────────────────
// Hervat een gepauzeerde tenant. Werkt alleen bij paused state
// (status='suspended' + paused_at NOT NULL). Cancelled tenants
// kunnen niet gereactiveerd worden, die moeten een nieuwe
// checkout doorlopen.
router.post('/tenants/:id/reactivate', async (req: AuthedRequest, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;
    if (!UUID_REGEX.test(id)) {
      res.status(400).json({ error: 'Ongeldig tenant id' });
      return;
    }

    const meta = getRequestMeta(req);
    const row  = await loadBillingState(id);
    if (!row) {
      res.status(404).json({ error: 'Tenant niet gevonden' });
      return;
    }

    if (row.tenant_status === 'cancelled') {
      res.status(409).json({
        error:   'cannot_reactivate_cancelled',
        message: 'Geannuleerde tenants moeten een nieuwe checkout doorlopen.',
      });
      return;
    }

    if (row.tenant_status === 'active') {
      res.status(409).json({
        error:   'already_active',
        message: 'Tenant is al actief.',
      });
      return;
    }

    if (!row.stripe_sub_id) {
      res.status(409).json({
        error:   'no_stripe_subscription',
        message: 'Geen Stripe subscription gekoppeld.',
      });
      return;
    }

    // Stripe pause_collection wissen
    try {
      await stripe.subscriptions.update(row.stripe_sub_id, {
        pause_collection: '' as any,
      });
    } catch (stripeErr: any) {
      logger.error('admin.stripe.reactivate_failed', {
        tenantId:   id,
        subId:      row.stripe_sub_id,
        error:      stripeErr.message,
      });
      res.status(502).json({
        error:   'stripe_failed',
        message: `Stripe reactivate mislukt: ${stripeErr.message}. DB niet gewijzigd.`,
      });
      return;
    }

    await db.query(
      `UPDATE tenants
       SET status     = 'active',
           paused_at  = NULL,
           updated_at = NOW()
       WHERE id = $1`,
      [id], { allowNoTenant: true }
    );

    await invalidateAllTenantCaches(id);

    await adminSessionService.auditLog({
      sessionId: req.adminSession!.id,
      action:    'admin.tenant.reactivated',
      resource:  'tenant',
      targetId:  id,
      ip:        meta.ip,
      userAgent: meta.userAgent,
      metadata:  { stripeSubId: row.stripe_sub_id },
    });

    logger.info('admin.tenant.reactivated', { tenantId: id });
    res.json({ success: true, action: 'reactivated' });
  } catch (err) {
    next(err);
  }
});

export { router as adminBillingActionsRouter };
