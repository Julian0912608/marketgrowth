// ============================================================
// src/modules/day-zero/queue/day-zero.worker.ts
//
// BullMQ worker voor Day Zero stages.
// Dom: roept service.runStage() aan en logt het resultaat.
// Alle business logic (next stage enqueue, plan lookup) zit in de service.
// ============================================================

import { Worker, Job } from 'bullmq';
import { logger } from '../../../shared/logging/logger';
import { dayZeroService } from '../service/day-zero.service';
import {
  dayZeroConnection,
  DAY_ZERO_QUEUE_NAME,
} from './day-zero.queue';
import { DayZeroJobData } from '../types/day-zero.types';

// COGS-discipline: 2 parallelle Day Zero jobs is genoeg voor V0 launch.
// Schaal naar 5 zodra we >50 nieuwe sign-ups per dag hebben.
const CONCURRENCY = 2;

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
      connection:  dayZeroConnection.duplicate(),
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
