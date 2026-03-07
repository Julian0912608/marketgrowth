import express from 'express';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import { authRouter }       from './modules/auth/api/auth.routes';
import { onboardingRouter } from './modules/onboarding/api/onboarding.routes';
import { billingRouter }    from './modules/billing/api/billing.routes';
import { errorHandler }     from './shared/middleware/error-handler';
import { logger }           from './shared/logging/logger';

const app = express();

// CORS — moet vóór alle routes staan
app.use(cors({
  origin: process.env.FRONTEND_URL,
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));

// Stripe webhook heeft raw body nodig — vóór express.json()
app.use('/api/billing/webhook', express.raw({ type: 'application/json' }));

// Standaard middleware
app.use(express.json());
app.use(cookieParser());

// Health check
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
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
```

Daarna ga je naar Railway → je backend service → **Variables** en voeg toe:
```
FRONTEND_URL=https://marketgrowth-frontend.vercel.app
