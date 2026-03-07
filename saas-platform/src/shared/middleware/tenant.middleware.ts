// src/shared/middleware/tenant.middleware.ts
//
// Zet de tenant context op basis van het JWT token.
// Wordt aangeroepen NA authenticate middleware.

import { Request, Response, NextFunction } from 'express';
import { runWithTenant } from '../../infrastructure/database/connection';

export function tenantMiddleware(req: Request, res: Response, next: NextFunction): void {
  const user = (req as any).user;

  if (!user?.tenantId) {
    // Geen tenant — dit kan bij sommige publieke endpoints
    next();
    return;
  }

  // Wrap de rest van de request in tenant context
  runWithTenant(user.tenantId, () => next());
}
