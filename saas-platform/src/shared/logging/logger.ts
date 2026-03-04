// ============================================================
// src/shared/logging/logger.ts
//
// Structured logger. Every log line automatically includes
// tenantId + traceId when called within a request context.
// ============================================================

import winston from 'winston';
import { getTenantContextOrNull } from '../middleware/tenant-context';

const winstonLogger = winston.createLogger({
  level: process.env.LOG_LEVEL ?? 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()           // structured JSON logs for log aggregators
  ),
  transports: [
    new winston.transports.Console(),
  ],
});

type LogMeta = Record<string, unknown>;

// Wraps winston to auto-inject tenant context into every log line
class Logger {
  private enrichMeta(meta?: LogMeta): LogMeta {
    const ctx = getTenantContextOrNull();
    return {
      ...(ctx ? {
        tenantId: ctx.tenantId,
        traceId: ctx.traceId,
        userId: ctx.userId,
      } : {}),
      ...meta,
    };
  }

  info(event: string, meta?: LogMeta): void {
    winstonLogger.info(event, this.enrichMeta(meta));
  }

  warn(event: string, meta?: LogMeta): void {
    winstonLogger.warn(event, this.enrichMeta(meta));
  }

  error(event: string, meta?: LogMeta): void {
    winstonLogger.error(event, this.enrichMeta(meta));
  }

  debug(event: string, meta?: LogMeta): void {
    winstonLogger.debug(event, this.enrichMeta(meta));
  }
}

export const logger = new Logger();
