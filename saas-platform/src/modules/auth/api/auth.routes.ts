import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { AuthService } from '../service/auth.service';
import { rateLimitAuth } from '../../../shared/middleware/rate-limit';
import { tenantMiddleware } from '../../../shared/middleware/tenant.middleware';
import { getTenantContext } from '../../../shared/middleware/tenant-context';
import { db } from '../../../infrastructure/database/connection';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';

const router = Router();
const authService = new AuthService();

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
    const result = await authService.register(input) as any;
    const { user, tokens } = result;

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

// ── POST /api/auth/login ─────────────────────────────────────
router.post('/login', rateLimitAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const input = validate(LoginSchema, req.body);
    const result = await authService.login(input) as any;
    const { user, tokens } = result;

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

// ── POST /api/auth/refresh ───────────────────────────────────
router.post('/refresh', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const refreshToken = req.cookies?.refreshToken;
    if (!refreshToken) {
      res.status(401).json({ error: 'Geen actieve sessie gevonden.' });
      return;
    }
    const result = await authService.refreshAccessToken(refreshToken);
    res.json({ accessToken: result.accessToken, expiresIn: 900 });
  } catch (err) { next(err); }
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
  } catch (err) { next(err); }
});

// ── GET /api/auth/me ─────────────────────────────────────────
router.get('/me', tenantMiddleware(), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { userId } = getTenantContext();
    const result = await db.query<{
      id: string; email: string; first_name: string; last_name: string; role: string;
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

// ── PATCH /api/auth/profile ──────────────────────────────────
router.patch('/profile', tenantMiddleware(), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { firstName, lastName } = validate(UpdateProfileSchema, req.body);
    const { userId } = getTenantContext();

    await db.query(
      `UPDATE users SET first_name = $1, last_name = $2 WHERE id = $3`,
      [firstName, lastName, userId],
      { allowNoTenant: true }
    );

    const result = await db.query<{
      id: string; email: string; first_name: string; last_name: string; role: string;
    }>(
      `SELECT id, email, first_name, last_name, role FROM users WHERE id = $1`,
      [userId],
      { allowNoTenant: true }
    );

    const u = result.rows[0];
    res.json({
      success:   true,
      userId:    u.id,
      email:     u.email,
      firstName: u.first_name,
      lastName:  u.last_name,
      role:      u.role,
    });
  } catch (err) { next(err); }
});

// ── POST /api/auth/change-password ──────────────────────────
router.post('/change-password', tenantMiddleware(), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { currentPassword, newPassword } = validate(ChangePasswordSchema, req.body);
    const { userId } = getTenantContext();

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
      `UPDATE users SET password_hash = $1 WHERE id = $2`,
      [newHash, userId],
      { allowNoTenant: true }
    );

    res.json({ success: true, message: 'Wachtwoord succesvol gewijzigd.' });
  } catch (err) { next(err); }
});

// ── POST /api/auth/password/reset-request ───────────────────
router.post('/password/reset-request', rateLimitAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { email } = validate(ResetRequestSchema, req.body);

    const result = await db.query<{ id: string; first_name: string }>(
      `SELECT id, first_name FROM users WHERE email = $1`,
      [email.toLowerCase()],
      { allowNoTenant: true }
    );

    if (result.rows[0]) {
      const token     = crypto.randomBytes(32).toString('hex');
      const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
      const expiresAt = new Date(Date.now() + 60 * 60 * 1000);

      await db.query(
        `INSERT INTO password_reset_tokens (user_id, token_hash, expires_at, used)
         VALUES ($1, $2, $3, false)
         ON CONFLICT DO NOTHING`,
        [result.rows[0].id, tokenHash, expiresAt],
        { allowNoTenant: true }
      );

      const appUrl    = process.env.APP_URL || 'https://marketgrow.ai';
      const resetUrl  = `${appUrl}/reset-password?token=${token}`;
      const firstName = result.rows[0].first_name || 'there';

      const html = `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#f8fafc;font-family:'Helvetica Neue',Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="padding:40px 20px;">
    <tr><td align="center">
      <table width="520" cellpadding="0" cellspacing="0" style="max-width:520px;width:100%;">
        <tr>
          <td style="background:#0f172a;border-radius:16px 16px 0 0;padding:28px 36px;">
            <span style="color:#fff;font-size:18px;font-weight:800;">⚡ MarketGrow</span>
          </td>
        </tr>
        <tr>
          <td style="background:#1e293b;padding:32px 36px;">
            <h1 style="color:#fff;font-size:20px;margin:0 0 12px;">Reset your password</h1>
            <p style="color:#94a3b8;font-size:14px;line-height:1.6;margin:0 0 24px;">
              Hi ${firstName}, we received a request to reset your MarketGrow password.
              Click the button below to choose a new password.
            </p>
            <a href="${resetUrl}" style="display:inline-block;background:#4f46e5;color:#fff;font-weight:600;font-size:14px;padding:12px 28px;border-radius:10px;text-decoration:none;">
              Reset password
            </a>
            <p style="color:#64748b;font-size:12px;margin:24px 0 0;line-height:1.6;">
              This link expires in 1 hour. If you didn't request a password reset, you can safely ignore this email.
            </p>
          </td>
        </tr>
        <tr>
          <td style="background:#0f172a;border-radius:0 0 16px 16px;padding:16px 36px;text-align:center;">
            <p style="color:#475569;font-size:11px;margin:0;">© ${new Date().getFullYear()} MarketGrow · marketgrow.ai</p>
          </td>
        </tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;

      fetch('https://api.resend.com/emails', {
        method:  'POST',
        headers: {
          'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
          'Content-Type':  'application/json',
        },
        body: JSON.stringify({
          from:    'MarketGrow <noreply@marketgrow.ai>',
          to:      [email.toLowerCase()],
          subject: 'Reset your MarketGrow password',
          html,
        }),
      }).catch(err => {
        console.error('Password reset email failed:', err.message);
      });
    }

    res.json({ message: 'Als dit e-mailadres bekend is, ontvang je een reset-link.' });
  } catch (err) { next(err); }
});

// ── POST /api/auth/password/reset-confirm ───────────────────
router.post('/password/reset-confirm', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { token, newPassword } = validate(ResetConfirmSchema, req.body);
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');

    const result = await db.query<{ id: string; user_id: string; used: boolean; expires_at: Date }>(
      `SELECT id, user_id, used, expires_at FROM password_reset_tokens WHERE token_hash = $1`,
      [tokenHash],
      { allowNoTenant: true }
    );

    const resetToken = result.rows[0];
    if (!resetToken || resetToken.used || new Date(resetToken.expires_at) < new Date()) {
      res.status(400).json({ error: 'Ongeldige of verlopen reset-link.' });
      return;
    }

    const newHash = await bcrypt.hash(newPassword, 12);
    await db.query(
      `UPDATE users SET password_hash = $1 WHERE id = $2`,
      [newHash, resetToken.user_id],
      { allowNoTenant: true }
    );

    await db.query(
      `UPDATE password_reset_tokens SET used = true WHERE id = $1`,
      [resetToken.id],
      { allowNoTenant: true }
    );

    res.json({ message: 'Wachtwoord succesvol gewijzigd. Je kunt nu inloggen.' });
  } catch (err) { next(err); }
});

export { router as authRouter };
