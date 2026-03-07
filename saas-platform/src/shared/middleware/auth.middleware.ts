// src/shared/middleware/auth.middleware.ts
import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { logger } from '../logging/logger';

export interface JwtPayload {
  sub:      string;   // userId
  tenantId: string;
  email:    string;
  planSlug: string;
  iat:      number;
  exp:      number;
}

export function authenticate(req: Request, res: Response, next: NextFunction): void {
  // Token uit Authorization header of cookie
  let token: string | undefined;

  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith('Bearer ')) {
    token = authHeader.slice(7);
  } else if (req.cookies?.accessToken) {
    token = req.cookies.accessToken;
  }

  if (!token) {
    res.status(401).json({ error: 'Niet ingelogd' });
    return;
  }

  const secret = process.env.JWT_SECRET;
  if (!secret) {
    logger.error('auth.no_jwt_secret');
    res.status(500).json({ error: 'Server configuratie fout' });
    return;
  }

  try {
    const payload = jwt.verify(token, secret) as JwtPayload;
    (req as any).user = {
      userId:   payload.sub,
      tenantId: payload.tenantId,
      email:    payload.email,
      planSlug: payload.planSlug,
    };
    next();
  } catch (err: any) {
    if (err.name === 'TokenExpiredError') {
      res.status(401).json({ error: 'Sessie verlopen' });
    } else {
      res.status(401).json({ error: 'Ongeldige sessie' });
    }
  }
}
