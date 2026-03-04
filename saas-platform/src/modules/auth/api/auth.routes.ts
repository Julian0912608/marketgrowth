// ============================================================
// src/modules/auth/api/auth.routes.ts
// Publieke routes — geen tenantMiddleware vereist.
// ============================================================

import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { AuthService } from '../service/auth.service';
import { rateLimitAuth } from '../../../shared/middleware/rate-limit';

const router = Router();
const authService = new AuthService();

// ── Input validatie schemas (Zod) ────────────────────────────
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

const RefreshSchema = z.object({
  refreshToken: z.string().min(1),
});

const ResetRequestSchema = z.object({
  email: z.string().email(),
});

const ResetConfirmSchema = z.object({
  token:       z.string().min(1),
  newPassword: z.string().min(8),
});

// ── Helper: valideer input en gooi nette fout bij schending ──
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

    // Refresh token als HttpOnly cookie instellen (veiliger dan in JSON)
    res.cookie('refreshToken', tokens.refreshToken, {
      httpOnly: true,
      secure:   process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      maxAge:   30 * 24 * 60 * 60 * 1000,  // 30 dagen in ms
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
        planSlug:  user.planSlug,
      },
    });
  } catch (err) {
    next(err);
  }
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
  } catch (err) {
    next(err);
  }
});

// ── POST /api/auth/refresh ───────────────────────────────────
router.post('/refresh', async (req: Request, res: Response, next: NextFunction) => {
  try {
    // Refresh token komt uit HttpOnly cookie
    const refreshToken = req.cookies?.refreshToken;
    if (!refreshToken) {
      res.status(401).json({ error: 'Geen actieve sessie gevonden.' });
      return;
    }

    const tokens = await authService.refreshTokens(refreshToken);

    // Nieuwe refresh token als cookie instellen
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
    });
  } catch (err) {
    next(err);
  }
});

// ── POST /api/auth/logout ────────────────────────────────────
router.post('/logout', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const refreshToken = req.cookies?.refreshToken;
    if (refreshToken) {
      await authService.logout(refreshToken);
    }
    res.clearCookie('refreshToken', { path: '/api/auth' });
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

// ── POST /api/auth/password/reset-request ───────────────────
router.post('/password/reset-request', rateLimitAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { email } = validate(ResetRequestSchema, req.body);
    await authService.requestPasswordReset(email);
    // Altijd succes — zie auth.service.ts voor uitleg
    res.json({ message: 'Als dit e-mailadres bekend is, ontvang je een reset-link.' });
  } catch (err) {
    next(err);
  }
});

// ── POST /api/auth/password/reset-confirm ───────────────────
router.post('/password/reset-confirm', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { token, newPassword } = validate(ResetConfirmSchema, req.body);
    await authService.resetPassword(token, newPassword);
    res.json({ message: 'Wachtwoord succesvol gewijzigd. Je kunt nu inloggen.' });
  } catch (err) {
    next(err);
  }
});

export { router as authRouter };
