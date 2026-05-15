// ============================================================
// src/modules/notifications/api/notifications.routes.ts
//
// V0 Gap 5b: Web Push subscribe/unsubscribe + eligibility check.
//
// Endpoints (all behind tenantMiddleware, JWT required):
//   POST   /api/notifications/subscribe     -> upsert subscription
//   DELETE /api/notifications/subscribe     -> soft-disable
//   GET    /api/notifications/eligibility   -> can we show the prompt?
//
// Schema: push_subscriptions (migration 024).
// ============================================================

import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { db }                from '../../../infrastructure/database/connection';
import { tenantMiddleware }  from '../../../shared/middleware/tenant.middleware';
import { getTenantContext }  from '../../../shared/middleware/tenant-context';
import { logger }            from '../../../shared/logging/logger';

const router = Router();
router.use(tenantMiddleware());

// ── Schemas ──────────────────────────────────────────────────

const SubscribeSchema = z.object({
  endpoint: z.string().url().min(20).max(2000),
  keys: z.object({
    p256dh: z.string().min(1).max(500),
    auth:   z.string().min(1).max(500),
  }),
  userAgent: z.string().max(500).optional(),
});

const UnsubscribeSchema = z.object({
  endpoint: z.string().url().min(20).max(2000),
});

// ── POST /api/notifications/subscribe ────────────────────────

router.post('/subscribe', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const parsed = SubscribeSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(422).json({
        error:  'validation_failed',
        issues: parsed.error.errors,
      });
      return;
    }

    const { tenantId, userId } = getTenantContext();
    const { endpoint, keys, userAgent } = parsed.data;

    // Upsert on endpoint (globally unique). If the same browser
    // re-subscribes after permission was reset, we re-enable the row.
    const result = await db.query<{ id: string }>(
      `INSERT INTO push_subscriptions (
         tenant_id, user_id, endpoint, p256dh, auth_secret, user_agent
       ) VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (endpoint) DO UPDATE SET
         tenant_id    = EXCLUDED.tenant_id,
         user_id      = EXCLUDED.user_id,
         p256dh       = EXCLUDED.p256dh,
         auth_secret  = EXCLUDED.auth_secret,
         user_agent   = EXCLUDED.user_agent,
         disabled_at  = NULL,
         last_seen_at = now()
       RETURNING id`,
      [
        tenantId,
        userId,
        endpoint,
        keys.p256dh,
        keys.auth,
        userAgent ?? req.headers['user-agent']?.toString().substring(0, 500) ?? null,
      ],
    );

    logger.info('push.subscription.created', {
      subscriptionId: result.rows[0]?.id,
      userId,
    });

    res.status(201).json({
      ok: true,
      subscriptionId: result.rows[0]?.id,
    });
  } catch (err) {
    next(err);
  }
});

// ── DELETE /api/notifications/subscribe ──────────────────────
// Soft-disable rather than hard delete: keeps the audit trail
// of which devices a user ever subscribed from.

router.delete('/subscribe', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const parsed = UnsubscribeSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(422).json({
        error:  'validation_failed',
        issues: parsed.error.errors,
      });
      return;
    }

    const { userId } = getTenantContext();
    const { endpoint } = parsed.data;

    await db.query(
      `UPDATE push_subscriptions
          SET disabled_at = now()
        WHERE user_id = $1
          AND endpoint = $2
          AND disabled_at IS NULL`,
      [userId, endpoint],
    );

    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

// ── GET /api/notifications/eligibility ───────────────────────
// Backend gate for the prompt: applies the 24h-after-signup rule
// and the "already subscribed?" check. The frontend layers a
// dismiss-cooldown on top of this.

router.get('/eligibility', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { userId } = getTenantContext();

    // Pull user signup timestamp + count active subs in one round-trip
    const result = await db.query<{
      user_created_at: Date;
      active_subscription_count: string;
    }>(
      `SELECT
         u.created_at AS user_created_at,
         (
           SELECT count(*) FROM push_subscriptions ps
            WHERE ps.user_id = u.id
              AND ps.disabled_at IS NULL
         )::text AS active_subscription_count
       FROM users u
      WHERE u.id = $1
      LIMIT 1`,
      [userId],
      { allowNoTenant: true },
    );

    const row = result.rows[0];
    if (!row) {
      res.status(404).json({ error: 'user_not_found' });
      return;
    }

    const hasActiveSubscription = parseInt(row.active_subscription_count, 10) > 0;

    // 24 hour rule: prompt only after the user has lived with the
    // product for a day. Avoids the "stack of permission dialogs"
    // experience on first signup.
    const createdAt   = new Date(row.user_created_at);
    const ageMs       = Date.now() - createdAt.getTime();
    const ageHours    = ageMs / (1000 * 60 * 60);
    const oldEnough   = ageHours >= 24;

    let shouldShowPrompt = true;
    let reason: string | undefined;

    if (hasActiveSubscription) {
      shouldShowPrompt = false;
      reason = 'already_subscribed';
    } else if (!oldEnough) {
      shouldShowPrompt = false;
      reason = 'too_early';
    }

    res.json({
      shouldShowPrompt,
      hasActiveSubscription,
      reason,
      userCreatedAt: createdAt.toISOString(),
      hoursSinceSignup: Math.floor(ageHours),
    });
  } catch (err) {
    next(err);
  }
});

export { router as notificationsRouter };
