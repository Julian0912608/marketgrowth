// ============================================================
// src/modules/notifications/email.worker.ts
// Wijziging: dagelijkse admin update om 18:00 toegevoegd
// ============================================================

import { Queue, Worker, Job } from 'bullmq';
import { logger }             from '../../shared/logging/logger';
import { sendDailyBriefings } from './email.service';
import { sendDailyAdminUpdate } from './admin.notifications.service';

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

export const emailQueue = new Queue('email-notifications', {
  connection: emailConnection,
});

export async function scheduleEmailJobs(): Promise<void> {
  // Verwijder bestaande repeatable jobs om duplicaten te voorkomen
  const repeatable = await emailQueue.getRepeatableJobs();
  for (const job of repeatable) {
    if (job.name === 'daily-briefing' || job.name === 'admin-daily-update') {
      await emailQueue.removeRepeatableByKey(job.key);
    }
  }

  // Klant briefing: elke dag om 07:00 Amsterdam (06:00 UTC)
  await emailQueue.add(
    'daily-briefing',
    { type: 'daily_briefing' },
    {
      repeat: { pattern: '0 6 * * *' } as any,
      jobId:  'daily-briefing-scheduled',
    }
  );

  // Admin dagelijkse update: elke dag om 18:00 Amsterdam (17:00 UTC)
  await emailQueue.add(
    'admin-daily-update',
    { type: 'admin_daily_update' },
    {
      repeat: { pattern: '0 17 * * *' } as any,
      jobId:  'admin-daily-update-scheduled',
    }
  );

  logger.info('email.scheduler.registered', {
    jobs: [
      '0 6 * * * (UTC) = 07:00 Amsterdam — klant briefings',
      '0 17 * * * (UTC) = 18:00 Amsterdam — admin update',
    ],
  });
}

export const emailWorker = new Worker(
  'email-notifications',
  async (job: Job) => {
    logger.info('email.job.start', { jobName: job.name, jobId: job.id });

    if (job.name === 'daily-briefing') {
      await sendDailyBriefings();
    }

    if (job.name === 'admin-daily-update') {
      await sendDailyAdminUpdate();
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
