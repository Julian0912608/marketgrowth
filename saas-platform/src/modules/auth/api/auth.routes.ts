// src/modules/auth/api/auth.routes.ts
import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { AuthService } from '../service/auth.service';
import { authenticate } from '../../../shared/middleware/auth.middleware';
import { logger } from '../../../shared/logging/logger';

export const authRouter = Router();
const authService = new AuthService();

// Schemas
const registerSchema = z.object({
  firstName: z.string().min(1).max(50),
  lastName:  z.string().min(1).max(50),
  email:     z.string().email(),
  password:  z.string().min(8).max(100),
  planSlug:  z.enum(['starter', 'growth', 'pro']).optional().default('starter'),
});

const loginSchema = z.object({
  email:    z.string().email(),
  password: z.string().min(1),
});

// ── POST /api/auth/register ───────────────────────────────────
authRouter.post('/register', async (req: Request, res: Response) => {
  try {
    const input = registerSchema.parse(req.body);
    const result = await authService.register(input);

    // Sla refresh token op als HTTP-only cookie
    res.cookie('refreshToken', result.refreshToken, {
      httpOnly: true,
      secure:   process.env.NODE_ENV === 'production',
      sameSite: 'none',
      maxAge:   30 * 24 * 60 * 60 * 1000, // 30 dagen
      path:     '/api/auth',
    });

    res.status(201).json({
      accessToken: result.accessToken,
      user:        result.user,
    });
  } catch (err: any) {
    if (err.name === 'ZodError') {
      res.status(400).json({
        error: 'Validatiefout',
        details: err.errors,
      });
      return;
    }
    const status = err.statusCode || 500;
    const msg    = status < 500 ? err.message : 'Registratie mislukt';
    if (status >= 500) logger.error('auth.register.error', { error: err.message });
    res.status(status).json({ error: msg });
  }
});

// ── POST /api/auth/login ──────────────────────────────────────
authRouter.post('/login', async (req: Request, res: Response) => {
  try {
    const input = loginSchema.parse(req.body);
    const result = await authService.login(input);

    res.cookie('refreshToken', result.refreshToken, {
      httpOnly: true,
      secure:   process.env.NODE_ENV === 'production',
      sameSite: 'none',
      maxAge:   30 * 24 * 60 * 60 * 1000,
      path:     '/api/auth',
    });

    res.json({
      accessToken: result.accessToken,
      user:        result.user,
    });
  } catch (err: any) {
    if (err.name === 'ZodError') {
      res.status(400).json({ error: 'Validatiefout', details: err.errors });
      return;
    }
    const status = err.statusCode || 500;
    const msg    = status < 500 ? err.message : 'Login mislukt';
    res.status(status).json({ error: msg });
  }
});

// ── POST /api/auth/refresh ────────────────────────────────────
authRouter.post('/refresh', async (req: Request, res: Response) => {
  const token = req.cookies?.refreshToken || req.body?.refreshToken;

  if (!token) {
    res.status(401).json({ error: 'Geen refresh token' });
    return;
  }

  try {
    const result = await authService.refreshToken(token);
    res.json(result);
  } catch (err: any) {
    res.status(401).json({ error: err.message });
  }
});

// ── POST /api/auth/logout ─────────────────────────────────────
authRouter.post('/logout', (_req: Request, res: Response) => {
  res.clearCookie('refreshToken', { path: '/api/auth' });
  res.json({ message: 'Uitgelogd' });
});

// ── GET /api/auth/me ──────────────────────────────────────────
authRouter.get('/me', authenticate, async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user.userId;
    const profile = await authService.getProfile(userId);
    res.json(profile);
  } catch (err: any) {
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});
