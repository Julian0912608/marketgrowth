// ============================================================
// src/modules/team/api/team.routes.ts
//
// Team accounts voor Scale plan:
//   GET    /api/team/members        — lijst van teamleden
//   POST   /api/team/invite         — uitnodigen via email
//   DELETE /api/team/members/:id    — lid verwijderen
//   PATCH  /api/team/members/:id    — rol wijzigen
//   POST   /api/team/accept/:token  — uitnodiging accepteren (public)
// ============================================================

import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import { v4 as uuidv4 } from 'uuid';
import { db }              from '../../../infrastructure/database/connection';
import { getTenantContext } from '../../../shared/middleware/tenant-context';
import { tenantMiddleware } from '../../../shared/middleware/tenant.middleware';
import { featureGate }     from '../../../shared/middleware/feature-gate.middleware';
import { logger }          from '../../../shared/logging/logger';

const router = Router();
router.use(tenantMiddleware());

const RESEND_KEY = process.env.RESEND_API_KEY ?? '';
const APP_URL    = process.env.APP_URL ?? process.env.FRONTEND_URL ?? 'https://marketgrow.ai';
const INVITE_TTL_HOURS = 48;

// ── Zod schemas ───────────────────────────────────────────────
const InviteSchema = z.object({
  email: z.string().email(),
  role:  z.enum(['admin', 'member', 'viewer']).default('member'),
});

const UpdateRoleSchema = z.object({
  role: z.enum(['admin', 'member', 'viewer']),
});

const AcceptSchema = z.object({
  password:  z.string().min(8).max(128),
  firstName: z.string().min(1).max(100),
  lastName:  z.string().min(1).max(100),
});

function validate<T>(schema: z.ZodSchema<T>, data: unknown): T {
  const result = schema.safeParse(data);
  if (!result.success) {
    const msg = result.error.errors.map(e => e.message).join(', ');
    throw Object.assign(new Error(msg), { httpStatus: 400 });
  }
  return result.data;
}

