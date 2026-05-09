// ============================================================
// src/modules/ai-memory/repository/ai-memories.repository.ts
//
// Datalaag voor ai_memories.
//
// Cross-tenant calls (Day Zero worker) gebruiken { allowNoTenant: true }.
// Request-scoped calls (memory injection vanuit /api/ai/insights)
// kunnen ook allowNoTenant: true draaien want WHERE tenant_id = $1
// is altijd expliciet aanwezig (defense in depth bovenop RLS).
// ============================================================

import { db } from '../../../infrastructure/database/connection';
import { logger } from '../../../shared/logging/logger';
import {
  AiMemoryInput,
  AiMemoryRow,
  MemoryKind,
  MemorySearchResult,
} from '../types/ai-memory.types';

class AiMemoriesRepository {

  /**
   * Bulk insert van memories met embedding.
   * Caller is verantwoordelijk voor de-dupe (Stage 5 wist eerst alle
   * Day Zero kinds via deleteByTenantAndKinds).
   *
   * Per-row INSERT is acceptabel op deze schaal (max ~15 records per
   * Day Zero). Voor V1 briefing-tracking kan dit naar UNNEST batch.
   */
  async insertMany(items: Array<AiMemoryInput & { embedding: number[] }>): Promise<void> {
    if (items.length === 0) return;

    for (const item of items) {
      if (!Array.isArray(item.embedding) || item.embedding.length === 0) {
        logger.warn('ai_memories.insert.skip_empty_embedding', {
          tenantId: item.tenantId,
          kind:     item.kind,
        });
        continue;
      }

      const vectorLiteral = '[' + item.embedding.join(',') + ']';

      await db.query(
        `INSERT INTO ai_memories (
           tenant_id, kind, content, embedding, metadata, source_ref
         ) VALUES ($1, $2, $3, $4::vector, $5::jsonb, $6)`,
        [
          item.tenantId,
          item.kind,
          item.content,
          vectorLiteral,
          JSON.stringify(item.metadata ?? {}),
          item.sourceRef ?? null,
        ],
        { allowNoTenant: true },
      );
    }

    logger.info('ai_memories.insert.complete', {
      tenantId: items[0]?.tenantId,
      count:    items.length,
    });
  }

  /**
   * Wist alle memories voor een tenant met de gegeven kinds.
   * Gebruikt door Stage 5 voor idempotente re-runs.
   */
  async deleteByTenantAndKinds(tenantId: string, kinds: MemoryKind[]): Promise<number> {
    if (!kinds || kinds.length === 0) return 0;

    const result = await db.query(
      `DELETE FROM ai_memories
       WHERE tenant_id = $1
         AND kind = ANY($2::text[])`,
      [tenantId, kinds],
      { allowNoTenant: true },
    );

    logger.info('ai_memories.delete.complete', {
      tenantId,
      kinds,
      deleted: result.rowCount ?? 0,
    });

    return result.rowCount ?? 0;
  }

  /**
   * Top-K cosine similarity zoekopdracht voor memory injection.
   *
   * pgvector cosine distance operator: <=>
   * Similarity wordt afgeleid als (1 - cosine_distance), hoger = relevanter.
   *
   * Tenant scoping via WHERE tenant_id = $2 (defense in depth bovenop RLS).
   */
  async searchTopK(
    tenantId:       string,
    queryEmbedding: number[],
    k:              number = 7,
    options?:       { allowNoTenant?: boolean },
  ): Promise<MemorySearchResult[]> {
    if (!Array.isArray(queryEmbedding) || queryEmbedding.length === 0) {
      throw new Error('searchTopK: queryEmbedding mag niet leeg zijn');
    }

    const vectorLiteral = '[' + queryEmbedding.join(',') + ']';
    const safeK         = Math.max(1, Math.min(50, Math.floor(k)));

    const result = await db.query<{
      id:         string;
      kind:       MemoryKind;
      content:    string;
      metadata:   Record<string, unknown>;
      source_ref: string | null;
      similarity: string;
    }>(
      `SELECT id, kind, content, metadata, source_ref,
              (1 - (embedding <=> $1::vector))::float8 AS similarity
       FROM ai_memories
       WHERE tenant_id = $2
       ORDER BY embedding <=> $1::vector ASC
       LIMIT $3`,
      [vectorLiteral, tenantId, safeK],
      options?.allowNoTenant ? { allowNoTenant: true } : undefined,
    );

    return result.rows.map(r => ({
      id:         r.id,
      kind:       r.kind,
      content:    r.content,
      metadata:   r.metadata ?? {},
      source_ref: r.source_ref,
      similarity: typeof r.similarity === 'number'
        ? r.similarity
        : parseFloat(r.similarity as unknown as string),
    }));
  }

  /**
   * Admin / debugging: alle memories voor een tenant, recent eerst.
   */
  async listByTenant(tenantId: string, limit: number = 100): Promise<AiMemoryRow[]> {
    const result = await db.query<AiMemoryRow>(
      `SELECT id, tenant_id, kind, content, metadata, source_ref, created_at, updated_at
       FROM ai_memories
       WHERE tenant_id = $1
       ORDER BY created_at DESC
       LIMIT $2`,
      [tenantId, limit],
      { allowNoTenant: true },
    );
    return result.rows;
  }

  /**
   * Sanity check na Stage 5: aantallen per kind.
   */
  async countByKind(tenantId: string): Promise<Record<string, number>> {
    const result = await db.query<{ kind: string; cnt: string }>(
      `SELECT kind, COUNT(*)::text AS cnt
       FROM ai_memories
       WHERE tenant_id = $1
       GROUP BY kind`,
      [tenantId],
      { allowNoTenant: true },
    );

    const out: Record<string, number> = {};
    for (const r of result.rows) {
      out[r.kind] = parseInt(r.cnt, 10);
    }
    return out;
  }
}

export const aiMemoriesRepository = new AiMemoriesRepository();
