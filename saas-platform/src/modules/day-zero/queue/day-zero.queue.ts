// ============================================================
// src/modules/day-zero/queue/day-zero.queue.ts
//
// BullMQ queue voor Day Zero stage jobs.
// Gebruikt hetzelfde Redis-pattern als sync.worker.ts en email.worker.ts.
//
// IDEMPOTENCY: BullMQ genereert zelf jobIds. De "draait al" guard
// zit in DayZeroService.initForTenant via DB status check op
// tenant_day_zero_progress. Dat is genoeg en voorkomt dat we
// custom jobIds met colons gebruiken (wat BullMQ 5.x weigert).
// ============================================================

import { Queue, QueueEvents } from 'bullmq';
import { logger } from '../../../shared/logging/logger';
import {
  DayZeroJobData,
  DayZeroStage,
  PLAN_PRIORITY,
  TenantPlan,
} from '../types/day-zero.types';

// ── Redis connectie (gelijk aan sync/email workers) ───────────
function buildConnection() {
  const url = process.env.REDIS_URL;
  const IORedis = require('ioredis');

  if (!url) {
    return new IORedis({ host: 'localhost', port: 6379, maxRetriesPerRequest: null });
  }

  const isTLS  = url.startsWith('rediss://');
  let hostname = 'localhost';
  try { hostname = new URL(url).hostname; } catch {}

  return new IORedis(url, {
    tls: isTLS ? { rejectUnauthorized: false, servername: hostname } : undefined,
    maxRetriesPerRequest: null,
    enableOfflineQueue:   true,
    lazyConnect:          false,
    family:               4,
    retryStrategy: (times: number) => {
      if (times > 10) return null;
      return Math.min(times * 500, 5000);
    },
  });
}

export const dayZeroConnection = buildConnection();

// ── Queue ─────────────────────────────────────────────────────
export const DAY_ZERO_QUEUE_NAME = 'day-zero';

export const dayZeroQueue = new Queue<DayZeroJobData>(DAY_ZERO_QUEUE_NAME, {
  connection: dayZeroConnection,
  defaultJobOptions: {
    attempts: 3,
    backoff: {
      type:  'exponential',
      delay: 30_000,
    },
    removeOnComplete: {
      age:   60 * 60,
      count: 1000,
    },
    removeOnFail: {
      age: 60 * 60 * 24 * 7,
    },
  },
});

// ── Queue events voor logging ─────────────────────────────────
export const dayZeroQueueEvents = new QueueEvents(DAY_ZERO_QUEUE_NAME, {
  connection: buildConnection(),
});

dayZeroQueueEvents.on('failed', ({ jobId, failedReason }) => {
  logger.warn('day_zero.queue.failed', { jobId, reason: failedReason });
});

dayZeroQueueEvents.on('completed', ({ jobId, returnvalue }) => {
  logger.info('day_zero.queue.completed', { jobId, returnvalue });
});

// ── Public API ────────────────────────────────────────────────
export async function enqueueDayZero(
  tenantId: string,
  plan:     TenantPlan,
): Promise<string> {
  const priority = PLAN_PRIORITY[plan] ?? PLAN_PRIORITY.starter;

  const job = await dayZeroQueue.add(
    'stage',
    { tenantId, stage: 1 },
    { priority },
  );

  logger.info('day_zero.queue.enqueued', {
    tenantId,
    plan,
    priority,
    stage:  1,
    jobId:  job.id,
  });

  return job.id ?? 'unknown';
}

export async function enqueueNextStage(
  tenantId: string,
  nextStage: DayZeroStage,
  plan: TenantPlan,
): Promise<void> {
  if (nextStage < 1 || nextStage > 5) return;

  const priority = PLAN_PRIORITY[plan] ?? PLAN_PRIORITY.starter;

  const job = await dayZeroQueue.add(
    'stage',
    { tenantId, stage: nextStage },
    { priority },
  );

  logger.info('day_zero.queue.next', {
    tenantId,
    nextStage,
    priority,
    jobId: job.id,
  });
}
