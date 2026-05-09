// ============================================================
// src/modules/ai-memory/services/embedding.service.ts
//
// Voyage AI embedding service.
//   API:    https://docs.voyageai.com/reference/embeddings-api
//   Model:  voyage-3.5-lite
//   Dim:    1024 (Matryoshka, expliciet meegegeven via output_dimension)
//   Cost:   $0.02 per 1M tokens
//
// Belangrijke noot: voyage-3-lite (zonder .5) ondersteunt MAX 512 dim.
// Alleen voyage-3.5-lite, voyage-3.5, voyage-3-large, voyage-4* en
// voyage-code-3 ondersteunen 1024 dim. Onze ai_memories tabel is
// VECTOR(1024), dus kies een model uit die lijst.
//
// input_type 'document' voor opslag, 'query' voor zoekopdrachten.
//
// Env vars:
//   VOYAGE_API_KEY (required) - aan te maken op voyageai.com
// ============================================================

import { logger } from '../../../shared/logging/logger';

const VOYAGE_ENDPOINT = 'https://api.voyageai.com/v1/embeddings';
const VOYAGE_MODEL    = 'voyage-3.5-lite';
const VOYAGE_DIM      = 1024;
const MAX_BATCH_SIZE  = 128;        // Voyage hard limit per request
const TIMEOUT_MS      = 30_000;

export type EmbeddingInputType = 'document' | 'query';

interface VoyageResponse {
  object: 'list';
  data:   Array<{
    object:    'embedding';
    embedding: number[];
    index:     number;
  }>;
  model: string;
  usage: { total_tokens: number };
}

class EmbeddingService {

  private get apiKey(): string {
    const key = process.env.VOYAGE_API_KEY;
    if (!key) {
      throw new Error('VOYAGE_API_KEY ontbreekt in env. Geen embeddings mogelijk.');
    }
    return key;
  }

  /**
   * Embed een batch teksten. Splitst automatisch in batches van 128.
   * Retourneert embeddings in dezelfde volgorde als de input.
   *
   * @param texts     Array van strings om te embedden (lege strings worden geskipt)
   * @param inputType 'document' bij opslag, 'query' bij retrieval
   */
  async embed(texts: string[], inputType: EmbeddingInputType = 'document'): Promise<number[][]> {
    if (!Array.isArray(texts) || texts.length === 0) return [];

    const cleaned = texts
      .map(t => (typeof t === 'string' ? t.trim() : ''))
      .filter(t => t.length > 0);

    if (cleaned.length === 0) return [];

    const results: number[][] = [];

    for (let i = 0; i < cleaned.length; i += MAX_BATCH_SIZE) {
      const batch   = cleaned.slice(i, i + MAX_BATCH_SIZE);
      const vectors = await this.callVoyage(batch, inputType);
      results.push(...vectors);
    }

    return results;
  }

  /**
   * Convenience voor de single-query case (gebruikt door memory injection).
   */
  async embedQuery(text: string): Promise<number[]> {
    const [vec] = await this.embed([text], 'query');
    if (!vec || vec.length !== VOYAGE_DIM) {
      throw new Error(
        `Voyage retourneerde geen geldige query embedding (dim=${vec?.length ?? 0}, expected=${VOYAGE_DIM})`,
      );
    }
    return vec;
  }

  // ── Internal ──────────────────────────────────────────────

  private async callVoyage(input: string[], inputType: EmbeddingInputType): Promise<number[][]> {
    const startedAt  = Date.now();
    const controller = new AbortController();
    const timeout    = setTimeout(() => controller.abort(), TIMEOUT_MS);

    let res: Response;
    try {
      res = await fetch(VOYAGE_ENDPOINT, {
        method:  'POST',
        headers: {
          'Authorization': 'Bearer ' + this.apiKey,
          'Content-Type':  'application/json',
        },
        body: JSON.stringify({
          input,
          model:            VOYAGE_MODEL,
          input_type:       inputType,
          output_dimension: VOYAGE_DIM,
        }),
        signal: controller.signal,
      });
    } catch (err: any) {
      logger.error('voyage.embed.network_error', {
        error:     err?.message ?? 'unknown',
        batch:     input.length,
        inputType,
      });
      throw new Error('Voyage API onbereikbaar: ' + (err?.message ?? 'unknown'));
    } finally {
      clearTimeout(timeout);
    }

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      logger.error('voyage.embed.http_error', {
        status:    res.status,
        bodySnip:  body.slice(0, 300),
        batch:     input.length,
        inputType,
      });
      throw new Error('Voyage API error (' + res.status + '): ' + body.slice(0, 200));
    }

    const json = (await res.json()) as VoyageResponse;

    if (!Array.isArray(json.data) || json.data.length !== input.length) {
      throw new Error(
        'Voyage response mismatch: expected ' + input.length + ' embeddings, got ' + (json.data?.length ?? 0),
      );
    }

    // Defensief sorteren op index, hoewel volgorde meestal al correct is
    const sorted  = [...json.data].sort((a, b) => a.index - b.index);
    const vectors = sorted.map(d => d.embedding);

    // Hard validation: alle vectors moeten exact VOYAGE_DIM lang zijn
    for (let i = 0; i < vectors.length; i++) {
      if (!Array.isArray(vectors[i]) || vectors[i].length !== VOYAGE_DIM) {
        throw new Error(
          `Voyage embedding ${i} heeft verkeerde dim: ${vectors[i]?.length ?? 0}, expected ${VOYAGE_DIM}. ` +
          `Model ${VOYAGE_MODEL} ondersteunt deze dim mogelijk niet.`,
        );
      }
    }

    logger.info('voyage.embed.success', {
      batch:      input.length,
      inputType,
      tokens:     json.usage?.total_tokens ?? 0,
      durationMs: Date.now() - startedAt,
    });

    return vectors;
  }
}

export const embeddingService = new EmbeddingService();

// Constants voor migration / repository validatie
export const EMBEDDING_DIMENSION = VOYAGE_DIM;
export const EMBEDDING_MODEL     = VOYAGE_MODEL;
