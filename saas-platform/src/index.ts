import express from 'express';
import cookieParser from 'cookie-parser';
import { authRouter }         from './modules/auth/api/auth.routes';
import { onboardingRouter }   from './modules/onboarding/api/onboarding.routes';
import { billingRouter }      from './modules/billing/api/billing.routes';
import { integrationsRouter } from './modules/integrations/api/integrations.routes';
import { analyticsRouter }    from './modules/analytics/api/analytics.routes';
import { errorHandler }       from './shared/middleware/error-handler';
import { logger }             from './shared/logging/logger';

const app = express();

app.use('/api/billing/webhook', express.raw({ type: 'application/json' }));
app.use(express.json());
app.use(cookieParser());

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.use('/api/auth',         authRouter);
app.use('/api/onboarding',   onboardingRouter);
app.use('/api/billing',      billingRouter);
app.use('/api/integrations', integrationsRouter);
app.use('/api/analytics',    analyticsRouter);

app.use(errorHandler());

const PORT = parseInt(process.env.PORT ?? '3000', 10);
app.listen(PORT, '0.0.0.0', () => {
  logger.info('server.started', { port: PORT, env: process.env.NODE_ENV });
});

export default app;
