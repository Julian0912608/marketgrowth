// saas-platform/src/modules/auth/api/auth.routes.ts
//
// SECURITY UPDATE:
//   - IP + User-Agent doorgeven aan auth service voor audit logs
//   - Refresh route stuurt nieuw refresh token cookie terug (rotation)
//   - DELETE /api/auth/account voor GDPR data verwijdering

import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { AuthService } from '../service/auth.service';
import { rateLimitAuth } from '../../../shared/middleware/rate-limit';
import { tenantMiddleware } from '../../../shared/middleware/tenant.middleware';
import { getTenantContext } from '../../../shared/middleware/tenant-context';
import { db } from '../../../infrastructure/database/connection';
import bcrypt from 'bcryptjs';

const router      = Router();
const authService = new AuthService();

// ── Zod schemas ───────────────────────────────────────────────

const RegisterSchema = z.object({
  email:       z.string().email('Ongeldig e-mailadres'),
  password:    z.string().min(8, 'Wachtwoord moet minimaal 8 tekens zijn').max(128),
  firstName:   z.string().min(1).max(100),
  lastName:    z.string().min(1).max(100),
  companyName: z.string().min(1).max(200).optional(),
});

const LoginSchema = z.object({
  email:    z.string().email(),
  password: z.string().min(1).max(128),
});

const ResetRequestSchema = z.object({
  email: z.string().email(),
});

const ResetConfirmSchema = z.object({
  token:       z.string().min(1).max(200),
  newPassword: z.string().min(8).max(128),
});

const UpdateProfileSchema = z.object({
  firstName: z.string().min(1).max(100),
  lastName:  z.string().min(1).max(100),
});

const ChangePasswordSchema = z.object({
  currentPassword: z.string().min(1).max(128),
  newPassword:     z.string().min(8).max(128),
});

const DeleteAccountSchema = z.object({
  password:    z.string().min(1).max(128),
  confirmText: z.literal('VERWIJDER MIJN ACCOUNT'),
});

function validate<T>(schema: z.ZodSchema<T>, data: unknown): T {
  const result = schema.safeParse(data);
  if (!result.success) {
    const messages = result.error.errors.map(e => e.message).join(', ');
    throw Object.assign(new Error(messages), { httpStatus: 400 });
  }
  return result.data;
}

function getMeta(req: Request) {
  return {
    ip: req.ip ?? req.socket?.remoteAddress,
    ua: req.headers['user-agent']?.substring(0, 500),
  };
}

function setRefreshCookie(res: Response, token: string) {
  res.cookie('refreshToken', token, {
    httpOnly: true,
    secure:   process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    maxAge:   30 * 24 * 60 * 60 * 1000,
    path:     '/api/auth',
  });
}

// ── POST /api/auth/register ───────────────────────────────────
router.post('/register', rateLimitAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const input  = validate(RegisterSchema, req.body);
    const result = await authService.register(input, getMeta(req)) as any;
    const { user, tokens } = result;

    setRefreshCookie(res, tokens.refreshToken);

    res.status(201).json({
      accessToken: tokens.accessToken,
      expiresIn:   tokens.expiresIn,
      user: {
        userId:    user.userId || user.id,
        email:     user.email,
        firstName: user.firstName,
        lastName:  user.lastName,
        role:      user.role,
        planSlug:  user.planSlug,
      },
    });
  } catch (err) { next(err); }
});

// ── POST /api/auth/login ──────────────────────────────────────
router.post('/login', rateLimitAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const input  = validate(LoginSchema, req.body);
    const result = await authService.login(input, getMeta(req)) as any;
    const { user, tokens } = result;

    setRefreshCookie(res, tokens.refreshToken);

    res.json({
      accessToken: tokens.accessToken,
      expiresIn:   tokens.expiresIn,
      user: {
        userId:    user.userId || user.id,
        email:     user.email,
        firstName: user.firstName,
        lastName:  user.lastName,
        role:      user.role,
        planSlug:  user.planSlug,
      },
    });
  } catch (err) { next(err); }
});

// ── POST /api/auth/refresh ────────────────────────────────────
// Geeft nieuw access token + rotated refresh token terug
router.post('/refresh', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const refreshToken = req.cookies?.refreshToken;
    if (!refreshToken) {
      res.status(401).json({ error: 'Geen actieve sessie gevonden.' });
      return;
    }

    const result = await authService.refreshAccessToken(refreshToken, getMeta(req));

    // ✅ Stuur nieuw refresh token cookie terug (rotation)
    setRefreshCookie(res, result.refreshToken);

    res.json({
      accessToken: result.accessToken,
      expiresIn:   result.expiresIn,
    });
  } catch (err) { next(err); }
});

