// ============================================================
// src/modules/day-zero/repository/day-zero.repository.ts
//
// DB access voor tenant_day_zero_progress.
// Gebruikt db van infrastructure/database/connection (zoals sync.worker.ts).
// Workers draaien zonder tenant context, dus { allowNoTenant: true } overal.
// ============================================================

import { db } from '../../../infrastructure/database/connection';
import { logger } from '../../../shared/logging/logger';
import {
  DayZeroProgressRow,
  DayZeroStage,
  DayZeroStageData,
} from '../types/day-zero.types';

export class DayZeroRepository {

  // --------------------------------------------------------------
  // Lookups
  // --------------------------------------------------------------

  async getByTenantId(tenantId: string): Promise<DayZeroProgressRow | null> {
    const result = await db.query<DayZeroProgressRow>(
      `SELECT
         tenant_id, status, current_stage, stage_data,
         error_message, error_stage, error_count,
         started_at, completed_at, created_at, updated_at
       FROM tenant_day_zero_progress
       WHERE tenant_id = $1`,
      [tenantId],
      { allowNoTenant: true }
    );

    return result.rows[0] ?? null;
  }

  // --------------------------------------------------------------
  // Mutations
  // --------------------------------------------------------------

  /**
   * Idempotent create. Als er al een rij is, wordt niets gedaan
   * en de bestaande rij teruggegeven. Voorkomt race conditions
   * bij dubbel-trigger van /api/onboarding/complete.
   */
  async createIfNotExists(tenantId: string): Promise<DayZeroProgressRow> {
    const result = await db.query<DayZeroProgressRow>(
      `INSERT INTO tenant_day_zero_progress (tenant_id, status, current_stage, stage_data)
       VALUES ($1, 'pending', 0, '{}'::jsonb)
       ON CONFLICT (tenant_id) DO UPDATE
         SET tenant_id = tenant_day_zero_progress.tenant_id
       RETURNING
         tenant_id, status, current_stage, stage_data,
         error_message, error_stage, error_count,
         started_at, completed_at, created_at, updated_at`,
      [tenantId],
      { allowNoTenant: true }
    );

    return result.rows[0];
  }

  async markRunning(tenantId: string, stage: DayZeroStage): Promise<void> {
    await db.query(
      `UPDATE tenant_day_zero_progress
       SET status        = 'running',
           current_stage = $2,
           started_at    = COALESCE(started_at, now()),
           error_message = NULL,
           error_stage   = NULL
       WHERE tenant_id = $1`,
      [tenantId, stage],
      { allowNoTenant: true }
    );
  }

  /**
   * Merge nieuwe stage output in stage_data JSONB en update current_stage.
   * Gebruikt jsonb || voor merge zodat bestaande stages behouden blijven.
   */
  async updateStage(
    tenantId: string,
    stage:    DayZeroStage,
    output:   DayZeroStageData,
  ): Promise<void> {
    await db.query(
      `UPDATE tenant_day_zero_progress
       SET current_stage = $2,
           stage_data    = stage_data || $3::jsonb
       WHERE tenant_id = $1`,
      [tenantId, stage, JSON.stringify(output)],
      { allowNoTenant: true }
    );
  }

  async markCompleted(tenantId: string): Promise<void> {
    await db.query(
      `UPDATE tenant_day_zero_progress
       SET status        = 'completed',
           current_stage = 5,
           completed_at  = now()
       WHERE tenant_id = $1`,
      [tenantId],
      { allowNoTenant: true }
    );
  }

  async markFailed(
    tenantId: string,
    stage:    DayZeroStage,
    message:  string,
  ): Promise<void> {
    await db.query(
      `UPDATE tenant_day_zero_progress
       SET status        = 'failed',
           error_stage   = $2,
           error_message = LEFT($3, 500),
           error_count   = error_count + 1
       WHERE tenant_id = $1`,
      [tenantId, stage, message],
      { allowNoTenant: true }
    );

    logger.warn('day_zero.repo.marked_failed', { tenantId, stage, message });
  }
}

export const dayZeroRepository = new DayZeroRepository();
