// ============================================================
// src/modules/integrations/workers/sync.scheduler.ts
//
// Periodieke sync scheduler.
// Elke 15 minuten: zet incremental sync jobs in de queue
// voor alle actieve integraties die toe zijn aan sync.
//
// Dit is een aparte process naast de API server.
// Gebruik: node -r ts-node/register src/modules/integrations/workers/sync.scheduler.ts
// In productie: gebruik een cron job of Kubernetes CronJob
// ============================================================

import { db }       from '../../../infrastructure/database/connection';
import { logger }   from '../../../shared/logging/logger';
import { syncQueue } from './sync.worker';
import { PlatformSlug } from '../types/integration.types';
import crypto from 'crypto';

const SCHEDULER_INTERVAL_MS = 15 * 60 * 1000; // 15 minuten
const BATCH_SIZE = 100; // Verwerk 100 integraties per ronde

async function scheduleIncrementalSyncs(): Promise<void> {
  const startTime = Date.now();
  let offset = 0;
  let totalScheduled = 0;

  logger.info('scheduler.run.start', { timestamp: new Date().toISOString() });

  // Pagineer door alle actieve integraties die een sync nodig hebben
  while (true) {
    const rows = await db.query(
      `SELECT ti.id, ti.tenant_id, ti.platform_slug
       FROM tenant_integrations ti
       JOIN tenant_subscriptions ts ON ts.tenant_id = ti.tenant_id
       WHERE ti.status = 'active'
         AND (ti.next_sync_at IS NULL OR ti.next_sync_at <= now())
         AND ts.status IN ('active', 'trialing')
       ORDER BY ti.next_sync_at ASC NULLS FIRST
       LIMIT $1 OFFSET $2`,
      [BATCH_SIZE, offset],
      { allowNoTenant: true }
    );

    if (rows.rows.length === 0) break;

    for (const row of rows.rows) {
      try {
        // Sync job in database registreren
        const dbResult = await db.query(
          `INSERT INTO integration_sync_jobs (integration_id, tenant_id, job_type, status)
           VALUES ($1, $2, 'incremental', 'queued')
           RETURNING id`,
          [row.id, row.tenant_id],
          { allowNoTenant: true }
        );
        const syncJobDbId = dbResult.rows[0].id;

        // Job in queue plaatsen
        const job = await syncQueue.add(
          `${row.platform_slug}:incremental`,
          {
            integrationId: row.id,
            tenantId:      row.tenant_id,
            platformSlug:  row.platform_slug as PlatformSlug,
            jobType:       'incremental',
            syncJobDbId,
          },
          {
            attempts: 3,
            backoff: { type: 'exponential', delay: 10_000 },
            // Voorkomen dat dezelfde integratie dubbel in de queue zit
            jobId: `incremental:${row.id}:${Math.floor(Date.now() / SCHEDULER_INTERVAL_MS)}`,
          }
        );

        // next_sync_at bijwerken zodat deze niet opnieuw gepakt wordt
        await db.query(
          `UPDATE tenant_integrations
           SET next_sync_at = now() + INTERVAL '15 minutes'
           WHERE id = $1`,
          [row.id],
          { allowNoTenant: true }
        );

        totalScheduled++;
      } catch (err) {
        logger.error('scheduler.job.error', {
          integrationId: row.id,
          tenantId: row.tenant_id,
          error: (err as Error).message,
        });
      }
    }

    offset += BATCH_SIZE;

    // Kleine pauze tussen batches om database niet te overbelasten
    if (rows.rows.length === BATCH_SIZE) {
      await new Promise(r => setTimeout(r, 100));
    }
  }

  const duration = Date.now() - startTime;
  logger.info('scheduler.run.complete', {
    totalScheduled,
    durationMs: duration,
  });
}

// ── Stale job cleanup ─────────────────────────────────────────
// Jobs die al langer dan 30 minuten 'running' zijn zijn waarschijnlijk crasht
async function cleanupStaleJobs(): Promise<void> {
  const result = await db.query(
    `UPDATE integration_sync_jobs
     SET status = 'failed',
         error_message = 'Job timeout — automatisch hersteld door scheduler',
         completed_at = now()
     WHERE status = 'running'
       AND started_at < now() - INTERVAL '30 minutes'
     RETURNING id, integration_id`,
    [],
    { allowNoTenant: true }
  );

  if (result.rows.length > 0) {
    logger.warn('scheduler.stale_jobs.cleaned', { count: result.rows.length });

    // Zet de bijbehorende integraties terug op 'active' zodat ze opnieuw geprobeerd worden
    for (const row of result.rows) {
      await db.query(
        `UPDATE tenant_integrations
         SET status = CASE WHEN error_count >= 5 THEN 'error' ELSE 'active' END,
             updated_at = now()
         WHERE id = $1`,
        [row.integration_id],
        { allowNoTenant: true }
      );
    }
  }
}

// ── Hoofdloop ─────────────────────────────────────────────────
async function main(): Promise<void> {
  logger.info('sync.scheduler.started', {
    intervalMinutes: SCHEDULER_INTERVAL_MS / 60_000,
    batchSize: BATCH_SIZE,
  });

  // Direct uitvoeren bij opstarten
  await scheduleIncrementalSyncs();
  await cleanupStaleJobs();

  // Dan elke 15 minuten
  setInterval(async () => {
    await scheduleIncrementalSyncs();
    await cleanupStaleJobs();
  }, SCHEDULER_INTERVAL_MS);
}

main().catch(err => {
  logger.error('sync.scheduler.fatal', { error: err.message });
  process.exit(1);
});
