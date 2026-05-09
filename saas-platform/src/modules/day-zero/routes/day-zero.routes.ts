// ============================================================
// src/modules/day-zero/routes/day-zero.routes.ts
//
// Express router voor /api/day-zero/*
// ============================================================

import { Router } from 'express';
import { getDayZeroStatus } from '../controller/day-zero.controller';

// ASSUMPTION: jij hebt een auth middleware die tenant context zet.
// Vervang `requireAuth` door jouw bestaande middleware naam.
// Bijv. uit shared/middleware/auth.middleware.ts
// import { requireAuth } from '../../../shared/middleware/auth.middleware';

const dayZeroRouter = Router();

// Polling endpoint. Auth required.
dayZeroRouter.get(
  '/status',
  // requireAuth,    <- uncomment en align met je middleware
  getDayZeroStatus,
);

export { dayZeroRouter };
