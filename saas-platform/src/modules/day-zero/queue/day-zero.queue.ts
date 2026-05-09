// ============================================================
// src/modules/day-zero/queue/day-zero.queue.ts
//
// BullMQ queue voor Day Zero stage jobs.
//
// LET OP: ik maak hier mijn eigen Queue + Redis connection vanuit env.
// Als jouw codebase al een shared Redis-helper heeft (bijv.
// shared/queue/redis.ts), vervang `connection` door die import.
// ============================================================

import { Queue, QueueEvents } from 'bullmq';
import IORedis from 'ioredis';
import { logger } from '../../../shared/logging/logger';
import {
  DayZeroJobData,
  DayZeroStage,
  PLAN_PRIORITY,
  TenantPlan,
} from '../types/day-zero.types';

// --------------------------------------------------------------
// Connection
// --------------------------------------------------------------

const REDIS_URL = process.env.REDIS_URL || process.env.UPSTASH_REDIS_URL;
if (!REDIS_URL) {
  throw new Error('REDIS_URL or UPSTASH_REDIS_URL must be set for Day Zero queue.');
}

export const dayZeroConnection = new IORedis(REDIS_URL, {
  maxRetriesPerRequest:  null,    // BullMQ vereiste
  enableReadyCheck:      false,
});

// --------------------------------------------------------------
// Queue
// --------------------------------------------------------------

export const DAY_ZERO_QUEUE_NAME = 'day-zero';

export const dayZeroQueue = new Queue<DayZeroJobData>(DAY_ZERO_QUEUE_NAME, {
  connection: dayZeroConnection,
  defaultJobOptions: {
    attempts: 3,
    backoff: {
      type:  'exponential',
      delay: 30_000,    // 30s, 60s, 120s
    },
    removeOnComplete: {
      age:   60 * 60 * 24,    // 24h
      count: 1000,
    },
    removeOnFail: {
      age: 60 * 60 * 24 * 7,  // 7d voor debugging
    },
  },
});

// QueueEvents instance voor logging
export const dayZeroQueueEvents = new QueueEvents(DAY_ZERO_QUEUE_NAME, {
  connection: dayZeroConnection.duplicate(),
});

dayZeroQueueEvents.on('failed', ({ jobId, failedReason }) => {
  logger.warn('day_zero.queue.failed', { jobId, reason: failedReason });
});

dayZeroQueueEvents.on('completed', ({ jobId, returnvalue }) => {
  logger.info('day_zero.queue.completed', { jobId, returnvalue });
});

// --------------------------------------------------------------
// Public API
// --------------------------------------------------------------

/**
 * Enqueue de eerste stage. Volgende stages worden door de worker
 * zelf ge-enqueued na succesvolle completion.
 */
export async function enqueueDayZero(
  tenantId: string,
  plan:     TenantPlan,
): Promise<void> {
  const priority = PLAN_PRIORITY[plan] ?? PLAN_PRIORITY.starter;

  await dayZeroQueue.add(
    'stage',
    { tenantId, stage: 1 },
    {
      priority,
      jobId: `day-zero:${tenantId}:stage-1`,    // idempotent: zelfde tenant kan niet twee keer stage 1 starten
    },
  );

  logger.info('day_zero.queue.enqueued', { tenantId, plan, priority, stage: 1 });
}

/**
 * Wordt door de worker aangeroepen na een succesvolle stage,
 * om de volgende stage te plannen.
 */
export async function enqueueNextStage(
  tenantId: string,
  nextStage: DayZeroStage,
  plan: TenantPlan,
): Promise<void> {
  if (nextStage < 1 || nextStage > 5) return;

  const priority = PLAN_PRIORITY[plan] ?? PLAN_PRIORITY.starter;

  await dayZeroQueue.add(
    'stage',
    { tenantId, stage: nextStage },
    {
      priority,
      jobId: `day-zero:${tenantId}:stage-${nextStage}`,
    },
  );

  logger.info('day_zero.queue.next', { tenantId, nextStage, priority });
}