async function sendInviteEmail(to: string, inviterName: string, tenantName: string, token: string): Promise<void> {
  if (!RESEND_KEY) return;
  const url = `${APP_URL}/team/accept?token=${token}`;
  try {
    await fetch('https://api.resend.com/emails', {
      method:  'POST',
      headers: { 'Authorization': `Bearer ${RESEND_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from:    'MarketGrow <hello@marketgrow.ai>',
        to:      [to],
        subject: `${inviterName} invited you to join ${tenantName} on MarketGrow`,
        html: `
          <div style="font-family:sans-serif;max-width:480px;padding:32px">
            <h2 style="color:#0f172a">You've been invited!</h2>
            <p style="color:#475569">${inviterName} has invited you to join <strong>${tenantName}</strong> on MarketGrow.</p>
            <p style="margin:24px 0">
              <a href="${url}" style="background:#4f46e5;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:600">
                Accept invitation →
              </a>
            </p>
            <p style="color:#94a3b8;font-size:12px">This invitation expires in ${INVITE_TTL_HOURS} hours. If you didn't expect this, you can safely ignore it.</p>
          </div>
        `,
      }),
    });
  } catch (err) {
    logger.error('team.invite.email.failed', { to, error: (err as Error).message });
  }
}

// ── GET /api/team/members ─────────────────────────────────────
router.get('/members', featureGate('team-accounts'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { tenantId } = getTenantContext();

    const result = await db.query(
      `SELECT
         u.id, u.email, u.first_name, u.last_name, u.role, u.status, u.created_at,
         u.last_login_at
       FROM users u
       WHERE u.tenant_id = $1
       ORDER BY u.created_at ASC`,
      [tenantId]
    );

    // Haal ook pending invites op
    const invites = await db.query(
      `SELECT id, email, role, created_at, expires_at
       FROM team_invites
       WHERE tenant_id = $1 AND accepted_at IS NULL AND expires_at > now()
       ORDER BY created_at DESC`,
      [tenantId],
      { allowNoTenant: true }
    );

    res.json({
      members: result.rows.map(u => ({
        id:        u.id,
        email:     u.email,
        firstName: u.first_name,
        lastName:  u.last_name,
        role:      u.role,
        status:    u.status,
        joinedAt:  u.created_at,
        lastLoginAt: u.last_login_at,
      })),
      pendingInvites: invites.rows,
    });
  } catch (err) { next(err); }
});

// ── POST /api/team/invite ─────────────────────────────────────
router.post('/invite', featureGate('team-accounts'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { tenantId, userId } = getTenantContext();
    const { email, role } = validate(InviteSchema, req.body);

    // Check of email al bestaat in deze tenant
    const existing = await db.query(
      `SELECT id FROM users WHERE tenant_id = $1 AND email = $2`,
      [tenantId, email.toLowerCase()]
    );
    if (existing.rows.length > 0) {
      res.status(409).json({ error: 'User is already a member of this team.' });
      return;
    }

    // Verwijder eventuele oude pending invite voor dit email
    await db.query(
      `DELETE FROM team_invites WHERE tenant_id = $1 AND email = $2`,
      [tenantId, email.toLowerCase()],
      { allowNoTenant: true }
    );

    const token     = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + INVITE_TTL_HOURS * 3600 * 1000);

    await db.query(
      `INSERT INTO team_invites (id, tenant_id, email, role, invited_by, token, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [uuidv4(), tenantId, email.toLowerCase(), role, userId, token, expiresAt],
      { allowNoTenant: true }
    );

    // Haal naam van inviter en tenant op voor de email
    const inviterResult = await db.query<{ first_name: string; tenant_name: string }>(
      `SELECT u.first_name, t.name AS tenant_name
       FROM users u JOIN tenants t ON t.id = u.tenant_id
       WHERE u.id = $1`,
      [userId], { allowNoTenant: true }
    );
    const inviter = inviterResult.rows[0];

    await sendInviteEmail(
      email,
      inviter ? `${inviter.first_name}` : 'A teammate',
      inviter?.tenant_name ?? 'your team',
      token
    );

    logger.info('team.invite.sent', { tenantId, email, role });
    res.json({ success: true, message: `Invitation sent to ${email}` });
  } catch (err) { next(err); }
});

// ── POST /api/team/accept/:token ──────────────────────────────
// Publieke route — geen tenantMiddleware
router.post('/accept/:token', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { token } = req.params;
    const { password, firstName, lastName } = validate(AcceptSchema, req.body);

    const invite = await db.query<{
      id: string; tenant_id: string; email: string; role: string; expires_at: Date;
    }>(
      `SELECT id, tenant_id, email, role, expires_at
       FROM team_invites
       WHERE token = $1 AND accepted_at IS NULL AND expires_at > now()`,
      [token], { allowNoTenant: true }
    );

    if (!invite.rows[0]) {
      res.status(404).json({ error: 'Invalid or expired invitation.' });
      return;
    }

    const inv = invite.rows[0];
    const passwordHash = await bcrypt.hash(password, 12);
    const userId = uuidv4();

    await db.query(
      `INSERT INTO users (id, tenant_id, email, password_hash, first_name, last_name, role, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'active')`,
      [userId, inv.tenant_id, inv.email, passwordHash, firstName, lastName, inv.role],
      { allowNoTenant: true }
    );

    await db.query(
      `UPDATE team_invites SET accepted_at = now() WHERE id = $1`,
      [inv.id], { allowNoTenant: true }
    );

    logger.info('team.invite.accepted', { tenantId: inv.tenant_id, email: inv.email, role: inv.role });
    res.json({ success: true, message: 'Account created. You can now log in.' });
  } catch (err) { next(err); }
});

// ── PATCH /api/team/members/:id ───────────────────────────────
router.patch('/members/:id', featureGate('team-accounts'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { tenantId, userId: currentUserId } = getTenantContext();
    const { id } = req.params;
    const { role } = validate(UpdateRoleSchema, req.body);

    // Kan jezelf niet downgraden
    if (id === currentUserId) {
      res.status(400).json({ error: 'You cannot change your own role.' });
      return;
    }

    await db.query(
      `UPDATE users SET role = $2, updated_at = now()
       WHERE id = $1 AND tenant_id = $3`,
      [id, role, tenantId]
    );

    logger.info('team.member.role_changed', { tenantId, memberId: id, role });
    res.json({ success: true });
  } catch (err) { next(err); }
});

// ── DELETE /api/team/members/:id ──────────────────────────────
router.delete('/members/:id', featureGate('team-accounts'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { tenantId, userId: currentUserId } = getTenantContext();
    const { id } = req.params;

    if (id === currentUserId) {
      res.status(400).json({ error: 'You cannot remove yourself.' });
      return;
    }

    // Verwijder user maar houd audit trail intact — zet status op inactive
    await db.query(
      `UPDATE users SET status = 'inactive', updated_at = now()
       WHERE id = $1 AND tenant_id = $2`,
      [id, tenantId]
    );

    logger.info('team.member.removed', { tenantId, memberId: id });
    res.json({ success: true });
  } catch (err) { next(err); }
});

// ── DELETE /api/team/invites/:id ──────────────────────────────
router.delete('/invites/:id', featureGate('team-accounts'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { tenantId } = getTenantContext();
    const { id } = req.params;

    await db.query(
      `DELETE FROM team_invites WHERE id = $1 AND tenant_id = $2`,
      [id, tenantId], { allowNoTenant: true }
    );

    res.json({ success: true });
  } catch (err) { next(err); }
});

export { router as teamRouter };
