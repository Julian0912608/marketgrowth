// ============================================================
// src/modules/auth/api/auth.routes.ts
// ============================================================

import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { AuthService } from '../service/auth.service';
import { rateLimitAuth } from '../../../shared/middleware/rate-limit';
import { tenantMiddleware } from '../../../shared/middleware/tenant.middleware';
import { getTenantContext } from '../../../shared/middleware/tenant-context';
import { db } from '../../../infrastructure/database/connection';
import bcrypt from 'bcryptjs';

const router = Router();
const authService = new AuthService();

// ── Zod schemas ──────────────────────────────────────────────
const RegisterSchema = z.object({
  email:       z.string().email('Ongeldig e-mailadres'),
  password:    z.string().min(8, 'Wachtwoord moet minimaal 8 tekens zijn'),
  firstName:   z.string().min(1, 'Voornaam is verplicht').max(100),
  lastName:    z.string().min(1, 'Achternaam is verplicht').max(100),
  companyName: z.string().min(1, 'Bedrijfsnaam is verplicht').max(200),
});

const LoginSchema = z.object({
  email:    z.string().email(),
  password: z.string().min(1),
});

const ResetRequestSchema = z.object({
  email: z.string().email(),
});

const ResetConfirmSchema = z.object({
  token:       z.string().min(1),
  newPassword: z.string().min(8),
});

const UpdateProfileSchema = z.object({
  firstName: z.string().min(1).max(100),
  lastName:  z.string().min(1).max(100),
});

const ChangePasswordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword:     z.string().min(8, 'Nieuw wachtwoord moet minimaal 8 tekens zijn'),
});

function validate<T>(schema: z.ZodSchema<T>, data: unknown): T {
  const result = schema.safeParse(data);
  if (!result.success) {
    const messages = result.error.errors.map(e => e.message).join(', ');
    throw Object.assign(new Error(messages), { httpStatus: 400 });
  }
  return result.data;
}

// ── POST /api/auth/register ──────────────────────────────────
router.post('/register', rateLimitAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const input = validate(RegisterSchema, req.body);
    const { user, tokens } = await authService.register(input);

    res.cookie('refreshToken', tokens.refreshToken, {
      httpOnly: true,
      secure:   process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      maxAge:   30 * 24 * 60 * 60 * 1000,
      path:     '/api/auth',
    });

    res.status(201).json({
      accessToken: tokens.accessToken,
      expiresIn:   tokens.expiresIn,
      user: {
        userId:    user.userId,
        email:     user.email,
        firstName: user.firstName,
        lastName:  user.lastName,
        role:      user.role,
        planSlug:  user.planSlug,
      },
    });
  } catch (err) { next(err); }
});

// ── POST /api/auth/login ─────────────────────────────────────
router.post('/login', rateLimitAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const input = validate(LoginSchema, req.body);
    const { user, tokens } = await authService.login(input);

    res.cookie('refreshToken', tokens.refreshToken, {
      httpOnly: true,
      secure:   process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      maxAge:   30 * 24 * 60 * 60 * 1000,
      path:     '/api/auth',
    });

    res.json({
      accessToken: tokens.accessToken,
      expiresIn:   tokens.expiresIn,
      user: {
        userId:    user.userId,
        email:     user.email,
        firstName: user.firstName,
        lastName:  user.lastName,
        role:      user.role,
        planSlug:  user.planSlug,
      },
    });
  } catch (err) { next(err); }
});

// ── POST /api/auth/refresh ───────────────────────────────────
router.post('/refresh', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const refreshToken = req.cookies?.refreshToken;
    if (!refreshToken) {
      res.status(401).json({ error: 'Geen actieve sessie gevonden.' });
      return;
    }

    const tokens = await authService.refreshTokens(refreshToken);

    res.cookie('refreshToken', tokens.refreshToken, {
      httpOnly: true,
      secure:   process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      maxAge:   30 * 24 * 60 * 60 * 1000,
      path:     '/api/auth',
    });

    res.json({ accessToken: tokens.accessToken, expiresIn: tokens.expiresIn });
  } catch (err) { next(err); }
});

// ── POST /api/auth/logout ────────────────────────────────────
router.post('/logout', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const refreshToken = req.cookies?.refreshToken;
    if (refreshToken) await authService.logout(refreshToken);
    res.clearCookie('refreshToken', { path: '/api/auth' });
    res.json({ success: true });
  } catch (err) { next(err); }
});

// ── POST /api/auth/password/reset-request ───────────────────
router.post('/password/reset-request', rateLimitAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { email } = validate(ResetRequestSchema, req.body);
    await authService.requestPasswordReset(email);
    res.json({ message: 'Als dit e-mailadres bekend is, ontvang je een reset-link.' });
  } catch (err) { next(err); }
});

// ── POST /api/auth/password/reset-confirm ───────────────────
router.post('/password/reset-confirm', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { token, newPassword } = validate(ResetConfirmSchema, req.body);
    await authService.resetPassword(token, newPassword);
    res.json({ message: 'Wachtwoord succesvol gewijzigd. Je kunt nu inloggen.' });
  } catch (err) { next(err); }
});

// ── PATCH /api/auth/profile ──────────────────────────────────
// Update naam van de ingelogde gebruiker
router.patch('/profile', tenantMiddleware(), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { firstName, lastName } = validate(UpdateProfileSchema, req.body);
    const { userId } = getTenantContext();

    await db.query(
      `UPDATE users SET first_name = $1, last_name = $2, updated_at = now() WHERE id = $3`,
      [firstName, lastName, userId],
      { allowNoTenant: true }
    );

    res.json({ success: true, firstName, lastName });
  } catch (err) { next(err); }
});

// ── POST /api/auth/change-password ──────────────────────────
// Wijzig wachtwoord terwijl ingelogd
router.post('/change-password', tenantMiddleware(), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { currentPassword, newPassword } = validate(ChangePasswordSchema, req.body);
    const { userId } = getTenantContext();

    // Haal huidig wachtwoord op
    const result = await db.query<{ password_hash: string }>(
      `SELECT password_hash FROM users WHERE id = $1`,
      [userId],
      { allowNoTenant: true }
    );

    if (!result.rows[0]) {
      res.status(404).json({ error: 'Gebruiker niet gevonden.' });
      return;
    }

    const valid = await bcrypt.compare(currentPassword, result.rows[0].password_hash);
    if (!valid) {
      res.status(400).json({ message: 'Huidig wachtwoord is onjuist.' });
      return;
    }

    const newHash = await bcrypt.hash(newPassword, 12);
    await db.query(
      `UPDATE users SET password_hash = $1, updated_at = now() WHERE id = $2`,
      [newHash, userId],
      { allowNoTenant: true }
    );

    res.json({ success: true, message: 'Wachtwoord succesvol gewijzigd.' });
  } catch (err) { next(err); }
});

// ── GET /api/auth/me ─────────────────────────────────────────
// Haal actuele user data op (voor frontend state refresh)
router.get('/me', tenantMiddleware(), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { userId } = getTenantContext();

    const result = await db.query<{
      id: string; email: string; first_name: string;
      last_name: string; role: string;
    }>(
      `SELECT id, email, first_name, last_name, role FROM users WHERE id = $1`,
      [userId],
      { allowNoTenant: true }
    );

    if (!result.rows[0]) {
      res.status(404).json({ error: 'Gebruiker niet gevonden.' });
      return;
    }

    const u = result.rows[0];
    res.json({
      userId:    u.id,
      email:     u.email,
      firstName: u.first_name,
      lastName:  u.last_name,
      role:      u.role,
    });
  } catch (err) { next(err); }
});

export { router as authRouter };
