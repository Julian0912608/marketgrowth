// saas-platform/src/modules/team/api/team.routes.ts
// Team management: uitnodigen, accepteren, verwijderen

import { Router, Request, Response, NextFunction } from 'express';
import { z }                                        from 'zod';
import { v4 as uuidv4 }                            from 'uuid';
import crypto                                       from 'crypto';
import bcrypt                                       from 'bcryptjs';
import jwt                                          from 'jsonwebtoken';
import { db }                from '../../../infrastructure/database/connection';
import { tenantMiddleware }  from '../../../shared/middleware/tenant.middleware';
import { getTenantContext }  from '../../../shared/middleware/tenant-context';
import { logger }            from '../../../shared/logging/logger';

const router = Router();

const JWT_SECRET     = () => process.env.JWT_SECRET || 'dev-secret';
const ACCESS_TTL     = '15m';
const REFRESH_TTL    = '30d';
const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const BCRYPT_ROUNDS  = 12;

function validate<T>(schema: z.ZodSchema<T>, data: unknown): T {
  const result = schema.safeParse(data);
  if (!result.success) {
    const msg = result.error.errors.map(e => e.message).join(', ');
    throw Object.assign(new Error(msg), { httpStatus: 400 });
  }
  return result.data;
}

function setRefreshCookie(res: Response, token: string) {
  res.cookie('refreshToken', token, {
    httpOnly: true,
    secure:   process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    maxAge:   REFRESH_TTL_MS,
    path:     '/api/auth',
  });
}

// ── Schemas ───────────────────────────────────────────────────
const InviteSchema = z.object({
  email: z.string().email(),
  role:  z.enum(['member', 'viewer']).default('member'),
});

const AcceptSchema = z.object({
  token:     z.string().min(10),
  firstName: z.string().min(1).max(100),
  lastName:  z.string().min(1).max(100),
  password:  z.string().min(8).max(200),
});

// ── PUBLIC: GET /api/team/invite/:token ───────────────────────
// Geen auth vereist — uitgenodigde heeft nog geen account
router.get('/invite/:token', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { token } = req.params;
    if (!token) {
      res.status(400).json({ error: 'Token ontbreekt' });
      return;
    }

    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');

    const result = await db.query(
      `SELECT ti.id, ti.email, ti.role, ti.expires_at,
              t.name AS tenant_name
       FROM team_invites ti
       JOIN tenants t ON t.id = ti.tenant_id
       WHERE ti.token_hash = $1
         AND ti.accepted_at IS NULL
         AND ti.expires_at > now()
       LIMIT 1`,
      [tokenHash],
      { allowNoTenant: true }
    );

    if (!result.rows[0]) {
      res.status(404).json({ error: 'Uitnodiging niet gevonden of verlopen.' });
      return;
    }

    const invite = result.rows[0];
    res.json({
      email:      invite.email,
      role:       invite.role,
      tenantName: invite.tenant_name,
      expiresAt:  invite.expires_at,
    });
  } catch (err) { next(err); }
});

