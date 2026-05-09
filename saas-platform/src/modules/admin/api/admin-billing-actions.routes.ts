// ============================================================
// src/modules/admin/api/admin-billing-actions.routes.ts
//
// Admin endpoints voor pause / cancel / reactivate van tenant
// abonnementen. Vervangt het oude /tenants/:id/suspend gedrag.
//
// Defensive checks:
//   - Voor pause/reactivate: retrieve Stripe sub eerst, checken
//     dat die echt actief is. Voorkomt errors op DB <-> Stripe drift.
//   - Cancel: behandelt 'resource_missing' en 'al gecancelde' subs
//     als success-pad (DB syncen) ipv als fout.
//   - Billing-status: rapporteert drift terug aan de UI.
//
// Fail-fast principe: als de Stripe write-call faalt, return 502
// en doe GEEN DB update.
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

// Plat result-object ipv discriminated union (universele TS-compat).
//   - found=true                -> sub bevat de Stripe Subscription
//   - found=false, error=undef  -> 404 / resource_missing in Stripe
//   - found=false, error set    -> netwerk- of API-fout
interface StripeSubResult {
  found:  boolean;
  sub?:   Stripe.Subscription;
  error?: string;
}

// Stripe subscription statussen die we als 'levend' beschouwen
// (kunnen pauzeren / cancellen / reactiveren). Strings voor TS-compat.
const ALIVE_STRIPE_STATUSES = new Set<string>([
  'active', 'trialing', 'past_due', 'unpaid',
]);

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

// Probeer Stripe subscription op te halen. Drie uitkomsten:
//   { found: true, sub }        -> bestaat
//   { found: false }            -> bestaat niet (resource_missing)
//   { found: false, error: x }  -> andere fout (network, auth, etc)
async function fetchStripeSub(stripeSubId: string): Promise<StripeSubResult> {
  try {
    const sub = await stripe.subscriptions.retrieve(stripeSubId);
    return { found: true, sub };
  } catch (err: any) {
    if (err?.code === 'resource_missing' || err?.statusCode === 404) {
      return { found: false };
    }
    return { found: false, error: err?.message ?? 'Onbekende Stripe-fout' };
  }
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

    let stripeStatus:          string | null = null;
    let stripeMissing:         boolean       = false;
    let stripePauseCollection: boolean       = false;

    if (row.stripe_sub_id) {
      const result = await fetchStripeSub(row.stripe_sub_id);
      if (result.found && result.sub) {
        stripeStatus          = result.sub.status;
        stripePauseCollection = Boolean(result.sub.pause_collection);
      } else if (!result.found && !result.error) {
        stripeMissing = true;
      }
      // Bij netwerkfout: stripeStatus blijft null (geen drift-signal)
    }

    const driftDetected = row.tenant_status === 'active' && (
      stripeMissing ||
      (stripeStatus !== null && !ALIVE_STRIPE_STATUSES.has(stripeStatus))
    );

    res.json({
      tenantStatus:          row.tenant_status,
      pausedAt:              row.paused_at?.toISOString() ?? null,
      subscriptionStatus:    row.subscription_status,
      hasStripeSub:          Boolean(row.stripe_sub_id),
      hasStripeCustomer:     Boolean(row.stripe_customer_id),
      stripeStatus,
      stripeMissing,
      stripePauseCollection,
      driftDetected,
      canPause:
        row.tenant_status === 'active' &&
        Boolean(row.stripe_sub_id) &&
        stripeStatus !== null &&
        ALIVE_STRIPE_STATUSES.has(stripeStatus) &&
        !stripePauseCollection,
      canCancel: row.tenant_status !== 'cancelled',
      canReactivate:
        row.tenant_status === 'suspended' &&
        row.paused_at !== null &&
        Boolean(row.stripe_sub_id) &&
        stripeStatus !== null &&
        ALIVE_STRIPE_STATUSES.has(stripeStatus),
    });
  } catch (err) {
    next(err);
  }
});

