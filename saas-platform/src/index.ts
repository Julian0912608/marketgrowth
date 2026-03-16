process.on('uncaughtException', (err) => {
  console.error('UNCAUGHT EXCEPTION:', err.message);
  console.error(err.stack);
});

process.on('unhandledRejection', (reason) => {
  console.error('UNHANDLED REJECTION:', reason);
});

import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import { errorHandler } from './shared/middleware/error-handler';
import { logger } from './shared/logging/logger';

console.log('=== ENV CHECK ===');
console.log('NODE_ENV:    ', process.env.NODE_ENV     || 'NOT SET');
console.log('PORT:        ', process.env.PORT         || 'NOT SET');
console.log('FRONTEND_URL:', process.env.FRONTEND_URL || 'NOT SET');
console.log('REDIS_URL:   ', process.env.REDIS_URL
  ? process.env.REDIS_URL.replace(/:\/\/[^@]+@/, '://***@')
  : 'NOT SET');
console.log('DATABASE_URL set:', process.env.DATABASE_URL ? 'YES' : 'NO');
console.log('JWT_SECRET set:  ', process.env.JWT_SECRET  ? 'YES' : 'NO');
console.log('ANTHROPIC_API_KEY set:', process.env.ANTHROPIC_API_KEY ? 'YES' : 'NO');
console.log('=================');

const app = express();

const frontendUrl = process.env.FRONTEND_URL || '';

const allowedOrigins = [
  frontendUrl,
  'https://marketgrow.ai',
  'https://www.marketgrow.ai',
  'http://localhost:3000',
  'http://localhost:3001',
].filter(Boolean).filter((v, i, a) => a.indexOf(v) === i);

console.log('CORS allowed origins:', allowedOrigins);

app.use(cors({
  origin: (origin, callback) => {
    if (!origin) return callback(null, true);
    if (allowedOrigins.includes(origin)) return callback(null, true);
    logger.warn('cors.blocked', { origin });
    callback(new Error('CORS blocked: ' + origin));
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
}));

app.use('/api/billing/webhook', express.raw({ type: 'application/json' }));
app.use(express.json());
app.use(cookieParser());

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

console.log('Loading routers...');

try {
  const { authRouter } = require('./modules/auth/api/auth.routes');
  app.use('/api/auth', authRouter);
  console.log('  authRouter OK');
} catch (e) {
  console.error('  authRouter FAILED:', (e as Error).message);
}

try {
  const { onboardingRouter } = require('./modules/onboarding/api/onboarding.routes');
  app.use('/api/onboarding', onboardingRouter);
  console.log('  onboardingRouter OK');
} catch (e) {
  console.error('  onboardingRouter FAILED:', (e as Error).message);
}

try {
  const { billingRouter } = require('./modules/billing/api/billing.routes');
  app.use('/api/billing', billingRouter);
  console.log('  billingRouter OK');
} catch (e) {
  console.error('  billingRouter FAILED:', (e as Error).message);
}

try {
  const { integrationRouter } = require('./modules/integrations/api/integration.routes');
  app.use('/api/integrations', integrationRouter);
  console.log('  integrationRouter OK');
} catch (e) {
  console.error('  integrationRouter FAILED:', (e as Error).message);
}

try {
  const { analyticsRouter } = require('./modules/analytics/api/analytics.routes');
  app.use('/api/analytics', analyticsRouter);
  console.log('  analyticsRouter OK');
} catch (e) {
  console.error('  analyticsRouter FAILED:', (e as Error).message);
}

try {
  const { aiRouter } = require('./modules/ai-engine/api/ai.routes');
  app.use('/api/ai', aiRouter);
  console.log('  aiRouter OK');
} catch (e) {
  console.error('  aiRouter FAILED:', (e as Error).message);
}

console.log('All routers loaded.');

app.use(errorHandler());

const PORT = parseInt(process.env.PORT || '3000', 10);
app.listen(PORT, '0.0.0.0', () => {
  logger.info('server.started', { port: PORT, env: process.env.NODE_ENV });
  console.log('Server draait op poort ' + PORT + ' - blijft actief');
});

export default app;
