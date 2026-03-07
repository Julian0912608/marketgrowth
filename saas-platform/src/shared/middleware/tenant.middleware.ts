import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { v4 as uuidv4 } from 'uuid';
import { runWithTenantContext } from './tenant-context';
import { db } from '../../infrastructure/database/connection';

export function tenantMiddleware() {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const authHeader = req.headers.authorization;

    if (!authHeader?.startsWith('Bearer ')) {
      res.status(401).json({ error: 'Niet ingelogd' });
      return;
    }

    const token = authHeader.split(' ')[1];

    let payload: any;
    try {
      payload = jwt.verify(token, process.env.JWT_SECRET || 'dev-secret-change-in-production');
    } catch (err) {
      res.status(401).json({ error: 'Ongeldige of verlopen sessie' });
      return;
    }

    const context = {
      tenantId:         payload.tenantId,
      tenantSlug:       payload.tenantSlug || '',
      userId:           payload.sub,
      planSlug:         payload.planSlug || 'starter',
      traceId:          uuidv4(),
      requestStartedAt: new Date(),
    };

    try {
      await db.query(
        `SELECT set_config('app.tenant_id', $1, true)`,
        [context.tenantId]
      );
    } catch {
      // Doorgaan ook als set_config faalt
    }

    runWithTenantContext(context, () => next());
  };
}
