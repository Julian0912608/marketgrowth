// saas-platform/src/modules/integrations/workers/sync.scheduler.ts
//
// PR 2 UPDATE: Meta Ads sync toegevoegd aan scheduler.
// Draait elk uur parallel aan Bol.com Ads sync.

import { db }        from '../../../infrastructure/database/connection';
import { logger }    from '../../../shared/logging/logger';
import { syncQueue } from './sync.worker';
import { syncBolcomAdvertisingData } from '../connectors/bolcom-advertising.connector';
import { syncMetaAdsData }           from '../connectors/meta-ads-sync';
import { decryptToken } from '../../../shared/crypto/token-encryption';
import { PlatformSlug, IntegrationCredentials } from '../types/integration.types';

const SCHEDULER_INTERVAL_MS = 15 * 60 * 1000; // 15 minuten
const ADV_INTERVAL_MS       = 60 * 60 * 1000; // 1 uur voor advertising
const BATCH_SIZE             = 100;

// ── Reguliere order/product sync ─────────────────────────────
async function scheduleIncrementalSyncs(): Promise<void> {
  const startTime = Date.now();
  let offset = 0;
  let totalScheduled = 0;

  logger.info('scheduler.run.start', { timestamp: new Date().toISOString() });

  while (true) {
    const rows = await db.query(
      `SELECT ti.id, ti.tenant_id, ti.platform_slug
       FROM tenant_integrations ti
       JOIN tenant_subscriptions ts ON ts.tenant_id = ti.tenant_id
       WHERE ti.status = 'active'
         AND ti.platform_slug NOT IN ('bolcom_ads', 'meta_ads', 'google_ads')
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
        const dbResult = await db.query(
          `INSERT INTO integration_sync_jobs (integration_id, tenant_id, job_type, status)
           VALUES ($1, $2, 'incremental', 'queued')
           RETURNING id`,
          [row.id, row.tenant_id],
          { allowNoTenant: true }
        );
        const syncJobDbId = dbResult.rows[0].id;

        await syncQueue.add(
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
            jobId: `incremental:${row.id}:${Math.floor(Date.now() / SCHEDULER_INTERVAL_MS)}`,
          }
        );

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
          tenantId:      row.tenant_id,
          error:         (err as Error).message,
        });
      }
    }

    offset += BATCH_SIZE;
    if (rows.rows.length === BATCH_SIZE) {
      await new Promise(r => setTimeout(r, 100));
    }
  }

  logger.info('scheduler.run.complete', {
    totalScheduled,
    durationMs: Date.now() - startTime,
  });
}

// ── Bol.com Advertising sync (elk uur) ───────────────────────
async function scheduleBolcomAdvertisingSync(): Promise<void> {
  logger.info('scheduler.bolcom_ads.start', { timestamp: new Date().toISOString() });

  let totalSynced = 0;

  try {
    const rows = await db.query(
      `SELECT ti.id AS integration_id, ti.tenant_id,
              ic.api_key, ic.api_secret
       FROM tenant_integrations ti
       JOIN integration_credentials ic ON ic.integration_id = ti.id
       JOIN tenant_subscriptions ts    ON ts.tenant_id = ti.tenant_id
       WHERE ti.platform_slug = 'bolcom_ads'
         AND ti.status = 'active'
         AND ts.status IN ('active', 'trialing')
         AND (ti.next_sync_at IS NULL OR ti.next_sync_at <= now())
       ORDER BY ti.next_sync_at ASC NULLS FIRST
       LIMIT $1`,
      [BATCH_SIZE],
      { allowNoTenant: true }
    );

    for (const row of rows.rows) {
      try {
        const clientId     = decryptToken(row.api_key)    ?? '';
        const clientSecret = decryptToken(row.api_secret) ?? '';

        if (!clientId || !clientSecret) {
          logger.warn('scheduler.bolcom_ads.missing_credentials', {
            integrationId: row.integration_id,
            tenantId:      row.tenant_id,
          });
          continue;
        }

        const encoded  = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
        const tokenRes = await fetch('https://login.bol.com/token?grant_type=client_credentials', {
          method:  'POST',
          headers: {
            'Authorization': `Basic ${encoded}`,
            'Content-Type':  'application/x-www-form-urlencoded',
          },
        });

        if (!tokenRes.ok) {
          logger.warn('scheduler.bolcom_ads.token_failed', {
            integrationId: row.integration_id,
            tenantId:      row.tenant_id,
            status:        tokenRes.status,
          });
          continue;
        }

        const { access_token } = await tokenRes.json() as { access_token: string };

        const creds: IntegrationCredentials = {
          integrationId: row.integration_id,
          platform:      'bolcom',
          apiKey:        clientId,
          apiSecret:     clientSecret,
        };

        const result = await syncBolcomAdvertisingData(creds, row.tenant_id, access_token);

        await db.query(
          `UPDATE tenant_integrations
           SET next_sync_at = now() + INTERVAL '1 hour',
               last_sync_at = now(),
               updated_at   = now()
           WHERE id = $1`,
          [row.integration_id],
          { allowNoTenant: true }
        );

        if (result.hasAccess) totalSynced++;

        logger.info('scheduler.bolcom_ads.synced', {
          tenantId:      row.tenant_id,
          integrationId: row.integration_id,
          hasAccess:     result.hasAccess,
          campaigns:     result.campaignCount,
        });

      } catch (err) {
        logger.error('scheduler.bolcom_ads.error', {
          integrationId: row.integration_id,
          tenantId:      row.tenant_id,
          error:         (err as Error).message,
        });
      }
    }
  } catch (err) {
    logger.error('scheduler.bolcom_ads.fatal', { error: (err as Error).message });
  }

  logger.info('scheduler.bolcom_ads.complete', { totalSynced });
}

// ── Meta Ads sync (elk uur) — PR 2 ───────────────────────────
async function scheduleMetaAdsSync(): Promise<void> {
  logger.info('scheduler.meta_ads.start', { timestamp: new Date().toISOString() });

  let totalSynced     = 0;
  let totalCampaigns  = 0;
  let totalSpend      = 0;

  try {
    const rows = await db.query<{
      integration_id: string;
      tenant_id:      string;
    }>(
      `SELECT ti.id AS integration_id, ti.tenant_id
       FROM tenant_integrations ti
       JOIN tenant_subscriptions ts ON ts.tenant_id = ti.tenant_id
       WHERE ti.platform_slug = 'meta_ads'
         AND ti.status = 'active'
         AND ts.status IN ('active', 'trialing')
         AND (ti.next_sync_at IS NULL OR ti.next_sync_at <= now())
       ORDER BY ti.next_sync_at ASC NULLS FIRST
       LIMIT $1`,
      [BATCH_SIZE],
      { allowNoTenant: true }
    );

    for (const row of rows.rows) {
      try {
        const result = await syncMetaAdsData(row.integration_id, row.tenant_id);

        if (result.hasAccess) {
          totalSynced++;
          totalCampaigns += result.campaignsCount;
          totalSpend     += result.totalSpend;
        } else {
          // Bij no-access markeer integratie als error zodat dashboard het toont
          await db.query(
            `UPDATE tenant_integrations
             SET status        = 'error',
                 error_message = $2,
                 updated_at    = now()
             WHERE id = $1`,
            [row.integration_id, result.errorMessage || 'Meta Ads sync zonder toegang'],
            { allowNoTenant: true }
          );
        }

        // syncMetaAdsData zelf zet next_sync_at al

        logger.info('scheduler.meta_ads.synced', {
          tenantId:      row.tenant_id,
          integrationId: row.integration_id,
          hasAccess:     result.hasAccess,
          campaigns:     result.campaignsCount,
          spend:         result.totalSpend,
        });

      } catch (err) {
        logger.error('scheduler.meta_ads.error', {
          integrationId: row.integration_id,
          tenantId:      row.tenant_id,
          error:         (err as Error).message,
        });

        // Bij sync-fout: zet next_sync_at vooruit zodat we niet vastlopen op dezelfde rij
        await db.query(
          `UPDATE tenant_integrations
           SET next_sync_at = now() + INTERVAL '1 hour',
               error_message = $2,
               updated_at   = now()
           WHERE id = $1`,
          [row.integration_id, (err as Error).message.slice(0, 500)],
          { allowNoTenant: true }
        );
      }
    }
  } catch (err) {
    logger.error('scheduler.meta_ads.fatal', { error: (err as Error).message });
  }

  logger.info('scheduler.meta_ads.complete', {
    totalSynced,
    totalCampaigns,
    totalSpend,
  });
}

// ── Stale job cleanup ─────────────────────────────────────────
async function cleanupStaleJobs(): Promise<void> {
  const result = await db.query(
    `UPDATE integration_sync_jobs
     SET status        = 'failed',
         error_message = 'Job timeout — automatisch hersteld door scheduler',
         completed_at  = now()
     WHERE status = 'running'
       AND started_at < now() - INTERVAL '30 minutes'
     RETURNING id, integration_id`,
    [],
    { allowNoTenant: true }
  );

  if (result.rows.length > 0) {
    logger.warn('scheduler.stale_jobs.cleaned', { count: result.rows.length });
    for (const row of result.rows) {
      await db.query(
        `UPDATE tenant_integrations
         SET status     = CASE WHEN error_count >= 5 THEN 'error' ELSE 'active' END,
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
    intervalMinutes:    SCHEDULER_INTERVAL_MS / 60_000,
    advIntervalMinutes: ADV_INTERVAL_MS / 60_000,
    batchSize:          BATCH_SIZE,
  });

  await scheduleIncrementalSyncs();
  await scheduleBolcomAdvertisingSync();
  await scheduleMetaAdsSync();
  await cleanupStaleJobs();

  setInterval(async () => {
    await scheduleIncrementalSyncs();
    await cleanupStaleJobs();
  }, SCHEDULER_INTERVAL_MS);

  setInterval(async () => {
    await scheduleBolcomAdvertisingSync();
    await scheduleMetaAdsSync();
  }, ADV_INTERVAL_MS);
}

main().catch(err => {
  logger.error('sync.scheduler.fatal', { error: err.message });
  process.exit(1);
});
