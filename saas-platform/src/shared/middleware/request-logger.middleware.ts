// src/shared/middleware/request-logger.middleware.ts
import { Request, Response, NextFunction } from 'express';
import { logger } from '../logging/logger';

export function requestLogger(req: Request, res: Response, next: NextFunction): void {
  const start = Date.now();

  res.on('finish', () => {
    const duration = Date.now() - start;
    const level = res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info';

    logger[level]('http.request', {
      method:   req.method,
      path:     req.path,
      status:   res.statusCode,
      duration,
      ip:       req.ip,
    });
  });

  next();
}
