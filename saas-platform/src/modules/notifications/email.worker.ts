// ============================================================
// saas-platform/src/modules/notifications/email.worker.ts
//
// BullMQ worker + scheduled job voor dagelijkse briefing emails
// Voeg dit toe aan src/index.ts na de andere workers
// ============================================================

import { Queue, Worker, Job } from 'bullmq';
import { logger }             from '../../shared/logging/logger';
import { sendDailyBriefings } from './email.service';

// Gebruik dezelfde Redis connectie als de sync worker
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
    retryStrategy: (times: number) => {
      if (times > 10) return null;
      return Math.min(times * 500, 5000);
    },
  });
}

const emailConnection = buildConnection();

// ── Queue ──────────────────────────────────────────────────────
export const emailQueue = new Queue('email-notifications', {
  connection: emailConnection,
});

// ── Scheduled job: elke dag om 7:00 Amsterdam tijd ────────────
export async function scheduleEmailJobs(): Promise<void> {
  // Verwijder bestaande repeatable jobs om duplicaten te voorkomen
  const repeatable = await emailQueue.getRepeatableJobs();
  for (const job of repeatable) {
    if (job.name === 'daily-briefing') {
      await emailQueue.removeRepeatableByKey(job.key);
    }
  }

  // Plan dagelijkse briefing om 7:00 Amsterdam tijd (UTC+1/+2)
  // Cron: 0 6 * * * = elke dag om 06:00 UTC = 07:00 CET / 08:00 CEST
  await emailQueue.add(
    'daily-briefing',
    { type: 'daily_briefing' },
    {
      repeat: { cron: '0 6 * * *' },
      jobId:  'daily-briefing-scheduled',
    }
  );

  logger.info('email.scheduler.registered', { cron: '0 6 * * * (UTC) = 07:00 Amsterdam' });
}

// ── Worker ─────────────────────────────────────────────────────
export const emailWorker = new Worker(
  'email-notifications',
  async (job: Job) => {
    logger.info('email.job.start', { jobName: job.name, jobId: job.id });

    if (job.name === 'daily-briefing') {
      await sendDailyBriefings();
    }

    logger.info('email.job.complete', { jobName: job.name });
  },
  {
    connection:   emailConnection,
    concurrency:  1,
    removeOnComplete: { count: 50 },
    removeOnFail:     { count: 20 },
  }
);

emailWorker.on('failed', (job, err) => {
  logger.error('email.job.failed', {
    jobId:   job?.id,
    jobName: job?.name,
    error:   err.message,
  });
});
