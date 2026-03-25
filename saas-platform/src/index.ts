// ============================================================
// saas-platform/src/index.ts
//
// SECURITY UPDATE:
//   - Helmet.js voor HTTP security headers
//   - Request size limiting (body too large = 413)
//   - IP forwarding correct geconfigureerd voor Railway
//   - ENCRYPTION_KEY check bij startup
// ============================================================

process.on('uncaughtException', (err) => {
  console.error('UNCAUGHT EXCEPTION:', err.message);
  console.error(err.stack);
});

process.on('unhandledRejection', (reason: any) => {
  console.error('UNHANDLED REJECTION:', reason?.message ?? reason);
  console.error(reason?.stack ?? '');
});

import express    from 'express';
import cors       from 'cors';
import helmet     from 'helmet';
import cookieParser from 'cookie-parser';
import { errorHandler }      from './shared/middleware/error-handler';
import { requestLogger }     from './shared/middleware/request-logger.middleware';
import { logger }            from './shared/logging/logger';

// ── Startup environment check ─────────────────────────────────
console.log('=== ENV CHECK ===');
console.log('NODE_ENV:    ', process.env.NODE_ENV     ?? 'NOT SET');
console.log('PORT:        ', process.env.PORT         ?? 'NOT SET');
console.log('FRONTEND_URL:', process.env.FRONTEND_URL ?? 'NOT SET');
console.log('REDIS_URL:   ', process.env.REDIS_URL ? process.env.REDIS_URL.replace(/:\/\/[^@]+@/, '://***@') : 'NOT SET');
console.log('DATABASE_URL set:    ', process.env.DATABASE_URL    ? 'YES' : 'NO');
console.log('JWT_SECRET set:      ', process.env.JWT_SECRET      ? 'YES' : 'NO');
console.log('RESEND_API_KEY set:  ', process.env.RESEND_API_KEY  ? 'YES' : 'NO');
console.log('ENCRYPTION_KEY set:  ', process.env.ENCRYPTION_KEY  ? 'YES ✓' : '⚠️  NOT SET — credentials worden NIET versleuteld!');
console.log('=================');

// Blokkeer startup als ENCRYPTION_KEY ontbreekt in productie
if (process.env.NODE_ENV === 'production' && !process.env.ENCRYPTION_KEY) {
  console.error('FATAL: ENCRYPTION_KEY is niet ingesteld in productie. Genereer met: openssl rand -hex 32');
  process.exit(1);
}

const app = express();

// ── Railway: vertrouw proxy voor correcte IP-adressen ─────────
// Zonder dit krijgen alle requests hetzelfde IP (Railway proxy IP)
// en werkt rate limiting niet correct per gebruiker.
app.set('trust proxy', 1);

// ── Helmet — HTTP security headers ───────────────────────────
// Zet automatisch: X-Frame-Options, X-Content-Type-Options,
// Strict-Transport-Security, Referrer-Policy, en meer.
app.use(helmet({
  // CSP uitgeschakeld — frontend zit op aparte Vercel domain
  // en de API stuurt geen HTML terug
  contentSecurityPolicy: false,

  // HSTS: forceer HTTPS voor 1 jaar
  strictTransportSecurity: {
    maxAge: 31536000,
    includeSubDomains: true,
  },

  // Voorkom dat de API in een iframe geladen wordt
  frameguard: { action: 'deny' },

  // Voorkom MIME-type sniffing
  noSniff: true,

  // Referrer-Policy: stuur geen referrer mee buiten ons domein
  referrerPolicy: { policy: 'strict-origin-when-cross-origin' },

  // Verberg dat de server op Express draait
  hidePoweredBy: true,
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
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
}));

// ── Body parsers ──────────────────────────────────────────────
// Stripe webhook vereist raw body — moet VOOR express.json() staan
app.use('/api/billing/webhook', express.raw({ type: 'application/json' }));

// Limiteer request body grootte — voorkomt payload-flooding aanvallen
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));
app.use(cookieParser());

// ── Request logging ───────────────────────────────────────────
app.use(requestLogger);

// ── Health check ──────────────────────────────────────────────
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ── Routers laden ─────────────────────────────────────────────
console.log('Loading routers...');

try {
  const { authRouter } = require('./modules/auth/api/auth.routes');
  app.use('/api/auth', authRouter);
  console.log('  authRouter OK');
} catch (e: any) {
  console.error('  authRouter FAILED:', e.message);
}

try {
  const { onboardingRouter } = require('./modules/onboarding/api/onboarding.routes');
  app.use('/api/onboarding', onboardingRouter);
  console.log('  onboardingRouter OK');
} catch (e: any) {
  console.error('  onboardingRouter FAILED:', e.message);
}

try {
  const { billingRouter } = require('./modules/billing/api/billing.routes');
  app.use('/api/billing', billingRouter);
  console.log('  billingRouter OK');
} catch (e: any) {
  console.error('  billingRouter FAILED:', e.message);
}

try {
  const { integrationRouter } = require('./modules/integrations/api/integration.routes');
  app.use('/api/integrations', integrationRouter);
  console.log('  integrationRouter OK');
} catch (e: any) {
  console.error('  integrationRouter FAILED:', e.message);
}

try {
  const { analyticsRouter } = require('./modules/analytics/api/analytics.routes');
  app.use('/api/analytics', analyticsRouter);
  console.log('  analyticsRouter OK');
} catch (e: any) {
  console.error('  analyticsRouter FAILED:', e.message);
}

try {
  const { aiRouter } = require('./modules/ai-engine/api/ai.routes');
  app.use('/api/ai', aiRouter);
  console.log('  aiRouter OK');
} catch (e: any) {
  console.error('  aiRouter FAILED:', e.message);
}

try {
  const { settingsRouter } = require('./modules/settings/api/settings.routes');
  app.use('/api/settings', settingsRouter);
  console.log('  settingsRouter OK');
} catch (e: any) {
  console.error('  settingsRouter FAILED (optioneel):', e.message);
}

try {
  const { advertisingRouter } = require('./modules/advertising/api/advertising.routes');
  app.use('/api/advertising', advertisingRouter);
  console.log('  advertisingRouter OK');
} catch (e: any) {
  console.error('  advertisingRouter FAILED (optioneel):', e.message);
}

console.log('All routers loaded.');

// ── 404 handler ───────────────────────────────────────────────
app.use((_req, res) => {
  res.status(404).json({ error: 'not_found', message: 'Route bestaat niet' });
});

// ── Centrale error handler (altijd als laatste) ───────────────
app.use(errorHandler());

// ── Server starten ────────────────────────────────────────────
const PORT = parseInt(process.env.PORT ?? '3000', 10);
app.listen(PORT, '0.0.0.0', () => {
  logger.info('server.started', {
    port: PORT,
    env:  process.env.NODE_ENV ?? 'development',
    encryptionKeySet: !!process.env.ENCRYPTION_KEY,
  });
});
