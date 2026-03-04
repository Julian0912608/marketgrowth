// ============================================================
// src/index.ts
// ============================================================

import express from 'express';
import cookieParser from 'cookie-parser';
import { errorHandler } from './shared/middleware/error-handler';
import { logger } from './shared/logging/logger';

const app = express();

// Stripe webhook heeft raw body nodig — vóór express.json()
app.use('/api/billing/webhook', express.raw({ type: 'application/json' }));

// Standaard middleware
app.use(express.json());
app.use(cookieParser());

// Health check
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Error handler
app.use(errorHandler());

const PORT = parseInt(process.env.PORT ?? '3000', 10);
app.listen(PORT, '0.0.0.0', () => {
  logger.info('server.started', { port: PORT, env: process.env.NODE_ENV });
});

export default app;
