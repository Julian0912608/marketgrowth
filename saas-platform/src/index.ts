// ============================================================
// saas-platform/src/index.ts
//
// FIX: express.raw() toegevoegd voor Shopify webhook route
// zodat HMAC verificatie correct werkt op de raw payload.
//
// PR 3a: metaCreativeRouter geregistreerd op /api/ai/meta-creative.
// ============================================================

process.on('uncaughtException', (err) => {
  console.error('UNCAUGHT EXCEPTION:', err.message);
  console.error(err.stack);
});

process.on('unhandledRejection', (reason: any) => {
  console.error('UNHANDLED REJECTION:', reason?.message ?? reason);
  console.error(reason?.stack ?? '');
});

import express      from 'express';
import cors         from 'cors';
import helmet       from 'helmet';
import cookieParser from 'cookie-parser';
import { errorHandler }  from './shared/middleware/error-handler';
import { requestLogger } from './shared/middleware/request-logger.middleware';
import { logger }        from './shared/logging/logger';
import { db }            from './infrastructure/database/connection';
import { cache }         from './infrastructure/cache/redis';

// ── Startup checks ────────────────────────────────────────────
console.log('=== ENV CHECK ===');
console.log('NODE_ENV:    ', process.env.NODE_ENV     ?? 'NOT SET');
console.log('PORT:        ', process.env.PORT         ?? 'NOT SET');
console.log('FRONTEND_URL:', process.env.FRONTEND_URL ?? 'NOT SET');
console.log('REDIS_URL:   ', process.env.REDIS_URL ? process.env.REDIS_URL.replace(/:\/\/[^@]+@/, '://***@') : 'NOT SET');
console.log('DATABASE_URL set:   ', process.env.DATABASE_URL   ? 'YES' : 'NO');
console.log('JWT_SECRET set:     ', process.env.JWT_SECRET     ? 'YES' : 'NO');
console.log('RESEND_API_KEY set: ', process.env.RESEND_API_KEY ? 'YES' : 'NO');
console.log('ENCRYPTION_KEY set: ', process.env.ENCRYPTION_KEY ? 'YES' : 'NO ⚠️');
console.log('=================');

if (process.env.NODE_ENV === 'production' && !process.env.ENCRYPTION_KEY) {
  console.error('FATAL: ENCRYPTION_KEY is niet ingesteld. Genereer met: openssl rand -hex 32');
  process.exit(1);
}

const app = express();

// Railway proxy — correcte IP-adressen voor rate limiting
app.set('trust proxy', 1);

// ── Helmet security headers ───────────────────────────────────
app.use(helmet({
  contentSecurityPolicy:   false,
  strictTransportSecurity: { maxAge: 31536000, includeSubDomains: true },
  frameguard:              { action: 'deny' },
  noSniff:                 true,
  referrerPolicy:          { policy: 'strict-origin-when-cross-origin' },
  hidePoweredBy:           true,
}));

// ── CORS ──────────────────────────────────────────────────────
const allowedOrigins = [
  process.env.FRONTEND_URL,
  'https://marketgrow.ai',
  'https://www.marketgrow.ai',
  'http://localhost:3000',
  'http://localhost:3001',
].filter(Boolean) as string[];

app.use(cors({
  origin: (origin, callback) => {
    if (!origin) return callback(null, true);
    if (allowedOrigins.includes(origin)) return callback(null, true);
    callback(new Error('CORS blocked: ' + origin));
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'x-admin-token'],
}));

// ── Body parsers ──────────────────────────────────────────────
// BELANGRIJK: raw parsers moeten vóór express.json() staan,
// anders is de payload al geparsed en werkt HMAC verificatie niet.

// Stripe billing webhooks — raw body nodig voor HMAC
app.use('/api/billing/webhook', express.raw({ type: 'application/json' }));

// Shopify webhooks — raw body nodig voor HMAC verificatie
app.use('/api/integrations/webhook/shopify', express.raw({ type: 'application/json' }));

// 10mb voor /api/ai routes (foto uploads als base64)
app.use('/api/ai', express.json({ limit: '10mb' }));
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));
app.use(cookieParser());
app.use(requestLogger);

// ── Health check (uitgebreid met DB + Redis ping) ─────────────
app.get('/health', async (_req, res) => {
  const start = Date.now();

  // DB check
  let dbOk    = false;
  let dbMs    = 0;
  let redisOk = false;
  let redisMs = 0;

  try {
    const t0 = Date.now();
    await db.query('SELECT 1', [], { allowNoTenant: true });
    dbOk = true;
    dbMs = Date.now() - t0;
  } catch (err: any) {
    logger.error('health.db.failed', { error: err.message });
  }

  try {
    const t0  = Date.now();
    await cache.get('health:ping');
    redisOk = true;
    redisMs = Date.now() - t0;
  } catch (err: any) {
    logger.error('health.redis.failed', { error: err.message });
  }

  const allOk = dbOk && redisOk;
  const pool  = db.stats();

  res.status(allOk ? 200 : 503).json({
    status:    allOk ? 'ok' : 'degraded',
    timestamp: new Date().toISOString(),
    latencyMs: Date.now() - start,
    db:    { ok: dbOk,    latencyMs: dbMs },
    redis: { ok: redisOk, latencyMs: redisMs },
    pool:  { total: pool.total, idle: pool.idle, waiting: pool.waiting },
  });
});