// ── PUBLIC: POST /api/team/accept ─────────────────────────────
// Geen auth vereist — maakt account aan en accepteert uitnodiging
router.post('/accept', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { token, firstName, lastName, password } = validate(AcceptSchema, req.body);

    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');

    const inviteResult = await db.query(
      `SELECT ti.id, ti.email, ti.role, ti.tenant_id, ti.expires_at
       FROM team_invites ti
       WHERE ti.token_hash = $1
         AND ti.accepted_at IS NULL
         AND ti.expires_at > now()
       LIMIT 1`,
      [tokenHash],
      { allowNoTenant: true }
    );

    const invite = inviteResult.rows[0];
    if (!invite) {
      res.status(400).json({ error: 'Uitnodiging niet gevonden of verlopen.' });
      return;
    }

    // Controleer of email al bestaat
    const existing = await db.query(
      `SELECT id, status FROM users WHERE email = $1`,
      [invite.email.toLowerCase()],
      { allowNoTenant: true }
    );

    // Als de user bestaat maar deleted is, herstel het account
    if (existing.rows.length > 0 && existing.rows[0].status === 'deleted') {
      const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
      const userId = existing.rows[0].id;
      await db.query(
        `UPDATE users SET
           password_hash = $1, first_name = $2, last_name = $3,
           role = $4, status = 'active', updated_at = now()
         WHERE id = $5`,
        [passwordHash, firstName, lastName, invite.role, userId],
        { allowNoTenant: true }
      );
      // Markeer invite als geaccepteerd
      await db.query(
        `UPDATE team_invites SET accepted_at = now(), accepted_by = $1 WHERE id = $2`,
        [userId, invite.id],
        { allowNoTenant: true }
      );
      // Maak tokens aan en stuur terug
      const planResult = await db.query<{ slug: string }>(
        `SELECT p.slug FROM tenant_subscriptions ts
         JOIN plans p ON p.id = ts.plan_id
         WHERE ts.tenant_id = $1 AND ts.status IN ('active','trialing')
         ORDER BY ts.created_at DESC LIMIT 1`,
        [invite.tenant_id], { allowNoTenant: true }
      );
      const planSlug = planResult.rows[0]?.slug ?? 'starter';
      const accessToken = jwt.sign(
        { sub: userId, tenantId: invite.tenant_id, email: invite.email, planSlug, firstName, lastName, role: invite.role, type: 'access' },
        JWT_SECRET(), { expiresIn: ACCESS_TTL }
      );
      const refreshToken = jwt.sign(
        { sub: userId, tenantId: invite.tenant_id, type: 'refresh' },
        JWT_SECRET(), { expiresIn: REFRESH_TTL }
      );
      const refreshHash = crypto.createHash('sha256').update(refreshToken).digest('hex');
      await db.query(
        `INSERT INTO refresh_tokens (user_id, tenant_id, token_hash, expires_at, revoked)
         VALUES ($1, $2, $3, $4, false)`,
        [userId, invite.tenant_id, refreshHash, new Date(Date.now() + REFRESH_TTL_MS)],
        { allowNoTenant: true }
      );
      setRefreshCookie(res, refreshToken);
      res.json({ accessToken, user: { userId, email: invite.email, firstName, lastName, role: invite.role, planSlug } });
      return;
    }

    if (existing.rows.length > 0) {
      res.status(409).json({ error: 'Er bestaat al een account met dit e-mailadres.' });
      return;
    }

    const userId       = uuidv4();
    const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);

    // Maak gebruiker aan
    await db.query(
      `INSERT INTO users (id, tenant_id, email, password_hash, first_name, last_name, role, status, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'active', now(), now())`,
      [userId, invite.tenant_id, invite.email.toLowerCase(), passwordHash, firstName, lastName, invite.role],
      { allowNoTenant: true }
    );

    // Markeer uitnodiging als geaccepteerd
    await db.query(
      `UPDATE team_invites SET accepted_at = now(), accepted_by = $1 WHERE id = $2`,
      [userId, invite.id],
      { allowNoTenant: true }
    );

    // Haal plan slug op
    const planResult = await db.query<{ slug: string }>(
      `SELECT p.slug FROM tenant_subscriptions ts
       JOIN plans p ON p.id = ts.plan_id
       WHERE ts.tenant_id = $1 AND ts.status IN ('active','trialing')
       ORDER BY ts.created_at DESC LIMIT 1`,
      [invite.tenant_id],
      { allowNoTenant: true }
    );
    const planSlug = planResult.rows[0]?.slug ?? 'starter';

    // Maak tokens aan
    const accessToken = jwt.sign(
      { sub: userId, tenantId: invite.tenant_id, email: invite.email, planSlug, firstName, lastName, role: invite.role, type: 'access' },
      JWT_SECRET(),
      { expiresIn: ACCESS_TTL }
    );
    const refreshToken = jwt.sign(
      { sub: userId, tenantId: invite.tenant_id, type: 'refresh' },
      JWT_SECRET(),
      { expiresIn: REFRESH_TTL }
    );
    const refreshHash  = crypto.createHash('sha256').update(refreshToken).digest('hex');
    const refreshExpAt = new Date(Date.now() + REFRESH_TTL_MS);

    await db.query(
      `INSERT INTO refresh_tokens (user_id, tenant_id, token_hash, expires_at, revoked)
       VALUES ($1, $2, $3, $4, false)`,
      [userId, invite.tenant_id, refreshHash, refreshExpAt],
      { allowNoTenant: true }
    );

    setRefreshCookie(res, refreshToken);
    logger.info('team.accept.success', { userId, tenantId: invite.tenant_id });

    res.json({
      accessToken,
      user: { userId, email: invite.email, firstName, lastName, role: invite.role, planSlug },
    });
  } catch (err) { next(err); }
});

// ── Alle routes hieronder vereisen auth ───────────────────────
router.use(tenantMiddleware());

// ── GET /api/team/members ─────────────────────────────────────
router.get('/members', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { tenantId } = getTenantContext();

    const result = await db.query(
      `SELECT id, email, first_name, last_name, role, status, created_at, last_login_at
       FROM users
       WHERE tenant_id = $1 AND status != 'deleted'
       ORDER BY created_at ASC`,
      [tenantId]
    );

    res.json({ members: result.rows });
  } catch (err) { next(err); }
});

