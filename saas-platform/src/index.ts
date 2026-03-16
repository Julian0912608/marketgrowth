// Vang ALLE onverwachte errors op zodat het process niet stopt
process.on('uncaughtException', (err) => {
  console.error('UNCAUGHT EXCEPTION:', err.message);
  console.error(err.stack);
});

process.on('unhandledRejection', (reason: any) => {
  console.error('UNHANDLED REJECTION:', reason?.message ?? reason);
  console.error(reason?.stack ?? '');
});

import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import { errorHandler } from './shared/middleware/error-handler';
import { logger } from './shared/logging/logger';

console.log('=== ENV CHECK ===');
console.log('NODE_ENV:    ', process.env.NODE_ENV     ?? 'NOT SET');
console.log('PORT:        ', process.env.PORT         ?? 'NOT SET');
console.log('FRONTEND_URL:', process.env.FRONTEND_URL ?? 'NOT SET');
console.log('REDIS_URL:   ', process.env.REDIS_URL
  ? process.env.REDIS_URL.replace(/:\/\/[^@]+@/, '://***@')
  : 'NOT SET');
console.log('DATABASE_URL set:', process.env.DATABASE_URL ? 'YES' : 'NO');
console.log('JWT_SECRET set:  ', process.env.JWT_SECRET  ? 'YES' : 'NO');
console.log('=================');

const app = express();

// ── CORS ──────────────────────────────────────────────────────
// Bouw de allowlist op basis van FRONTEND_URL env var
// Altijd beide varianten toestaan (met en zonder www)
const frontendUrl = process.env.FRONTEND_URL ?? '';

const allowedOrigins = [
  frontendUrl,
  frontendUrl.replace('https://www.', 'https://'),
  frontendUrl.replace('https://', 'https://www.'),
  'https://marketgrow.ai',
  'https://www.marketgrow.ai',
  'http://localhost:3000',
  'http://localhost:3001',
].filter(Boolean).filter((v, i, a) => a.indexOf(v) === i); // dedup

console.log('CORS allowed origins:', allowedOrigins);

app.use(cors({
  origin: (origin, callback) => {
    // Geen origin = server-to-server of curl → altijd toestaan
    if (!origin) return callback(null, true);
    if (allowedOrigins.includes(origin)) return callback(null, true);
    logger.warn('cors.blocked', { origin });
    callback(new Error('CORS blocked: ' + origin));
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
}));

// Stripe webhook heeft raw body nodig
app.use('/api/billing/webhook', express.raw({ type: 'application/json' }));
app.use(express.json());
app.use(cookieParser());

// Health check — geen auth vereist
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

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

console.log('All routers loaded.');

app.use(errorHandler());

const PORT = parseInt(process.env.PORT ?? '3000', 10);
app.listen(PORT, '0.0.0.0', () => {
  logger.info('server.started', { port: PORT, env: process.env.NODE_ENV });
  console.log(`Server draait op poort ${PORT} - blijft actief`);
});

export default app;
