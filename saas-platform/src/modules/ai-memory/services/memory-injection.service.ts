// ============================================================
// src/modules/ai-memory/services/memory-injection.service.ts
//
// Memory injection helper voor AI surfaces (daily briefing,
// AI chat, weekly opportunity engine in V1).
//
// Architecture Plan §AI Pipeline Layer 1:
//   "Before any model is called, query Supabase pgvector for the
//    top 5 to 10 most relevant memories for the current task."
//
// Workflow:
//   1. Embed query string via Voyage (input_type: 'query')
//   2. Top-K cosine similarity via ai_memories
//   3. Filter op MIN_SIMILARITY floor
//   4. Format als prompt-injectable text block
//
// Graceful degradation: bij embedding- of search-fout retourneert
// de service een lege block. AI surfaces draaien zonder memory
// door (V0 acceptabel, betere UX dan crash).
// ============================================================

import { logger } from '../../../shared/logging/logger';
import { embeddingService } from './embedding.service';
import { aiMemoriesRepository } from '../repository/ai-memories.repository';
import { MemorySearchResult } from '../types/ai-memory.types';

const DEFAULT_K              = 7;
const MIN_SIMILARITY         = 0.30;       // Floor voor irrelevante matches
const MAX_PROMPT_BLOCK_CHARS = 4000;       // Hard ceiling op injected text

export interface MemoryInjectionResult {
  memories:    MemorySearchResult[];
  promptBlock: string;
  metrics: {
    retrieved:   number;
    afterFilter: number;
    truncated:   boolean;
    durationMs:  number;
  };
}

class MemoryInjectionService {

  /**
   * Haal relevante memories op en formatteer als prompt block.
   *
   * @param tenantId  Tenant scope voor de search
   * @param query     Vrije tekst die de huidige task beschrijft
   * @param k         Aantal kandidaat-memories voor de search (default 7)
   */
  async getRelevantMemories(
    tenantId: string,
    query:    string,
    k:        number = DEFAULT_K,
  ): Promise<MemoryInjectionResult> {
    const startedAt = Date.now();

    if (!query || query.trim().length === 0) {
      return this.emptyResult(startedAt);
    }

    // 1. Embed query
    let queryEmbedding: number[];
    try {
      queryEmbedding = await embeddingService.embedQuery(query);
    } catch (err: any) {
      logger.warn('memory_injection.embed_failed', {
        tenantId,
        error: err?.message ?? 'unknown',
      });
      return this.emptyResult(startedAt);
    }

    // 2. Top-K cosine search
    let memories: MemorySearchResult[];
    try {
      memories = await aiMemoriesRepository.searchTopK(
        tenantId,
        queryEmbedding,
        k,
        { allowNoTenant: true },
      );
    } catch (err: any) {
      logger.warn('memory_injection.search_failed', {
        tenantId,
        error: err?.message ?? 'unknown',
      });
      return this.emptyResult(startedAt);
    }

    // 3. Filter op similarity floor
    const filtered = memories.filter(m => m.similarity >= MIN_SIMILARITY);

    // 4. Format als prompt block
    const { block, truncated } = this.formatPromptBlock(filtered);

    const durationMs = Date.now() - startedAt;
    logger.info('memory_injection.complete', {
      tenantId,
      retrieved:   memories.length,
      afterFilter: filtered.length,
      truncated,
      durationMs,
      topKind:     filtered[0]?.kind ?? null,
      topSim:      filtered[0]?.similarity ?? null,
    });

    return {
      memories:    filtered,
      promptBlock: block,
      metrics: {
        retrieved:   memories.length,
        afterFilter: filtered.length,
        truncated,
        durationMs,
      },
    };
  }

  /**
   * Format memories als bullet list met kind-prefix.
   * Truncate als totaal over MAX_PROMPT_BLOCK_CHARS gaat.
   */
  private formatPromptBlock(memories: MemorySearchResult[]): { block: string; truncated: boolean } {
    if (memories.length === 0) return { block: '', truncated: false };

    const header = 'Business memory context (retrieved from your Day Zero baseline plan):';
    const lines: string[] = [header];

    let totalChars = header.length;
    let truncated  = false;

    for (const m of memories) {
      const line = '- [' + m.kind + '] ' + m.content;
      if (totalChars + line.length + 1 > MAX_PROMPT_BLOCK_CHARS) {
        truncated = true;
        break;
      }
      lines.push(line);
      totalChars += line.length + 1;
    }

    return { block: lines.join('\n'), truncated };
  }

  private emptyResult(startedAt: number): MemoryInjectionResult {
    return {
      memories:    [],
      promptBlock: '',
      metrics: {
        retrieved:   0,
        afterFilter: 0,
        truncated:   false,
        durationMs:  Date.now() - startedAt,
      },
    };
  }
}

export const memoryInjectionService = new MemoryInjectionService();
