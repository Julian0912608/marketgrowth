// src/shared/middleware/error.middleware.ts
import { Request, Response, NextFunction } from 'express';
import { ZodError } from 'zod';
import { logger } from '../logging/logger';

export function errorHandler(
  err: any,
  req: Request,
  res: Response,
  _next: NextFunction
): void {
  // Zod validatie errors
  if (err instanceof ZodError) {
    res.status(400).json({
      error: 'Validatiefout',
      details: err.errors.map(e => ({
        field: e.path.join('.'),
        message: e.message,
      })),
    });
    return;
  }

  // JWT errors
  if (err.name === 'JsonWebTokenError' || err.name === 'TokenExpiredError') {
    res.status(401).json({ error: 'Ongeldige of verlopen sessie' });
    return;
  }

  // Database unique constraint
  if (err.code === '23505') {
    res.status(409).json({ error: 'Dit record bestaat al' });
    return;
  }

  // CORS error
  if (err.message?.startsWith('CORS geblokkeerd')) {
    res.status(403).json({ error: err.message });
    return;
  }

  // Generic error
  const statusCode = err.statusCode || err.status || 500;
  const message = statusCode < 500 ? err.message : 'Interne serverfout';

  if (statusCode >= 500) {
    logger.error('request.error', {
      method: req.method,
      path:   req.path,
      error:  err.message,
      stack:  err.stack,
    });
  }

  res.status(statusCode).json({ error: message });
}
