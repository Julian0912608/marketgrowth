// ============================================================
// src/shared/middleware/tenant.middleware.ts
//
// Extracts tenantId + userId from JWT on every request.
// Sets the tenant context so all downstream code has access.
// Sets PostgreSQL session variable for RLS enforcement.
// ============================================================

import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { v4 as uuidv4 } from 'uuid';
import { runWithTenantContext } from './tenant-context';
import { TenantContext, PlanSlug } from '../types/tenant';
import { logger } from '../logging/logger';
import { db } from '../../infrastructure/database/connection';

interface JwtPayload {
  tenantId: string;
  tenantSlug: string;
  userId: string;
  planSlug: PlanSlug;
  iat: number;
  exp: number;
}

export function tenantMiddleware() {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const authHeader = req.headers.authorization;

    if (!authHeader?.startsWith('Bearer ')) {
      res.status(401).json({ error: 'Missing or invalid Authorization header' });
      return;
    }

    const token = authHeader.split(' ')[1];

    let payload: JwtPayload;
    try {
      payload = jwt.verify(token, process.env.JWT_SECRET!) as JwtPayload;
    } catch (err) {
      res.status(401).json({ error: 'Invalid or expired token' });
      return;
    }

    // Build the context that will flow through the entire request
    const context: TenantContext = {
      tenantId: payload.tenantId,
      tenantSlug: payload.tenantSlug,
      userId: payload.userId,
      planSlug: payload.planSlug,
      traceId: uuidv4(),                    // unique per request for log correlation
      requestStartedAt: new Date(),
    };

    // Set PostgreSQL session variable so RLS policies activate
    // This runs before any query in this request
    await db.query(
      `SELECT set_config('app.tenant_id', $1, true)`,  // true = local to transaction
      [context.tenantId]
    );

    // Log every incoming request with full context
    logger.info('request.start', {
      traceId: context.traceId,
      tenantId: context.tenantId,
      tenantSlug: context.tenantSlug,
      userId: context.userId,
      planSlug: context.planSlug,
      method: req.method,
      path: req.path,
      ip: req.ip,
    });

    // Run the rest of the request inside the context
    runWithTenantContext(context, () => next());
  };
}
