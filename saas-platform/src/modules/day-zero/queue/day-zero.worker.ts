// ============================================================
// src/modules/day-zero/queue/day-zero.worker.ts
//
// BullMQ worker voor Day Zero stages.
// Eigen Redis connection (gelijk aan sync/email worker pattern).
// ============================================================

import { Worker, Job } from 'bullmq';
import { logger } from '../../../shared/logging/logger';
import { dayZeroService } from '../service/day-zero.service';
import { DAY_ZERO_QUEUE_NAME } from './day-zero.queue';
import { DayZeroJobData } from '../types/day-zero.types';

// COGS-discipline: 2 parallelle Day Zero jobs is genoeg voor V0 launch.
const CONCURRENCY = 2;

// Eigen connection voor worker (zelfde pattern als sync/email worker).
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

export function createDayZeroWorker(): Worker<DayZeroJobData> {
  const worker = new Worker<DayZeroJobData>(
    DAY_ZERO_QUEUE_NAME,
    async (job: Job<DayZeroJobData>) => {
      const { tenantId, stage } = job.data;

      logger.info('day_zero.worker.process', {
        jobId:   job.id,
        tenantId,
        stage,
        attempt: job.attemptsMade + 1,
      });

      const result = await dayZeroService.runStage(job.data);

      return {
        tenantId,
        completedStage: stage,
        next:           result.next,
      };
    },
    {
      connection:  buildConnection(),
      concurrency: CONCURRENCY,
    },
  );

  worker.on('failed', (job, err) => {
    logger.error('day_zero.worker.failed', {
      jobId:    job?.id,
      tenantId: job?.data?.tenantId,
      stage:    job?.data?.stage,
      attempt:  job?.attemptsMade,
      error:    err.message,
    });
  });

  worker.on('completed', (job, returnvalue) => {
    logger.info('day_zero.worker.completed', {
      jobId:    job.id,
      tenantId: job.data.tenantId,
      returnvalue,
    });
  });

  logger.info('day_zero.worker.started', { concurrency: CONCURRENCY });

  return worker;
}
