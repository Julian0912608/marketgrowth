// ============================================================
// src/index.ts — Application entry point
// ============================================================

import express from 'express';
import { tenantMiddleware } from './shared/middleware/tenant.middleware';
import { errorHandler } from './shared/middleware/error-handler';
import { logger } from './shared/logging/logger';

const app = express();
app.use(express.json());

// ─── Health check (no auth required) ────────────────────────
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ─── All API routes are tenant-scoped ───────────────────────
// The tenantMiddleware runs on every /api/* route.
// It sets the tenant context so all downstream code has access.
app.use('/api', tenantMiddleware());

// ─── Module routes ───────────────────────────────────────────
// Each module registers its own routes. No module knows about others.
// import { salesDashboardRouter } from './modules/sales-dashboard/api/routes';
// app.use('/api/sales', salesDashboardRouter);

// ─── Error handler (must be last) ───────────────────────────
app.use(errorHandler());

const PORT = process.env.PORT ?? 3000;
app.listen(PORT, () => {
  logger.info('server.started', { port: PORT, env: process.env.NODE_ENV });
});

export default app;
