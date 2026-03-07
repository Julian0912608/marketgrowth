// ============================================================
// src/index.ts — MarketGrowth Backend Server
// ============================================================

import express, { Request, Response, NextFunction } from 'express';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import { logger } from './shared/logging/logger';
import { db } from './infrastructure/database/connection';
import { getRedis, redisHealthCheck } from './infrastructure/redis/client';

// Routes
import { authRouter }         from './modules/auth/api/auth.routes';
import { onboardingRouter }   from './modules/onboarding/api/onboarding.routes';
import { billingRouter }      from './modules/billing/api/billing.routes';
import { integrationsRouter } from './modules/integrations/api/integrations.routes';
import { analyticsRouter }    from './modules/analytics/api/analytics.routes';

const app = express();

// ── CORS ──────────────────────────────────────────────────────
app.use(cors({
  origin: (origin, callback) => {
    if (!origin) return callback(null, true);
    const allowed = [
      'https://marketgrowth-frontend.vercel.app',
      'http://localhost:3000',
      'http://localhost:3001',
    ];
    if (allowed.includes(origin) || /\.vercel\.app$/.test(origin)) {
      callback(null, true);
    } else {
      callback(null, true); // Tijdelijk alles toestaan
    }
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Tenant-ID'],
}));

// ── Body parsing ──────────────────────────────────────────────
app.use('/api/billing/webhook', express.raw({ type: 'application/json' }));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

// ── Health ────────────────────────────────────────────────────
app.get('/health', async (_req: Request, res: Response) => {
  const dbResult    = await db.healthCheck();
  const redisResult = await redisHealthCheck();

  res.status(dbResult.ok ? 200 : 503).json({
    status:    dbResult.ok ? 'ok' : 'degraded',
    timestamp: new Date().toISOString(),
    database:  dbResult,
    redis:     redisResult,
    uptime:    process.uptime(),
  });
});

app.get('/ping', (_req: Request, res: Response) => res.json({ pong: true }));

// ── Routes ────────────────────────────────────────────────────
app.use('/api/auth',         authRouter);
app.use('/api/onboarding',   onboardingRouter);
app.use('/api/billing',      billingRouter);
app.use('/api/integrations', integrationsRouter);
app.use('/api/analytics',    analyticsRouter);

// ── 404 ───────────────────────────────────────────────────────
app.use((_req: Request, res: Response) => {
  res.status(404).json({ error: 'Route niet gevonden' });
});

// ── Error handler ─────────────────────────────────────────────
app.use((err: any, req: Request, res: Response, _next: NextFunction) => {
  const status  = err.statusCode || err.status || 500;
  const message = status < 500 ? err.message : 'Interne serverfout';
  if (status >= 500) {
    logger.error('request.error', { method: req.method, path: req.path, error: err.message });
  }
  res.status(status).json({ error: message });
});

// ── Server ────────────────────────────────────────────────────
const PORT = parseInt(process.env.PORT || '3000', 10);

const server = app.listen(PORT, '0.0.0.0', () => {
  logger.info('server.started', { port: PORT, env: process.env.NODE_ENV || 'production' });
  getRedis(); // Redis non-blocking starten
});

process.on('SIGTERM', () => {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 10000);
});

process.on('SIGINT', () => {
  server.close(() => process.exit(0));
});

process.on('unhandledRejection', (reason) => {
  logger.error('unhandled.rejection', { reason: String(reason) });
});

process.on('uncaughtException', (err) => {
  logger.error('uncaught.exception', { error: err.message });
  process.exit(1);
});

export default app;
