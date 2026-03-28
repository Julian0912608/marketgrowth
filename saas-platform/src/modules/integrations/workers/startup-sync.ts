// ============================================================
// src/modules/integrations/workers/startup-sync.ts
//
// Twee verantwoordelijkheden:
//
// 1. startupFullSync() — wordt éénmalig bij server start aangeroepen.
//    Triggert een full_sync voor alle actieve integraties die langer
//    dan 2 uur niet gesynchroniseerd zijn. Zo is data altijd vers
//    na een deploy of server restart.
//
// 2. startSyncScheduler() — start de 15-minuten incrementele
//    scheduler als in-process loop (geen apart process nodig).
//    Vervangt het aparte sync.scheduler.ts script.
// ============================================================

import { db }        from '../../../infrastructure/database/connection';
import { logger }    from '../../../shared/logging/logger';
import { syncQueue } from './sync.worker';
import { PlanSlug }  from '../../../shared/types/tenant';
import { v4 as uuidv4 } from 'uuid';

const INCREMENTAL_INTERVAL_MS = 15 * 60 * 1000; // 15 minuten
const STALE_THRESHOLD_HOURS   = 2;               // sync als ouder dan 2u
const BATCH_SIZE               = 100;

// ── Prioriteit op basis van plan ──────────────────────────────
function getPriority(planSlug: string): number {
  if (planSlug === 'scale')  return 1;
  if (planSlug === 'growth') return 5;
  return 10;
}

// ── Full sync bij opstarten ───────────────────────────────────
export async function startupFullSync(): Promise<void> {
  logger.info('startup.sync.start');

  try {
    const rows = await db.query<{
      id: string; tenant_id: string; platform_slug: string; plan_slug: string;
    }>(
      `SELECT ti.id, ti.tenant_id, ti.platform_slug,
              COALESCE(p.slug, 'starter') AS plan_slug
       FROM tenant_integrations ti
       JOIN tenant_subscriptions ts ON ts.tenant_id = ti.tenant_id
       JOIN plans p ON p.id = ts.plan_id
       WHERE ti.status = 'active'
         AND ti.platform_slug NOT IN ('bolcom_ads', 'google_ads')
         AND ts.status IN ('active', 'trialing')
         AND (
           ti.last_sync_at IS NULL
           OR ti.last_sync_at < now() - INTERVAL '${STALE_THRESHOLD_HOURS} hours'
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
          `startup_${row.platform_slug}_${row.id}`,
          {
            integrationId: row.id,
            tenantId:      row.tenant_id,
            platformSlug:  row.platform_slug,
            jobType:       'full_sync' as const,
            syncJobDbId,
            planSlug:      row.plan_slug as PlanSlug,
          },
          {
            priority:         getPriority(row.plan_slug),
            attempts:         3,
            backoff:          { type: 'exponential', delay: 10_000 },
            // Deduplicate: als er al een startup-job voor deze integratie in de queue zit, skip
            jobId:            `startup_${row.id}`,
            removeOnComplete: 50,
            removeOnFail:     25,
          }
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
    // Startup sync is niet kritiek — server moet gewoon opstarten
    logger.error('startup.sync.fatal', { error: (err as Error).message });
  }
}

// ── Incrementele sync scheduler ───────────────────────────────
async function runIncrementalSyncs(): Promise<void> {
  let offset = 0;
  let total  = 0;

  while (true) {
    const rows = await db.query<{
      id: string; tenant_id: string; platform_slug: string; plan_slug: string;
    }>(
      `SELECT ti.id, ti.tenant_id, ti.platform_slug,
              COALESCE(p.slug, 'starter') AS plan_slug
       FROM tenant_integrations ti
       JOIN tenant_subscriptions ts ON ts.tenant_id = ti.tenant_id
       JOIN plans p ON p.id = ts.plan_id
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
          `incremental_${row.platform_slug}_${row.id}`,
          {
            integrationId: row.id,
            tenantId:      row.tenant_id,
            platformSlug:  row.platform_slug,
            jobType:       'incremental' as const,
            syncJobDbId,
            planSlug:      row.plan_slug as PlanSlug,
          },
          {
            priority: getPriority(row.plan_slug),
            attempts: 3,
            backoff:  { type: 'exponential', delay: 10_000 },
            // Voorkom dubbele incrementele jobs per integratie per tijdsvenster
            jobId:            `incremental_${row.id}_${Math.floor(Date.now() / INCREMENTAL_INTERVAL_MS)}`,
            removeOnComplete: 100,
            removeOnFail:     50,
          }
        );

        // Zet next_sync_at direct zodat we geen dubbele jobs maken
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
    await new Promise(r => setTimeout(r, 100)); // kleine pauze tussen batches
  }

  if (total > 0) {
    logger.info('scheduler.incremental.complete', { total });
  }
}

// Ruim stale jobs op die vastgelopen zijn
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

// ── Start de scheduler als in-process loop ────────────────────
export function startSyncScheduler(): void {
  logger.info('sync.scheduler.starting', { intervalMinutes: INCREMENTAL_INTERVAL_MS / 60_000 });

  // Direct eerste run
  runIncrementalSyncs().catch(err =>
    logger.error('scheduler.run.error', { error: err.message })
  );
  cleanupStaleJobs().catch(() => {});

  // Daarna elke 15 minuten
  setInterval(() => {
    runIncrementalSyncs().catch(err =>
      logger.error('scheduler.run.error', { error: err.message })
    );
    cleanupStaleJobs().catch(() => {});
  }, INCREMENTAL_INTERVAL_MS);

  logger.info('sync.scheduler.started');
}
