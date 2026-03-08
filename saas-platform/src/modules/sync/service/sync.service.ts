// ============================================================
// src/modules/sync/service/sync.service.ts
// ============================================================

import { getConnector }  from '../../integrations/connectors/connector.factory';
import { PlatformSlug }  from '../../integrations/types/integration.types';
import { syncQueue }     from '../../integrations/workers/sync.worker';
import { logger }        from '../../../shared/logging/logger';
import { db }            from '../../../infrastructure/database/connection';
import { getTenantContext } from '../../../shared/middleware/tenant-context';
import { v4 as uuidv4 }  from 'uuid';

export class SyncService {

  async triggerSync(integrationId: string, jobType: 'full_sync' | 'incremental' = 'incremental'): Promise<{ syncJobId: string }> {
    const { tenantId } = getTenantContext();

    // Haal integratie op
    const result = await db.query(
      `SELECT ti.id, ti.platform_slug, ti.status
       FROM tenant_integrations ti
       WHERE ti.id = $1 AND ti.tenant_id = $2`,
      [integrationId, tenantId]
    );

    if (!result.rows[0]) {
      throw new Error('Integratie niet gevonden');
    }

    const integration   = result.rows[0];
    const platformSlug  = integration.platform_slug as PlatformSlug;

    // Maak sync job record aan in database
    const syncJobId = uuidv4();
    await db.query(
      `INSERT INTO integration_sync_jobs (id, integration_id, tenant_id, job_type, status, created_at)
       VALUES ($1, $2, $3, $4, 'queued', now())`,
      [syncJobId, integrationId, tenantId, jobType],
      { allowNoTenant: true }
    );

    // Zet job op de queue
    await syncQueue.add(
      `sync:${platformSlug}:${integrationId}`,
      {
        integrationId,
        tenantId,
        platformSlug,
        jobType,
        syncJobDbId: syncJobId,
      },
      {
        attempts:  3,
        backoff: { type: 'exponential', delay: 5000 },
        removeOnComplete: 100,
        removeOnFail:     50,
      }
    );

    logger.info('sync.triggered', { tenantId, integrationId, platformSlug, jobType, syncJobId });

    return { syncJobId };
  }

  async getSyncStatus(integrationId: string): Promise<{
    lastSyncAt:   Date | null;
    nextSyncAt:   Date | null;
    status:       string;
    errorMessage: string | null;
    recentJobs:   Array<{ id: string; jobType: string; status: string; orderssynced: number; startedAt: Date; completedAt: Date }>;
  }> {
    const { tenantId } = getTenantContext();

    const integration = await db.query(
      `SELECT last_sync_at, next_sync_at, status, error_message
       FROM tenant_integrations
       WHERE id = $1 AND tenant_id = $2`,
      [integrationId, tenantId]
    );

    if (!integration.rows[0]) throw new Error('Integratie niet gevonden');

    const jobs = await db.query(
      `SELECT id, job_type, status, orders_synced, started_at, completed_at
       FROM integration_sync_jobs
       WHERE integration_id = $1
       ORDER BY created_at DESC
       LIMIT 5`,
      [integrationId],
      { allowNoTenant: true }
    );

    const row = integration.rows[0];
    return {
      lastSyncAt:   row.last_sync_at,
      nextSyncAt:   row.next_sync_at,
      status:       row.status,
      errorMessage: row.error_message,
      recentJobs:   jobs.rows,
    };
  }
}
