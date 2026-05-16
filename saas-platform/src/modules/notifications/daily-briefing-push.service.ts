// ============================================================
// src/modules/notifications/daily-briefing-push.service.ts
//
// V0 Gap 5c: Daily briefing push notifications.
//
// Companion to sendDailyBriefings() in email.service.ts. Runs
// after the email cron (06:00 UTC, 07:00/08:00 Amsterdam).
//
// Why a separate file:
//   1. Pushes target users (push_subscriptions.user_id), email
//      targets the owner per tenant. Different SELECT.
//   2. Push failures must never block email delivery. Calling
//      this from email.worker.ts in its own try/catch keeps the
//      two paths independent.
//   3. The briefing for "today" is already cached in
//      tenant_briefings by the time this runs, so the
//      briefingsService call here is a DB read with zero AI
//      tokens.
//
// Edge case (00:00-00:59 UTC = 01:00-01:59 NL): same as email
// cron, the UTC date matches NL date except for this one hour.
// Acceptable for V0 because no user is reading the briefing at
// that hour.
// ============================================================

import { db } from '../../infrastructure/database/connection';
import { logger } from '../../shared/logging/logger';
import { briefingsService } from '../briefings/service/briefings.service';
import { BriefingAction } from '../briefings/types/briefings.types';
import {
  pushNotificationService,
  PushPayload,
} from './service/push-notifications.service';

// ── Row types ────────────────────────────────────────────────

interface PushTargetRow {
  tenant_id:  string;
  user_id:    string;
  first_name: string | null;
}

// ── Helpers ──────────────────────────────────────────────────

function pickTopAction(actions: BriefingAction[]): BriefingAction | null {
  if (!Array.isArray(actions) || actions.length === 0) return null;
  const order: Record<BriefingAction['priority'], number> = {
    high:   0,
    medium: 1,
    low:    2,
  };
  const sorted = [...actions].sort(
    (a, b) => (order[a.priority] ?? 99) - (order[b.priority] ?? 99),
  );
  return sorted[0] ?? null;
}

function todayDateTag(): string {
  // UTC date matches the email cron timestamp (06:00 UTC fires
  // on the UTC date, which is also "today" in NL except 00:00 UTC).
  return new Date().toISOString().slice(0, 10);
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1).trimEnd() + '...';
}

// ── Public API ───────────────────────────────────────────────

export async function sendDailyBriefingPushes(): Promise<void> {
  const startedAt = Date.now();
  logger.info('push.daily_briefing.start');

  // Pre-filter on push_subscriptions so we do not waste time on
  // users without an active subscription.
  const targetsResult = await db.query<PushTargetRow>(
    `SELECT DISTINCT
       t.id AS tenant_id,
       u.id AS user_id,
       u.first_name
     FROM tenants t
     JOIN users u ON u.tenant_id = t.id AND u.role = 'owner'
     JOIN tenant_subscriptions ts
       ON ts.tenant_id = t.id
      AND ts.status IN ('active', 'trialing')
     WHERE t.id IN (
       SELECT DISTINCT tenant_id
         FROM tenant_integrations
        WHERE status = 'active'
     )
       AND u.id IN (
         SELECT DISTINCT user_id
           FROM push_subscriptions
          WHERE disabled_at IS NULL
       )
     ORDER BY t.id`,
    [],
    { allowNoTenant: true },
  );

  const targets = targetsResult.rows;
  logger.info('push.daily_briefing.targets', { count: targets.length });

  const dateTag = todayDateTag();

  let pushed       = 0;
  let skipped      = 0;
  let failed       = 0;
  let subsSent     = 0;
  let subsDisabled = 0;

  for (const row of targets) {
    try {
      // 1. Load today's briefing. DB cache hit when email cron
      //    already ran in this UTC day, so zero AI tokens.
      const briefing = await briefingsService.getOrGenerateForToday(
        row.tenant_id,
        'email_cron',
      );

      const topAction = pickTopAction(briefing.actions);

      // 2. Build the payload. iOS Safari trims push bodies fairly
      //    aggressively, so keep under ~100 chars.
      const body = topAction
        ? truncate(topAction.title, 100)
        : "View today's AI insights for your store.";

      const payload: PushPayload = {
        title: '\u{1F4CA} Your daily briefing is ready',
        body,
        url:   '/dashboard/ai-insights',
        tag:   `daily-briefing-${dateTag}`,
      };

      // 3. Send to every active subscription for this user. The
      //    service soft-disables endpoints that return 404/410.
      const result = await pushNotificationService.sendToUser(
        row.user_id,
        payload,
      );

      if (result.sent > 0) {
        pushed   += 1;
        subsSent += result.sent;
      } else {
        skipped += 1;
      }
      subsDisabled += result.disabled;

      logger.info('push.daily_briefing.user', {
        tenantId:  row.tenant_id,
        userId:    row.user_id,
        sent:      result.sent,
        failed:    result.failed,
        disabled:  result.disabled,
        hasAction: !!topAction,
      });
    } catch (err) {
      failed += 1;
      logger.error('push.daily_briefing.user_failed', {
        tenantId: row.tenant_id,
        userId:   row.user_id,
        error:    (err as Error).message,
      });
    }
  }

  logger.info('push.daily_briefing.complete', {
    total:      targets.length,
    pushed,
    skipped,
    failed,
    subsSent,
    subsDisabled,
    durationMs: Date.now() - startedAt,
  });
}
