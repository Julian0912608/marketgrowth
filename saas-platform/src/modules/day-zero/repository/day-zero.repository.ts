// ============================================================
// src/modules/day-zero/repository/day-zero.repository.ts
//
// DB access voor tenant_day_zero_progress.
// Gebruikt service role client (workers schrijven hier in BullMQ context,
// dus geen tenant context via AsyncLocalStorage beschikbaar).
// ============================================================

import { supabaseAdmin } from '../../../shared/database/supabase';
import { logger } from '../../../shared/logging/logger';
import {
  DayZeroProgressRow,
  DayZeroStage,
  DayZeroStageData,
  DayZeroStatus,
} from '../types/day-zero.types';

export class DayZeroRepository {
  // --------------------------------------------------------------
  // Lookups
  // --------------------------------------------------------------

  async getByTenantId(tenantId: string): Promise<DayZeroProgressRow | null> {
    const { data, error } = await supabaseAdmin
      .from('tenant_day_zero_progress')
      .select('*')
      .eq('tenant_id', tenantId)
      .maybeSingle();

    if (error) {
      logger.error('day_zero.repo.get.failed', { tenantId, error: error.message });
      throw error;
    }

    return data as DayZeroProgressRow | null;
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
    const existing = await this.getByTenantId(tenantId);
    if (existing) return existing;

    const { data, error } = await supabaseAdmin
      .from('tenant_day_zero_progress')
      .insert({
        tenant_id:     tenantId,
        status:        'pending',
        current_stage: 0,
        stage_data:    {},
      })
      .select('*')
      .single();

    if (error) {
      // Als een andere request net heeft ingevoegd, fallback naar lookup.
      if (error.code === '23505') {
        const row = await this.getByTenantId(tenantId);
        if (row) return row;
      }
      logger.error('day_zero.repo.create.failed', { tenantId, error: error.message });
      throw error;
    }

    return data as DayZeroProgressRow;
  }

  async markRunning(tenantId: string, stage: DayZeroStage): Promise<void> {
    const { error } = await supabaseAdmin
      .from('tenant_day_zero_progress')
      .update({
        status:        'running',
        current_stage: stage,
        started_at:    new Date().toISOString(),
        error_message: null,
        error_stage:   null,
      })
      .eq('tenant_id', tenantId);

    if (error) throw error;
  }

  async updateStage(
    tenantId: string,
    stage:    DayZeroStage,
    output:   DayZeroStageData,
  ): Promise<void> {
    const current = await this.getByTenantId(tenantId);
    if (!current) throw new Error(`Day Zero row missing for tenant ${tenantId}`);

    const merged = { ...current.stage_data, ...output };

    const { error } = await supabaseAdmin
      .from('tenant_day_zero_progress')
      .update({
        current_stage: stage,
        stage_data:    merged,
      })
      .eq('tenant_id', tenantId);

    if (error) throw error;
  }

  async markCompleted(tenantId: string): Promise<void> {
    const { error } = await supabaseAdmin
      .from('tenant_day_zero_progress')
      .update({
        status:        'completed',
        current_stage: 5,
        completed_at:  new Date().toISOString(),
      })
      .eq('tenant_id', tenantId);

    if (error) throw error;
  }

  async markFailed(
    tenantId: string,
    stage:    DayZeroStage,
    message:  string,
  ): Promise<void> {
    const { error } = await supabaseAdmin
      .from('tenant_day_zero_progress')
      .update({
        status:        'failed',
        error_stage:   stage,
        error_message: message.slice(0, 500),
      })
      .eq('tenant_id', tenantId);

    if (error) throw error;

    // error_count atomair ophogen via RPC of separate call
    await supabaseAdmin.rpc('increment_day_zero_error_count', { p_tenant_id: tenantId })
      .then(() => null)
      .catch(() => {
        // RPC bestaat nog niet, fallback: read-modify-write
        return this.bumpErrorCount(tenantId);
      });
  }

  private async bumpErrorCount(tenantId: string): Promise<void> {
    const row = await this.getByTenantId(tenantId);
    if (!row) return;
    await supabaseAdmin
      .from('tenant_day_zero_progress')
      .update({ error_count: row.error_count + 1 })
      .eq('tenant_id', tenantId);
  }
}

export const dayZeroRepository = new DayZeroRepository();