// ── Routers ───────────────────────────────────────────────────
console.log('Loading routers...');

try {
  const { authRouter } = require('./modules/auth/api/auth.routes');
  app.use('/api/auth', authRouter);
  console.log('  authRouter OK');
} catch (e: any) { console.error('  authRouter FAILED:', e.message); }

try {
  const { onboardingRouter } = require('./modules/onboarding/api/onboarding.routes');
  app.use('/api/onboarding', onboardingRouter);
  console.log('  onboardingRouter OK');
} catch (e: any) { console.error('  onboardingRouter FAILED:', e.message); }

try {
  const { billingRouter } = require('./modules/billing/api/billing.routes');
  app.use('/api/billing', billingRouter);
  console.log('  billingRouter OK');
} catch (e: any) { console.error('  billingRouter FAILED:', e.message); }

try {
  const { integrationRouter } = require('./modules/integrations/api/integration.routes');
  app.use('/api/integrations', integrationRouter);
  console.log('  integrationRouter OK');
} catch (e: any) { console.error('  integrationRouter FAILED:', e.message); }

try {
  const { analyticsRouter } = require('./modules/analytics/api/analytics.routes');
  app.use('/api/analytics', analyticsRouter);
  console.log('  analyticsRouter OK');
} catch (e: any) { console.error('  analyticsRouter FAILED:', e.message); }

try {
  const { aiRouter } = require('./modules/ai-engine/api/ai.routes');
  app.use('/api/ai', aiRouter);
  console.log('  aiRouter OK');
} catch (e: any) { console.error('  aiRouter FAILED:', e.message); }

// PR 3a: Meta Creative Studio — aparte router op /api/ai/meta-creative
// Geregistreerd na aiRouter zodat de meer-specifieke route eerst gepakt wordt.
try {
  const { metaCreativeRouter } = require('./modules/ai-engine/api/meta-creative.routes');
  app.use('/api/ai/meta-creative', metaCreativeRouter);
  console.log('  metaCreativeRouter OK');
} catch (e: any) { console.error('  metaCreativeRouter FAILED:', e.message); }

try {
  const { adminRouter } = require('./modules/admin/api/admin.routes');
  app.use('/api/admin', adminRouter);
  console.log('  adminRouter OK');
} catch (e: any) { console.error('  adminRouter FAILED:', e.message); }

try {
  const { teamRouter } = require('./modules/team/api/team.routes');
  app.use('/api/team', teamRouter);
  console.log('  teamRouter OK');
} catch (e: any) { console.error('  teamRouter FAILED:', e.message); }

console.log('All routers loaded.');

// ── Email worker ──────────────────────────────────────────────
try {
  const { scheduleEmailJobs } = require('./modules/notifications/email.worker');
  scheduleEmailJobs().then(() => {
    console.log('  emailWorker OK — briefing scheduled at 07:00 Amsterdam');
  }).catch((e: any) => {
    console.error('  emailWorker schedule FAILED:', e.message);
  });
} catch (e: any) { console.error('  emailWorker FAILED:', e.message); }

// ── Sync scheduler (elke 15 min incrementele sync) ───────────
try {
  const { startSyncScheduler } = require('./modules/integrations/workers/startup-sync');
  startSyncScheduler();
  console.log('  syncScheduler OK — incremental sync every 15 minutes');
} catch (e: any) { console.error('  syncScheduler FAILED:', e.message); }

// ── 404 + error handler ───────────────────────────────────────
app.use((_req, res) => {
  res.status(404).json({ error: 'not_found' });
});
app.use(errorHandler());

// ── Start ─────────────────────────────────────────────────────
const PORT = parseInt(process.env.PORT ?? '3001', 10);
app.listen(PORT, '0.0.0.0', () => {
  logger.info('server.started', { port: PORT, env: process.env.NODE_ENV });
  console.log(`Server running on port ${PORT}`);

  // Full sync na opstarten — 10s delay zodat DB connectie stabiel is
  setTimeout(() => {
    try {
      const { startupFullSync } = require('./modules/integrations/workers/startup-sync');
      startupFullSync().then(() => {
        console.log('  startupFullSync OK');
      }).catch((e: any) => {
        console.error('  startupFullSync FAILED:', e.message);
      });
    } catch (e: any) { console.error('  startupFullSync FAILED:', e.message); }
  }, 10_000);
});

export default app;
