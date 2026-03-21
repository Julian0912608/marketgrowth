// ============================================================
// src/modules/notifications/email.worker.ts — DEFINITIEF
// Jobs:
//   1. daily-briefing   — elke dag 07:00 — klant AI briefing
//   2. trial-emails     — elke dag 09:00 — dag 10 + dag 13 trial
//   3. weekly-report    — elke maandag 08:00 — weekrapport
//   4. admin-daily-update — elke dag 18:00 — admin overzicht
// ============================================================

import { Queue, Worker, Job } from 'bullmq';
import { logger }               from '../../shared/logging/logger';
import { sendDailyBriefings }   from './email.service';
import { sendDailyAdminUpdate } from './admin.notifications.service';
import { sendTrialEmails }      from './trial.email.service';
import { sendWeeklyReports }    from './weekly.report.service';

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
    if (['daily-briefing', 'trial-emails', 'weekly-report', 'admin-daily-update'].includes(job.name)) {
      await emailQueue.removeRepeatableByKey(job.key);
    }
  }

  // 1. Klant briefing: elke dag om 07:00 Amsterdam (06:00 UTC)
  await emailQueue.add(
    'daily-briefing',
    { type: 'daily_briefing' },
    { repeat: { pattern: '0 6 * * *' } as any, jobId: 'daily-briefing-scheduled' }
  );

  // 2. Trial emails: elke dag om 09:00 Amsterdam (08:00 UTC)
  await emailQueue.add(
    'trial-emails',
    { type: 'trial_emails' },
    { repeat: { pattern: '0 8 * * *' } as any, jobId: 'trial-emails-scheduled' }
  );

  // 3. Weekrapport: elke maandag om 08:00 Amsterdam (07:00 UTC)
  await emailQueue.add(
    'weekly-report',
    { type: 'weekly_report' },
    { repeat: { pattern: '0 7 * * 1' } as any, jobId: 'weekly-report-scheduled' }
  );

  // 4. Admin dagelijkse update: elke dag om 18:00 Amsterdam (17:00 UTC)
  await emailQueue.add(
    'admin-daily-update',
    { type: 'admin_daily_update' },
    { repeat: { pattern: '0 17 * * *' } as any, jobId: 'admin-daily-update-scheduled' }
  );

  logger.info('email.scheduler.registered', {
    jobs: [
      '0 6 * * *  (UTC) = 07:00 Amsterdam — klant briefings',
      '0 8 * * *  (UTC) = 09:00 Amsterdam — trial emails',
      '0 7 * * 1  (UTC) = 08:00 Amsterdam maandag — weekrapport',
      '0 17 * * * (UTC) = 18:00 Amsterdam — admin update',
    ],
  });
}

export const emailWorker = new Worker(
  'email-notifications',
  async (job: Job) => {
    logger.info('email.job.start', { jobName: job.name, jobId: job.id });

    switch (job.name) {
      case 'daily-briefing':
        await sendDailyBriefings();
        break;
      case 'trial-emails':
        await sendTrialEmails();
        break;
      case 'weekly-report':
        await sendWeeklyReports();
        break;
      case 'admin-daily-update':
        await sendDailyAdminUpdate();
        break;
      default:
        logger.warn('email.job.unknown', { jobName: job.name });
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
