// ============================================================
// src/modules/notifications/service/push-notifications.service.ts
//
// V0 Gap 5b: Web Push infrastructure.
//
// Wraps the web-push library. Manages the VAPID configuration
// lazily (so missing env vars do not crash the process at import
// time, only when a push is attempted).
//
// Subscription rows live in push_subscriptions, written by the
// /api/notifications/subscribe endpoint.
//
// Error handling pattern:
//   - 404 / 410 from push provider -> endpoint expired, soft-disable
//   - Other errors -> log and continue (do not break the batch)
//
// Cross-tenant access:
//   - sendToUser() is called by admin code and (later) by the daily
//     briefing worker. Both run outside tenant context, so we use
//     allowNoTenant: true with explicit user_id filtering.
// ============================================================

import webpush from 'web-push';
import { db }     from '../../../infrastructure/database/connection';
import { logger } from '../../../shared/logging/logger';

// ── VAPID config (lazy) ──────────────────────────────────────

const VAPID_SUBJECT     = () => process.env.VAPID_SUBJECT     ?? '';
const VAPID_PUBLIC_KEY  = () => process.env.VAPID_PUBLIC_KEY  ?? '';
const VAPID_PRIVATE_KEY = () => process.env.VAPID_PRIVATE_KEY ?? '';

let vapidConfigured = false;

function ensureVapidConfigured(): void {
  if (vapidConfigured) return;

  const subject = VAPID_SUBJECT();
  const pub     = VAPID_PUBLIC_KEY();
  const priv    = VAPID_PRIVATE_KEY();

  if (!subject || !pub || !priv) {
    throw new Error(
      'VAPID configuration incomplete. ' +
      'Set VAPID_SUBJECT (mailto:hello@marketgrow.ai), ' +
      'VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY env vars. ' +
      'Generate keys with: npx web-push generate-vapid-keys'
    );
  }

  webpush.setVapidDetails(subject, pub, priv);
  vapidConfigured = true;
}

// ── Public types ─────────────────────────────────────────────

export interface PushPayload {
  title:  string;
  body:   string;
  url?:   string;   // deep link, defaults to /dashboard in sw.js
  tag?:   string;   // dedupe identifier (e.g. 'daily-briefing-2026-05-15')
  icon?:  string;
  badge?: string;
}

export interface SendResult {
  sent:     number;
  failed:   number;
  disabled: number;
}

// ── Internal types ───────────────────────────────────────────

interface SubscriptionRow {
  id:          string;
  endpoint:    string;
  p256dh:      string;
  auth_secret: string;
}

interface SingleSendResult {
  sent:   boolean;
  gone:   boolean;
  error?: string;
}

// ── Service ──────────────────────────────────────────────────

export class PushNotificationService {

  /**
   * Send a notification to a single subscription row.
   * Returns success/failure with reason so the caller can decide
   * whether to soft-disable the subscription.
   */
  async sendToSubscription(
    sub: SubscriptionRow,
    payload: PushPayload,
  ): Promise<SingleSendResult> {
    ensureVapidConfigured();

    try {
      await webpush.sendNotification(
        {
          endpoint: sub.endpoint,
          keys: {
            p256dh: sub.p256dh,
            auth:   sub.auth_secret,
          },
        },
        JSON.stringify(payload),
        {
          TTL: 24 * 60 * 60, // 1 day: relevant for daily briefings
        },
      );
      return { sent: true, gone: false };
    } catch (err: unknown) {
      const e      = err as { statusCode?: number; status?: number; message?: string };
      const status = e.statusCode ?? e.status;
      const gone   = status === 404 || status === 410;

      return {
        sent:  false,
        gone,
        error: gone
          ? 'endpoint_gone_' + status
          : (e.message ?? String(err)),
      };
    }
  }

  /**
   * Send a notification to every active subscription of a user.
   * Soft-disables endpoints that return 404/410 (browser revoked
   * the subscription).
   *
   * Runs in cross-tenant admin/worker mode: allowNoTenant + explicit
   * user_id filter.
   */
  async sendToUser(userId: string, payload: PushPayload): Promise<SendResult> {
    const result = await db.query<SubscriptionRow>(
      `SELECT id, endpoint, p256dh, auth_secret
         FROM push_subscriptions
        WHERE user_id = $1
          AND disabled_at IS NULL`,
      [userId],
      { allowNoTenant: true },
    );

    let sent     = 0;
    let failed   = 0;
    let disabled = 0;

    for (const sub of result.rows) {
      const res = await this.sendToSubscription(sub, payload);

      if (res.sent) {
        sent += 1;
        // Mark as alive
        await db.query(
          `UPDATE push_subscriptions
              SET last_seen_at = now()
            WHERE id = $1`,
          [sub.id],
          { allowNoTenant: true },
        );
        continue;
      }

      if (res.gone) {
        disabled += 1;
        await db.query(
          `UPDATE push_subscriptions
              SET disabled_at = now()
            WHERE id = $1`,
          [sub.id],
          { allowNoTenant: true },
        );
        logger.info('push.subscription.disabled', {
          subscriptionId: sub.id,
          userId,
          reason: res.error,
        });
        continue;
      }

      failed += 1;
      logger.warn('push.send_failed', {
        subscriptionId: sub.id,
        userId,
        error: res.error,
      });
    }

    return { sent, failed, disabled };
  }
}

export const pushNotificationService = new PushNotificationService();
