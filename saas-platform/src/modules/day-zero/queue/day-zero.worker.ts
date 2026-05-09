// ============================================================
// src/modules/day-zero/queue/day-zero.worker.ts
//
// BullMQ worker voor Day Zero stages.
// Start via createDayZeroWorker() vanuit je main entry point
// (of een dedicated worker process).
// ============================================================

import { Worker, Job } from 'bullmq';
import { logger } from '../../../shared/logging/logger';
import { supabaseAdmin } from '../../../shared/database/supabase';
import { dayZeroService } from '../service/day-zero.service';
import {
  dayZeroConnection,
  DAY_ZERO_QUEUE_NAME,
  enqueueNextStage,
} from './day-zero.queue';
import { DayZeroJobData, TenantPlan } from '../types/day-zero.types';

// COGS-discipline: 2 parallelle Day Zero jobs is genoeg voor V0 launch.
// Schaal naar 5 zodra we >50 nieuwe sign-ups per dag hebben.
const CONCURRENCY = 2;

export function createDayZeroWorker(): Worker<DayZeroJobData> {
  const worker = new Worker<DayZeroJobData>(
    DAY_ZERO_QUEUE_NAME,
    async (job: Job<DayZeroJobData>) => {
      const { tenantId, stage } = job.data;

      logger.info('day_zero.worker.process', {
        jobId: job.id,
        tenantId,
        stage,
        attempt: job.attemptsMade + 1,
      });

      const result = await dayZeroService.runStage(job.data);

      // Auto-enqueue volgende stage als er een is
      if (result.next !== null) {
        const plan = await fetchTenantPlan(tenantId);
        await enqueueNextStage(tenantId, result.next, plan);
      }

      return { tenantId, completedStage: stage, next: result.next };
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

// --------------------------------------------------------------
// Helpers
// --------------------------------------------------------------

async function fetchTenantPlan(tenantId: string): Promise<TenantPlan> {
  // ASSUMPTION: tenants.plan kolom bestaat (waardes 'starter'|'growth'|'scale').
  // Pas aan als je plan op een andere tabel staat (bijv. subscriptions.plan).
  const { data, error } = await supabaseAdmin
    .from('tenants')
    .select('plan')
    .eq('id', tenantId)
    .maybeSingle();

  if (error || !data) {
    logger.warn('day_zero.worker.plan_fallback', { tenantId, error: error?.message });
    return 'starter';
  }

  const plan = (data as any).plan as string;
  if (plan === 'scale' || plan === 'growth' || plan === 'starter') return plan;
  return 'starter';
}
