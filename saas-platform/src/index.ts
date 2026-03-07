// ============================================================
// src/index.ts — MarketGrowth Backend Server
//
// KRITIEKE FIXES:
// 1. Server start ALTIJD — ook als DB/Redis niet direct beschikbaar zijn
// 2. Correcte CORS voor Vercel frontend
// 3. Health endpoint met DB + Redis status
// 4. Graceful shutdown
// 5. Alle routes correct geregistreerd
// ============================================================

import express, { Request, Response, NextFunction } from 'express';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import { logger } from './shared/logging/logger';
import { db } from './infrastructure/database/connection';
import { getRedis, redisHealthCheck } from './infrastructure/redis/client';

// Routes
import { authRouter }         from './modules/auth/api/auth.routes';
import { billingRouter }      from './modules/billing/api/billing.routes';
import { tenantRouter }       from './modules/tenant/api/tenant.routes';
import { integrationsRouter } from './modules/integrations/api/integrations.routes';
import { analyticsRouter }    from './modules/analytics/api/analytics.routes';

// Middleware
import { authenticate }       from './shared/middleware/auth.middleware';
import { tenantMiddleware }   from './shared/middleware/tenant.middleware';
import { errorHandler }       from './shared/middleware/error.middleware';
import { requestLogger }      from './shared/middleware/request-logger.middleware';

const app = express();

// ── CORS ──────────────────────────────────────────────────────
const allowedOrigins = [
  'https://marketgrowth-frontend.vercel.app',
  'https://marketgrowth.vercel.app',
  // Vercel preview deployments
  /^https:\/\/marketgrowth.*\.vercel\.app$/,
  // Lokale ontwikkeling
  'http://localhost:3000',
  'http://localhost:3001',
];

app.use(cors({
  origin: (origin, callback) => {
    // Geen origin = server-to-server (altijd ok)
    if (!origin) return callback(null, true);

    const allowed = allowedOrigins.some(o =>
      typeof o === 'string' ? o === origin : o.test(origin)
    );

    if (allowed) {
      callback(null, true);
    } else {
      logger.warn('cors.blocked', { origin });
      callback(new Error(`CORS geblokkeerd: ${origin}`));
    }
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Tenant-ID'],
}));

// ── Body parsing ──────────────────────────────────────────────
// Stripe webhooks moeten raw body hebben
app.use('/api/billing/webhook', express.raw({ type: 'application/json' }));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

// ── Request logging ───────────────────────────────────────────
app.use(requestLogger);

// ── Health endpoint ───────────────────────────────────────────
// Publiek — geen auth nodig — voor Railway health checks
app.get('/health', async (_req: Request, res: Response) => {
  const [dbHealth, redisHealth] = await Promise.allSettled([
    db.healthCheck(),
    redisHealthCheck(),
  ]);

  const dbResult   = dbHealth.status   === 'fulfilled' ? dbHealth.value   : { ok: false, error: 'check failed' };
  const redisResult = redisHealth.status === 'fulfilled' ? redisHealth.value : { ok: false, error: 'check failed' };

  const allOk = dbResult.ok && redisResult.ok;

  res.status(allOk ? 200 : 503).json({
    status:    allOk ? 'healthy' : 'degraded',
    timestamp: new Date().toISOString(),
    services: {
      database: dbResult,
      redis:    redisResult,
    },
    pool: db.stats(),
    uptime: process.uptime(),
  });
});

// Basis ping — voor snelle Railway check
app.get('/ping', (_req, res) => res.json({ pong: true }));

// ── Publieke routes (geen auth) ───────────────────────────────
app.use('/api/auth',    authRouter);
app.use('/api/billing/webhook', billingRouter); // Stripe webhook is publiek

// ── Beveiligde routes (auth verplicht) ───────────────────────
app.use('/api', authenticate, tenantMiddleware);
app.use('/api/tenant',       tenantRouter);
app.use('/api/billing',      billingRouter);
app.use('/api/integrations', integrationsRouter);
app.use('/api/analytics',    analyticsRouter);

// ── 404 handler ───────────────────────────────────────────────
app.use((_req: Request, res: Response) => {
  res.status(404).json({ error: 'Route niet gevonden' });
});

// ── Global error handler ──────────────────────────────────────
app.use(errorHandler);

// ── Server starten ────────────────────────────────────────────
const PORT = parseInt(process.env.PORT || '3000', 10);

const server = app.listen(PORT, '0.0.0.0', () => {
  logger.info('server.started', {
    port:    PORT,
    env:     process.env.NODE_ENV || 'development',
    version: process.env.npm_package_version || '1.0.0',
  });

  // Redis verbinding starten (non-blocking)
  getRedis();
});

// ── Graceful shutdown ─────────────────────────────────────────
const shutdown = (signal: string) => {
  logger.info('server.shutdown', { signal });

  server.close(() => {
    logger.info('server.closed');
    process.exit(0);
  });

  // Forceer shutdown na 10s
  setTimeout(() => {
    logger.error('server.force_shutdown');
    process.exit(1);
  }, 10000);
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));

process.on('unhandledRejection', (reason) => {
  logger.error('unhandled.rejection', { reason: String(reason) });
  // NIET crashen — loopt gewoon door
});

process.on('uncaughtException', (err) => {
  logger.error('uncaught.exception', { error: err.message, stack: err.stack });
  // Bij uncaught exception WEL shutdown (corrupte state)
  shutdown('uncaughtException');
});

export default app;
