// ============================================================
// src/shared/middleware/error-handler.ts
//
// Central error handler for Express.
// Converts domain errors to consistent HTTP responses.
// ============================================================

import { Request, Response, NextFunction } from 'express';
import { FeatureNotAvailableError, UsageLimitReachedError } from '../permissions/errors';
import { logger } from '../logging/logger';

export function errorHandler() {
  return (err: Error, req: Request, res: Response, _next: NextFunction): void => {
    // Feature access denied — show upgrade prompt
    if (err instanceof FeatureNotAvailableError) {
      res.status(403).json({
        error: 'feature_not_available',
        message: err.message,
        feature: err.feature,
        requiredPlan: err.requiredPlan,
        upgradeUrl: '/settings/billing',
      });
      return;
    }

    // Usage limit reached
    if (err instanceof UsageLimitReachedError) {
      res.status(429).json({
        error: 'usage_limit_reached',
        message: err.message,
        feature: err.feature,
        upgradeUrl: '/settings/billing',
      });
      return;
    }

    // Unexpected errors — log full details, return generic message
    logger.error('request.unhandled_error', {
      error: err.message,
      stack: err.stack,
      method: req.method,
      path: req.path,
    });

    res.status(500).json({
      error: 'internal_server_error',
      message: 'An unexpected error occurred. Our team has been notified.',
    });
  };
}