// ── GET /api/team/invites ─────────────────────────────────────
router.get('/invites', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { tenantId } = getTenantContext();

    const result = await db.query(
      `SELECT id, email, role, expires_at, accepted_at, created_at
       FROM team_invites
       WHERE tenant_id = $1
         AND expires_at > now()
         AND accepted_at IS NULL
       ORDER BY created_at DESC`,
      [tenantId]
    );

    res.json({ invites: result.rows });
  } catch (err) { next(err); }
});

// ── POST /api/team/invite ─────────────────────────────────────
router.post('/invite', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { tenantId } = getTenantContext();
    const { email, role } = validate(InviteSchema, req.body);

    // Check of gebruiker al actief bestaat in dit team
    const existingUser = await db.query(
      `SELECT id FROM users WHERE tenant_id = $1 AND email = $2 AND status != 'deleted'`,
      [tenantId, email.toLowerCase()]
    );
    if (existingUser.rows.length > 0) {
      res.status(409).json({ error: 'Dit e-mailadres is al lid van het team.' });
      return;
    }

    // Check bestaande open uitnodiging
    const existingInvite = await db.query(
      `SELECT id FROM team_invites
       WHERE tenant_id = $1 AND email = $2 AND accepted_at IS NULL AND expires_at > now()`,
      [tenantId, email.toLowerCase()]
    );
    if (existingInvite.rows.length > 0) {
      res.status(409).json({ error: 'Er staat al een openstaande uitnodiging voor dit e-mailadres.' });
      return;
    }

    // Genereer token
    const rawToken  = crypto.randomBytes(32).toString('hex');
    const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 dagen
    const inviteId  = uuidv4();

    // Haal tenant naam op
    const tenantResult = await db.query<{ name: string }>(
      `SELECT name FROM tenants WHERE id = $1`, [tenantId]
    );
    const tenantName = tenantResult.rows[0]?.name ?? 'je team';

    await db.query(
      `INSERT INTO team_invites (id, tenant_id, email, role, token_hash, expires_at, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, now())`,
      [inviteId, tenantId, email.toLowerCase(), role, tokenHash, expiresAt]
    );

    // Stuur uitnodigingsmail via Resend
    const frontendUrl  = process.env.FRONTEND_URL ?? 'https://marketgrow.ai';
    const inviteUrl    = `${frontendUrl}/team/accept?token=${rawToken}`;
    const resendApiKey = process.env.RESEND_API_KEY;

    if (resendApiKey) {
      await fetch('https://api.resend.com/emails', {
        method:  'POST',
        headers: {
          'Authorization': `Bearer ${resendApiKey}`,
          'Content-Type':  'application/json',
        },
        body: JSON.stringify({
          from:    'MarketGrow <noreply@marketgrow.ai>',
          to:      [email],
          subject: `You've been invited to join ${tenantName} on MarketGrow`,
          html:    `
            <div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:32px 24px;background:#0f172a;color:#f8fafc;border-radius:16px">
              <h2 style="margin:0 0 8px;font-size:20px">You've been invited 👋</h2>
              <p style="color:#94a3b8;margin:0 0 24px">
                You've been invited to join <strong style="color:#fff">${tenantName}</strong> on MarketGrow.
              </p>
              <a href="${inviteUrl}"
                 style="display:inline-block;background:#4f46e5;color:#fff;font-weight:600;padding:12px 24px;border-radius:10px;text-decoration:none;font-size:14px">
                Accept invitation →
              </a>
              <p style="color:#475569;font-size:12px;margin-top:24px">
                This invitation expires in 7 days. If you didn't expect this, you can ignore it.
              </p>
            </div>
          `,
        }),
      }).catch(err => logger.warn('team.invite.email_failed', { error: err.message }));
    }

    logger.info('team.invite.sent', { tenantId, email, inviteId });
    res.json({ success: true, inviteId, expiresAt });
  } catch (err) { next(err); }
});

// ── DELETE /api/team/members/:id ──────────────────────────────
router.delete('/members/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { tenantId, userId } = getTenantContext();
    const targetId = req.params.id;

    if (targetId === userId) {
      res.status(400).json({ error: 'Je kunt jezelf niet verwijderen.' });
      return;
    }

    await db.query(
      `UPDATE users SET status = 'deleted', updated_at = now()
       WHERE id = $1 AND tenant_id = $2 AND role != 'owner'`,
      [targetId, tenantId]
    );

    res.json({ success: true });
  } catch (err) { next(err); }
});

// ── DELETE /api/team/invites/:id ──────────────────────────────
router.delete('/invites/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { tenantId } = getTenantContext();

    await db.query(
      `UPDATE team_invites SET expires_at = now() WHERE id = $1 AND tenant_id = $2`,
      [req.params.id, tenantId]
    );

    res.json({ success: true });
  } catch (err) { next(err); }
});

export { router as teamRouter };
