// ============================================================
// src/modules/briefings/repository/briefings.repository.ts
//
// Datalaag voor tenant_briefings. Cross-tenant calls via
// allowNoTenant: true want briefings worden zowel door
// request-scoped routes (/api/ai/insights) als door
// background workers (email cron, Day Zero) gelezen.
//
// briefing_date wordt altijd als string (YYYY-MM-DD) ingelezen
// via ::text cast om Date-object timezone glitches te voorkomen.
// ============================================================

import { db } from '../../../infrastructure/database/connection';
import { logger } from '../../../shared/logging/logger';
import { BriefingRow, UpsertBriefingInput } from '../types/briefings.types';

class BriefingsRepository {

  // --------------------------------------------------------------
  // Reads
  // --------------------------------------------------------------

  async getForDate(tenantId: string, briefingDate: string): Promise<BriefingRow | null> {
    const result = await db.query<BriefingRow>(
      `SELECT id, tenant_id,
              briefing_date::text AS briefing_date,
              briefing_text, actions, alerts, model,
              input_tokens, output_tokens, memories_used,
              generated_via, created_at, updated_at
       FROM tenant_briefings
       WHERE tenant_id = $1 AND briefing_date = $2::date
       LIMIT 1`,
      [tenantId, briefingDate],
      { allowNoTenant: true },
    );
    return result.rows[0] ?? null;
  }

  async getLatest(tenantId: string): Promise<BriefingRow | null> {
    const result = await db.query<BriefingRow>(
      `SELECT id, tenant_id,
              briefing_date::text AS briefing_date,
              briefing_text, actions, alerts, model,
              input_tokens, output_tokens, memories_used,
              generated_via, created_at, updated_at
       FROM tenant_briefings
       WHERE tenant_id = $1
       ORDER BY briefing_date DESC, created_at DESC
       LIMIT 1`,
      [tenantId],
      { allowNoTenant: true },
    );
    return result.rows[0] ?? null;
  }

  async listRecent(tenantId: string, limit: number = 30): Promise<BriefingRow[]> {
    const safeLimit = Math.max(1, Math.min(90, Math.floor(limit)));
    const result = await db.query<BriefingRow>(
      `SELECT id, tenant_id,
              briefing_date::text AS briefing_date,
              briefing_text, actions, alerts, model,
              input_tokens, output_tokens, memories_used,
              generated_via, created_at, updated_at
       FROM tenant_briefings
       WHERE tenant_id = $1
       ORDER BY briefing_date DESC
       LIMIT $2`,
      [tenantId, safeLimit],
      { allowNoTenant: true },
    );
    return result.rows;
  }

  // --------------------------------------------------------------
  // Mutations
  // --------------------------------------------------------------

  async upsert(input: UpsertBriefingInput): Promise<void> {
    await db.query(
      `INSERT INTO tenant_briefings (
         tenant_id, briefing_date, briefing_text,
         actions, alerts, model,
         input_tokens, output_tokens, memories_used,
         generated_via
       ) VALUES (
         $1, $2::date, $3,
         $4::jsonb, $5::jsonb, $6,
         $7, $8, $9,
         $10
       )
       ON CONFLICT (tenant_id, briefing_date) DO UPDATE SET
         briefing_text = EXCLUDED.briefing_text,
         actions       = EXCLUDED.actions,
         alerts        = EXCLUDED.alerts,
         model         = EXCLUDED.model,
         input_tokens  = EXCLUDED.input_tokens,
         output_tokens = EXCLUDED.output_tokens,
         memories_used = EXCLUDED.memories_used,
         generated_via = EXCLUDED.generated_via,
         updated_at    = now()`,
      [
        input.tenantId,
        input.briefingDate,
        input.briefingText,
        JSON.stringify(input.actions),
        JSON.stringify(input.alerts),
        input.model,
        input.inputTokens,
        input.outputTokens,
        input.memoriesUsed,
        input.generatedVia,
      ],
      { allowNoTenant: true },
    );

    logger.info('briefings.upsert.complete', {
      tenantId: input.tenantId,
      date:     input.briefingDate,
      via:      input.generatedVia,
      tokens:   input.inputTokens + input.outputTokens,
      memories: input.memoriesUsed,
    });
  }
}

export const briefingsRepository = new BriefingsRepository();
