// ============================================================
// src/modules/integrations/workers/startup-sync.ts
// ============================================================

import { db }        from '../../../infrastructure/database/connection';
import { logger }    from '../../../shared/logging/logger';
import { syncQueue } from './sync.worker';
import { v4 as uuidv4 } from 'uuid';

const INCREMENTAL_INTERVAL_MS = 15 * 60 * 1000; // 15 minuten
const BATCH_SIZE               = 100;

// ── Full sync bij opstarten ───────────────────────────────────
// Triggert full_sync voor integraties die langer dan 1 uur niet gesynchroniseerd zijn
export async function startupFullSync(): Promise<void> {
  logger.info('startup.sync.start');

  try {
    const rows = await db.query<{
      id: string; tenant_id: string; platform_slug: string;
    }>(
      `SELECT ti.id, ti.tenant_id, ti.platform_slug
       FROM tenant_integrations ti
       JOIN tenant_subscriptions ts ON ts.tenant_id = ti.tenant_id
       WHERE ti.status = 'active'
         AND ti.platform_slug NOT IN ('bolcom_ads', 'google_ads')
         AND ts.status IN ('active', 'trialing')
         AND (
           ti.last_sync_at IS NULL
           OR ti.last_sync_at < now() - INTERVAL '1 hour'
         )
       ORDER BY ti.last_sync_at ASC NULLS FIRST
       LIMIT $1`,
      [BATCH_SIZE],
      { allowNoTenant: true }
    );

    if (rows.rows.length === 0) {
      logger.info('startup.sync.skip', { reason: 'All integrations recently synced' });
      return;
    }

    let queued = 0;
    for (const row of rows.rows) {
      try {
        const syncJobDbId = uuidv4();
        await db.query(
          `INSERT INTO integration_sync_jobs (id, integration_id, tenant_id, job_type, status, created_at)
           VALUES ($1, $2, $3, 'full_sync', 'queued', now())`,
          [syncJobDbId, row.id, row.tenant_id],
          { allowNoTenant: true }
        );

        await syncQueue.add(
          `startup:${row.platform_slug}:${row.id}`,
          {
            integrationId: row.id,
            tenantId:      row.tenant_id,
            platformSlug:  row.platform_slug,
            jobType:       'full_sync' as const,
            syncJobDbId,
          },
          {
            attempts:         3,
            backoff:          { type: 'exponential', delay: 10_000 },
            jobId:            `startup:${row.id}`,
            removeOnComplete: 50,
            removeOnFail:     25,
          }
        );

        // Zet next_sync_at zodat scheduler hem niet dubbel pakt
        await db.query(
          `UPDATE tenant_integrations SET next_sync_at = now() + INTERVAL '15 minutes' WHERE id = $1`,
          [row.id], { allowNoTenant: true }
        );

        queued++;
      } catch (err) {
        logger.warn('startup.sync.queue_error', {
          integrationId: row.id,
          error: (err as Error).message,
        });
      }
    }

    logger.info('startup.sync.complete', { queued, total: rows.rows.length });
  } catch (err) {
    logger.error('startup.sync.fatal', { error: (err as Error).message });
  }
}

// ── Incrementele sync scheduler ───────────────────────────────
async function runIncrementalSyncs(): Promise<void> {
  let offset = 0;
  let total  = 0;

  while (true) {
    const rows = await db.query<{
      id: string; tenant_id: string; platform_slug: string;
    }>(
      `SELECT ti.id, ti.tenant_id, ti.platform_slug
       FROM tenant_integrations ti
       JOIN tenant_subscriptions ts ON ts.tenant_id = ti.tenant_id
       WHERE ti.status = 'active'
         AND ti.platform_slug NOT IN ('bolcom_ads', 'google_ads')
         AND ts.status IN ('active', 'trialing')
         AND (ti.next_sync_at IS NULL OR ti.next_sync_at <= now())
       ORDER BY ti.next_sync_at ASC NULLS FIRST
       LIMIT $1 OFFSET $2`,
      [BATCH_SIZE, offset],
      { allowNoTenant: true }
    );

    if (rows.rows.length === 0) break;

    for (const row of rows.rows) {
      try {
        const syncJobDbId = uuidv4();
        await db.query(
          `INSERT INTO integration_sync_jobs (id, integration_id, tenant_id, job_type, status, created_at)
           VALUES ($1, $2, $3, 'incremental', 'queued', now())`,
          [syncJobDbId, row.id, row.tenant_id],
          { allowNoTenant: true }
        );

        await syncQueue.add(
          `incremental:${row.platform_slug}:${row.id}`,
          {
            integrationId: row.id,
            tenantId:      row.tenant_id,
            platformSlug:  row.platform_slug,
            jobType:       'incremental' as const,
            syncJobDbId,
          },
          {
            attempts:         3,
            backoff:          { type: 'exponential', delay: 10_000 },
            jobId:            `incremental:${row.id}:${Math.floor(Date.now() / INCREMENTAL_INTERVAL_MS)}`,
            removeOnComplete: 100,
            removeOnFail:     50,
          }
        );

        await db.query(
          `UPDATE tenant_integrations SET next_sync_at = now() + INTERVAL '15 minutes' WHERE id = $1`,
          [row.id], { allowNoTenant: true }
        );

        total++;
      } catch (err) {
        logger.warn('scheduler.incremental.error', {
          integrationId: row.id,
          error: (err as Error).message,
        });
      }
    }

    offset += BATCH_SIZE;
    if (rows.rows.length < BATCH_SIZE) break;
    await new Promise(r => setTimeout(r, 100));
  }

  if (total > 0) logger.info('scheduler.incremental.complete', { total });
}

// Ruim vastgelopen sync jobs op
async function cleanupStaleJobs(): Promise<void> {
  const result = await db.query(
    `UPDATE integration_sync_jobs
     SET status = 'failed', error_message = 'Timeout — hersteld door scheduler', completed_at = now()
     WHERE status = 'running' AND started_at < now() - INTERVAL '30 minutes'
     RETURNING integration_id`,
    [], { allowNoTenant: true }
  );
  if (result.rows.length > 0) {
    logger.warn('scheduler.stale_jobs.cleaned', { count: result.rows.length });
  }
}

// ── Start de in-process scheduler ────────────────────────────
export function startSyncScheduler(): void {
  logger.info('sync.scheduler.starting', { intervalMinutes: INCREMENTAL_INTERVAL_MS / 60_000 });

  runIncrementalSyncs().catch(err =>
    logger.error('scheduler.run.error', { error: err.message })
  );
  cleanupStaleJobs().catch(() => {});

  setInterval(() => {
    runIncrementalSyncs().catch(err =>
      logger.error('scheduler.run.error', { error: err.message })
    );
    cleanupStaleJobs().catch(() => {});
  }, INCREMENTAL_INTERVAL_MS);

  logger.info('sync.scheduler.started');
}
