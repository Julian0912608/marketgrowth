// ============================================================
// src/modules/admin/api/admin-push.routes.ts
//
// V0 Gap 5b: Admin smoke-test endpoint for push notifications.
//
// Mounted at /api/admin/push, authenticated via x-admin-session.
// Used by Julian to verify that the push pipeline works end-to-end
// on real devices without waiting for the 07:00 daily briefing cron.
// ============================================================

import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { db } from '../../../infrastructure/database/connection';
import { adminSessionService, AdminSession } from '../service/admin-session.service';
import { pushNotificationService, PushPayload } from '../../notifications/service/push-notifications.service';
import { logger } from '../../../shared/logging/logger';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const router = Router();

// ── Schemas ──────────────────────────────────────────────────

const TestPushSchema = z.object({
  title: z.string().min(1).max(120).optional(),
  body:  z.string().min(1).max(400).optional(),
  url:   z.string().min(1).max(500).optional(),
  tag:   z.string().min(1).max(100).optional(),
});

// ── Admin auth (header-based, same pattern as admin.routes.ts) ─

interface AuthedRequest extends Request {
  adminSession?: AdminSession;
}

async function adminAuth(
  req: AuthedRequest,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const token = req.headers['x-admin-session'] as string | undefined;

  if (!token) {
    res.status(401).json({ error: 'admin_session_required' });
    return;
  }

  const session = await adminSessionService.verify(token);
  if (!session) {
    res.status(401).json({ error: 'admin_session_invalid' });
    return;
  }

  req.adminSession = session;
  next();
}

function getRequestMeta(req: Request): { ip: string; userAgent: string } {
  return {
    ip:        (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim()
                ?? req.ip
                ?? req.socket?.remoteAddress
                ?? '',
    userAgent: req.headers['user-agent']?.substring(0, 500) ?? '',
  };
}

router.use(adminAuth);

// ── POST /api/admin/push/users/:userId/test ──────────────────
// Fires a test push to every active subscription of the given user.

router.post('/users/:userId/test', async (req: AuthedRequest, res: Response, next: NextFunction) => {
  try {
    const { userId } = req.params;
    if (!UUID_REGEX.test(userId)) {
      res.status(400).json({ error: 'invalid_user_id' });
      return;
    }

    const parsed = TestPushSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(422).json({
        error:  'validation_failed',
        issues: parsed.error.errors,
      });
      return;
    }

    // Confirm the user exists before attempting to send
    const userExists = await db.query<{ id: string }>(
      `SELECT id FROM users WHERE id = $1 LIMIT 1`,
      [userId],
      { allowNoTenant: true },
    );
    if (!userExists.rows[0]) {
      res.status(404).json({ error: 'user_not_found' });
      return;
    }

    const payload: PushPayload = {
      title: parsed.data.title ?? 'MarketGrow test',
      body:  parsed.data.body  ?? 'If you see this, web push is working.',
      url:   parsed.data.url   ?? '/dashboard',
      tag:   parsed.data.tag   ?? 'admin-test',
    };

    const result = await pushNotificationService.sendToUser(userId, payload);

    const meta = getRequestMeta(req);
    await adminSessionService.auditLog({
      sessionId: req.adminSession!.id,
      action:    'admin.push.test_sent',
      resource:  'user',
      targetId:  userId,
      ip:        meta.ip,
      userAgent: meta.userAgent,
      metadata:  { result, payload },
    });

    logger.info('admin.push.test_sent', { userId, result });

    res.json({ ok: true, result });
  } catch (err) {
    next(err);
  }
});

// ── GET /api/admin/push/users/:userId/subscriptions ──────────
// Inspect what devices a user has subscribed.

router.get('/users/:userId/subscriptions', async (req: AuthedRequest, res: Response, next: NextFunction) => {
  try {
    const { userId } = req.params;
    if (!UUID_REGEX.test(userId)) {
      res.status(400).json({ error: 'invalid_user_id' });
      return;
    }

    const result = await db.query<{
      id:            string;
      endpoint:      string;
      user_agent:    string | null;
      created_at:    Date;
      last_seen_at:  Date;
      disabled_at:   Date | null;
    }>(
      `SELECT id, endpoint, user_agent, created_at, last_seen_at, disabled_at
         FROM push_subscriptions
        WHERE user_id = $1
        ORDER BY created_at DESC`,
      [userId],
      { allowNoTenant: true },
    );

    res.json({
      subscriptions: result.rows.map(r => ({
        id:           r.id,
        // Truncate endpoint so we do not leak full FCM URL in admin UI
        endpointHost: (() => {
          try { return new URL(r.endpoint).host; } catch { return 'unknown'; }
        })(),
        userAgent:    r.user_agent,
        createdAt:    r.created_at.toISOString(),
        lastSeenAt:   r.last_seen_at.toISOString(),
        disabledAt:   r.disabled_at?.toISOString() ?? null,
        active:       r.disabled_at === null,
      })),
    });
  } catch (err) {
    next(err);
  }
});

export { router as adminPushRouter };