// ── POST /api/auth/logout ─────────────────────────────────────
router.post('/logout', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const refreshToken = req.cookies?.refreshToken;
    if (refreshToken) {
      await authService.logout(refreshToken, getMeta(req));
    }
    res.clearCookie('refreshToken', { path: '/api/auth' });
    res.json({ success: true });
  } catch (err) { next(err); }
});

// ── GET /api/auth/me ──────────────────────────────────────────
router.get('/me', tenantMiddleware(), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { userId } = getTenantContext();
    const profile    = await authService.getProfile(userId);
    res.json(profile);
  } catch (err) { next(err); }
});

// ── PUT /api/auth/profile ─────────────────────────────────────
router.put('/profile', tenantMiddleware(), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { userId } = getTenantContext();
    const { firstName, lastName } = validate(UpdateProfileSchema, req.body);

    await db.query(
      `UPDATE users SET first_name = $1, last_name = $2, updated_at = now() WHERE id = $3`,
      [firstName, lastName, userId],
      { allowNoTenant: true }
    );

    res.json({ success: true, firstName, lastName });
  } catch (err) { next(err); }
});

// ── POST /api/auth/change-password ────────────────────────────
router.post('/change-password', tenantMiddleware(), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { userId, tenantId } = getTenantContext();
    const { currentPassword, newPassword } = validate(ChangePasswordSchema, req.body);

    const userResult = await db.query<{ password_hash: string }>(
      `SELECT password_hash FROM users WHERE id = $1`,
      [userId], { allowNoTenant: true }
    );

    const valid = await bcrypt.compare(currentPassword, userResult.rows[0]?.password_hash || '');
    if (!valid) {
      res.status(401).json({ error: 'Huidig wachtwoord klopt niet' });
      return;
    }

    const newHash = await bcrypt.hash(newPassword, 12);
    await db.query(
      `UPDATE users SET password_hash = $1, updated_at = now() WHERE id = $2`,
      [newHash, userId], { allowNoTenant: true }
    );

    // Trek alle andere sessies in na wachtwoord wijziging
    const refreshToken = req.cookies?.refreshToken;
    if (refreshToken) {
      const crypto = await import('crypto');
      const currentHash = crypto.createHash('sha256').update(refreshToken).digest('hex');
      await db.query(
        `UPDATE refresh_tokens SET revoked = true WHERE user_id = $1 AND token_hash != $2`,
        [userId, currentHash], { allowNoTenant: true }
      );
    }

    await db.query(
      `INSERT INTO audit_logs (tenant_id, user_id, action, ip_address)
       VALUES ($1, $2, 'auth.password_changed', $3)`,
      [tenantId, userId, req.ip], { allowNoTenant: true }
    );

    res.json({ success: true });
  } catch (err) { next(err); }
});

// ── POST /api/auth/forgot-password ───────────────────────────
router.post('/forgot-password', rateLimitAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { email } = validate(ResetRequestSchema, req.body);
    await authService.requestPasswordReset(email, getMeta(req));
    // Altijd dezelfde response — voorkomt user enumeration
    res.json({ success: true, message: 'Als dit e-mailadres bekend is, ontvang je een reset link.' });
  } catch (err) { next(err); }
});

// ── POST /api/auth/reset-password ────────────────────────────
router.post('/reset-password', rateLimitAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { token, newPassword } = validate(ResetConfirmSchema, req.body);
    await authService.resetPassword(token, newPassword, getMeta(req));
    res.json({ success: true });
  } catch (err) { next(err); }
});

// ── DELETE /api/auth/account — GDPR data verwijdering ────────
router.delete('/account', tenantMiddleware(), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { userId, tenantId } = getTenantContext();
    const { password } = validate(DeleteAccountSchema, req.body);

    // Wachtwoord bevestiging vereist
    const userResult = await db.query<{ password_hash: string }>(
      `SELECT password_hash FROM users WHERE id = $1`,
      [userId], { allowNoTenant: true }
    );

    const valid = await bcrypt.compare(password, userResult.rows[0]?.password_hash || '');
    if (!valid) {
      res.status(401).json({ error: 'Wachtwoord klopt niet' });
      return;
    }

    // Audit log VOOR de verwijdering (daarna is de data weg)
    await db.query(
      `INSERT INTO audit_logs (tenant_id, user_id, action, ip_address, metadata)
       VALUES ($1, $2, 'auth.account_deleted', $3, $4)`,
      [tenantId, userId, req.ip, JSON.stringify({ requestedAt: new Date().toISOString() })],
      { allowNoTenant: true }
    );

    // Hard delete alle tenant data via de GDPR functie
    await db.query(
      `SELECT delete_tenant_data($1)`,
      [tenantId],
      { allowNoTenant: true }
    );

    res.clearCookie('refreshToken', { path: '/api/auth' });
    res.json({ success: true, message: 'Account en alle data zijn verwijderd.' });
  } catch (err) { next(err); }
});

export { router as authRouter };
