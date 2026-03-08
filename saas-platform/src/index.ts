import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import { authRouter }       from './modules/auth/api/auth.routes';
import { onboardingRouter } from './modules/onboarding/api/onboarding.routes';
import { billingRouter }    from './modules/billing/api/billing.routes';
import { errorHandler }     from './shared/middleware/error-handler';
import { logger }           from './shared/logging/logger';

// ── DEBUG: env vars controleren bij opstarten ─────────────────
console.log('=== ENV CHECK ===');
console.log('NODE_ENV:    ', process.env.NODE_ENV    ?? 'NOT SET');
console.log('PORT:        ', process.env.PORT        ?? 'NOT SET');
console.log('FRONTEND_URL:', process.env.FRONTEND_URL ?? 'NOT SET ❌');
console.log('REDIS_URL:   ', process.env.REDIS_URL
  ? process.env.REDIS_URL.replace(/:\/\/[^@]+@/, '://***@')
  : 'NOT SET ❌'
);
console.log('DATABASE_URL set:', process.env.DATABASE_URL ? 'YES ✅' : 'NO ❌');
console.log('JWT_SECRET set:  ', process.env.JWT_SECRET   ? 'YES ✅' : 'NO ❌');
console.log('=================');

const app = express();

// ── CORS ──────────────────────────────────────────────────────
// Sta verzoeken toe van de frontend (Vercel) en lokaal
const allowedOrigins = [
  process.env.FRONTEND_URL,           // bijv. https://marketgrowth-frontend.vercel.app
  'http://localhost:3000',
  'http://localhost:3001',
].filter(Boolean) as string[];

app.use(cors({
  origin: (origin, callback) => {
    // Sta requests zonder origin toe (Postman, health checks, Stripe webhooks)
    if (!origin) return callback(null, true);
    if (allowedOrigins.includes(origin)) return callback(null, true);
    logger.warn('cors.blocked', { origin });
    callback(new Error(`CORS: origin niet toegestaan: ${origin}`));
  },
  credentials: true,   // nodig voor cookies (refresh token)
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
}));

// Stripe webhook heeft raw body nodig — vóór express.json()
app.use('/api/billing/webhook', express.raw({ type: 'application/json' }));

// Standaard middleware
app.use(express.json());
app.use(cookieParser());

// Health check
app.get('/health', (_req, res) => {
  res.json({
    status:    'ok',
    timestamp: new Date().toISOString(),
    redis:     process.env.REDIS_URL ? 'configured' : 'missing',
  });
});

// Routes
app.use('/api/auth',       authRouter);
app.use('/api/onboarding', onboardingRouter);
app.use('/api/billing',    billingRouter);

// Error handler (altijd als laatste)
app.use(errorHandler());

const PORT = parseInt(process.env.PORT ?? '3000', 10);
app.listen(PORT, '0.0.0.0', () => {
  logger.info('server.started', { port: PORT, env: process.env.NODE_ENV });
});

export default app;