// ── POST /admin/tenants/:id/pause ────────────────────────────
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

    // DEFENSIVE: check live Stripe status voor we proberen te pauzeren.
    const result = await fetchStripeSub(row.stripe_sub_id);

    if (result.error) {
      logger.error('admin.stripe.pause_retrieve_failed', {
        tenantId: id, subId: row.stripe_sub_id, error: result.error,
      });
      res.status(502).json({
        error:   'stripe_failed',
        message: `Stripe ophalen mislukt: ${result.error}. DB niet gewijzigd.`,
      });
      return;
    }

    if (!result.found || !result.sub) {
      res.status(409).json({
        error:    'stripe_sub_missing',
        message:  'Stripe subscription bestaat niet meer. Gebruik "Definitief annuleren" om de DB te syncen.',
        driftDetected: true,
      });
      return;
    }

    if (!ALIVE_STRIPE_STATUSES.has(result.sub.status)) {
      res.status(409).json({
        error:    'stripe_sub_not_alive',
        message:  `Stripe subscription staat op '${result.sub.status}'. Gebruik "Definitief annuleren" om de DB te syncen.`,
        stripeStatus:  result.sub.status,
        driftDetected: true,
      });
      return;
    }

    if (result.sub.pause_collection) {
      // Stripe is al gepauzeerd: alleen DB syncen
      await db.query(
        `UPDATE tenants
         SET status     = 'suspended',
             paused_at  = COALESCE(paused_at, NOW()),
             updated_at = NOW()
         WHERE id = $1`,
        [id], { allowNoTenant: true }
      );
      await invalidateAllTenantCaches(id);

      res.status(200).json({
        success:  true,
        action:   'db_synced_to_stripe_pause',
        message:  'Stripe was al gepauzeerd. DB nu in sync.',
      });
      return;
    }

    // Stripe-call. Bij falen: geen DB update.
    try {
      await stripe.subscriptions.update(row.stripe_sub_id, {
        pause_collection: { behavior: 'mark_uncollectible' },
      });
    } catch (stripeErr: any) {
      logger.error('admin.stripe.pause_failed', {
        tenantId: id, subId: row.stripe_sub_id, error: stripeErr.message,
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

    let stripeAction: 'cancelled' | 'already_dead' | 'no_sub' = 'no_sub';

    if (row.stripe_sub_id) {
      const result = await fetchStripeSub(row.stripe_sub_id);

      if (result.error) {
        logger.error('admin.stripe.cancel_retrieve_failed', {
          tenantId: id, subId: row.stripe_sub_id, error: result.error,
        });
        res.status(502).json({
          error:   'stripe_failed',
          message: `Stripe ophalen mislukt: ${result.error}. DB niet gewijzigd.`,
        });
        return;
      }

      if (!result.found) {
        // Sub bestaat niet meer in Stripe. Cleanup-pad.
        stripeAction = 'already_dead';
        logger.warn('admin.stripe.cancel_sub_missing', {
          tenantId: id, subId: row.stripe_sub_id,
        });
      } else if (result.sub && result.sub.status === 'canceled') {
        // Al canceled in Stripe. Cleanup-pad.
        stripeAction = 'already_dead';
        logger.warn('admin.stripe.cancel_sub_already_canceled', {
          tenantId: id, subId: row.stripe_sub_id,
        });
      } else {
        // Levende sub: echte cancel
        try {
          await stripe.subscriptions.cancel(row.stripe_sub_id);
          stripeAction = 'cancelled';
        } catch (stripeErr: any) {
          const isAlreadyGone = stripeErr?.code === 'resource_missing'
                             || stripeErr?.statusCode === 404;
          if (isAlreadyGone) {
            stripeAction = 'already_dead';
            logger.warn('admin.stripe.cancel_race_condition', {
              tenantId: id, subId: row.stripe_sub_id,
            });
          } else {
            logger.error('admin.stripe.cancel_failed', {
              tenantId: id, subId: row.stripe_sub_id, error: stripeErr.message,
            });
            res.status(502).json({
              error:   'stripe_failed',
              message: `Stripe cancel mislukt: ${stripeErr.message}. DB niet gewijzigd.`,
            });
            return;
          }
        }
      }
    }

    // DB updates (alleen als Stripe-deel succesvol of clean was)
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
      metadata:  { stripeSubId: row.stripe_sub_id, stripeAction },
    });

    logger.info('admin.tenant.cancelled', { tenantId: id, stripeAction });
    res.json({ success: true, action: 'cancelled', stripeAction });
  } catch (err) {
    next(err);
  }
});

// ── POST /admin/tenants/:id/reactivate ───────────────────────
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

    const result = await fetchStripeSub(row.stripe_sub_id);

    if (result.error) {
      logger.error('admin.stripe.reactivate_retrieve_failed', {
        tenantId: id, subId: row.stripe_sub_id, error: result.error,
      });
      res.status(502).json({
        error:   'stripe_failed',
        message: `Stripe ophalen mislukt: ${result.error}. DB niet gewijzigd.`,
      });
      return;
    }

    if (!result.found || !result.sub) {
      res.status(409).json({
        error:    'stripe_sub_missing',
        message:  'Stripe subscription bestaat niet meer. Gebruik "Definitief annuleren" om de DB te syncen.',
        driftDetected: true,
      });
      return;
    }

    if (!ALIVE_STRIPE_STATUSES.has(result.sub.status)) {
      res.status(409).json({
        error:    'stripe_sub_not_alive',
        message:  `Stripe subscription staat op '${result.sub.status}'. Gebruik "Definitief annuleren" om de DB te syncen.`,
        stripeStatus:  result.sub.status,
        driftDetected: true,
      });
      return;
    }

    // Stripe-call. Bij falen: geen DB update.
    try {
      await stripe.subscriptions.update(row.stripe_sub_id, {
        pause_collection: '' as any,
      });
    } catch (stripeErr: any) {
      logger.error('admin.stripe.reactivate_failed', {
        tenantId: id, subId: row.stripe_sub_id, error: stripeErr.message,
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
