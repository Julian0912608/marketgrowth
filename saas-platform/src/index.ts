import express, { Request, Response, NextFunction } from 'express';
import cookieParser from 'cookie-parser';
import { authRouter }        from './modules/auth/api/auth.routes';
import { onboardingRouter }  from './modules/onboarding/api/onboarding.routes';
import { billingRouter }     from './modules/billing/api/billing.routes';
import { integrationRouter } from './modules/integrations/api/integration.routes';
import { errorHandler }      from './shared/middleware/error-handler';
import { logger }            from './shared/logging/logger';

const app = express();

// ── CORS ──────────────────────────────────────────────────────
// Moet als EERSTE middleware staan, vóór alles
const ALLOWED_ORIGINS = [
  process.env.FRONTEND_URL,
  'https://marketgrowth-frontend.vercel.app',
  'http://localhost:3000',
  'http://localhost:3001',
].filter(Boolean) as string[];

app.use((req: Request, res: Response, next: NextFunction) => {
  const origin = req.headers.origin;

  if (origin && ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }

  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization,X-Requested-With');

  // Preflight request direct beantwoorden
  if (req.method === 'OPTIONS') {
    res.sendStatus(204);
    return;
  }

  next();
});

// ── Stripe + platform webhooks (raw body vóór express.json) ──
app.use('/api/billing/webhook',      express.raw({ type: 'application/json' }));
app.use('/api/integrations/webhook', express.raw({ type: 'application/json' }));

// ── Standaard middleware ──────────────────────────────────────
app.use(express.json());
app.use(cookieParser());

// ── Health check ──────────────────────────────────────────────
app.get('/health', (_req: Request, res: Response) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ── Routes ────────────────────────────────────────────────────
app.use('/api/auth',         authRouter);
app.use('/api/onboarding',   onboardingRouter);
app.use('/api/billing',      billingRouter);
app.use('/api/integrations', integrationRouter);

// ── Error handler (altijd als laatste) ───────────────────────
app.use(errorHandler());

const PORT = parseInt(process.env.PORT ?? '3000', 10);
app.listen(PORT, '0.0.0.0', () => {
  logger.info('server.started', { port: PORT, env: process.env.NODE_ENV });
});

export default app;
