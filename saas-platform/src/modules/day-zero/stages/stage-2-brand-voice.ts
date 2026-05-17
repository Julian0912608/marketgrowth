// ============================================================
// src/modules/day-zero/stages/stage-2-brand-voice.ts
//
// Stage 2 van Day Zero: brand voice fingerprint via Claude Haiku.
//
// Architecture Plan model assignment:
//   "Brand voice extraction. Pattern matching task. Haiku is sufficient."
//
// FIX 9-mei: model string was 'claude-haiku-3-5-20251022' (typo
// in Architecture Plan v1.0, datum klopt niet). Aangepast naar
// 'claude-haiku-4-5-20251001' (huidige Haiku 4.5, beschikbaar
// via Anthropic API mei 2026).
//
// Bol-only quirk: products kunnen description=NULL hebben.
// Fallback prompt vraagt Haiku om voice af te leiden uit titles,
// product_type, vendor en tags, met confidence='low'.
//
// V0 Gap 3c (17 mei 2026): prompt source_note instructie scherper
// gemaakt. Was: Haiku schreef soms "no titles available" terwijl
// titles wel werden meegegeven (er zijn altijd titles, alleen
// description/type/vendor/tags/price kunnen ontbreken). Nu wordt
// in de prompt expliciet beschreven welke velden wel/niet
// aanwezig zijn, plus de toegestane source_note variants.
//
// Public:
//   runBrandVoiceStage(tenantId): Promise<StageRunResult>
//
// Vangt parse/API errors zelf op met fallback content. Throw't
// alleen bij oncatchable exceptions (DB unreachable etc).
// ============================================================

import { db } from '../../../infrastructure/database/connection';
import { logger } from '../../../shared/logging/logger';
import {
  BrandVoice,
  BrandVoiceStyle,
  BrandVoiceRegister,
  Confidence,
  StageRunResult,
} from '../types/baseline-plan.types';
import { upsertBrandVoice } from '../repository/baseline-plan.repository';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const Anthropic = require('@anthropic-ai/sdk');
const anthropic = new (Anthropic.default ?? Anthropic)();

const HAIKU_MODEL          = 'claude-haiku-4-5-20251001';
const FALLBACK_MODEL       = 'fallback';
const MAX_PRODUCTS         = 30;          // sample size voor prompt
const MAX_DESC_CHARS       = 1500;        // per product cap
const MIN_DESC_CHARS       = 30;          // minimum om als 'rich' te tellen
const MAX_OUTPUT_TOKENS    = 1200;

// ── Public entry point ──────────────────────────────────────

export async function runBrandVoiceStage(tenantId: string): Promise<StageRunResult> {
  logger.info('day_zero.brand_voice.start', { tenantId });

  const products = await loadProductSample(tenantId);

  // Edge case: tenant heeft 0 producten gesynced.
  if (products.length === 0) {
    logger.warn('day_zero.brand_voice.no_products', { tenantId });
    const voice = neutralFallbackVoice('no_products');
    await upsertBrandVoice({
      tenantId, brandVoice: voice, model: FALLBACK_MODEL,
      inputTokens: 0, outputTokens: 0,
    });
    return {
      ok: true, stage: 2, model: FALLBACK_MODEL,
      inputTokens: 0, outputTokens: 0,
      fallback: true, notes: 'no_products',
    };
  }

  const richProducts = products.filter(
    p => p.description && p.description.trim().length >= MIN_DESC_CHARS
  );
  const useFallback = richProducts.length === 0;

  const prompt = buildPrompt(products, useFallback);

  let response;
  try {
    response = await anthropic.messages.create({
      model:      HAIKU_MODEL,
      max_tokens: MAX_OUTPUT_TOKENS,
      messages:   [{ role: 'user', content: prompt }],
    });
  } catch (err) {
    logger.error('day_zero.brand_voice.api_error', {
      tenantId,
      error: (err as Error).message,
    });
    const voice = neutralFallbackVoice('api_error');
    await upsertBrandVoice({
      tenantId, brandVoice: voice, model: FALLBACK_MODEL,
      inputTokens: 0, outputTokens: 0,
    });
    return {
      ok: false, stage: 2, model: FALLBACK_MODEL,
      inputTokens: 0, outputTokens: 0,
      fallback: true, notes: 'api_error',
    };
  }

  const text =
    response.content[0]?.type === 'text' ? response.content[0].text : '{}';
  const clean = text.replace(/```json|```/g, '').trim();
  const inputTokens  = response.usage?.input_tokens  ?? 0;
  const outputTokens = response.usage?.output_tokens ?? 0;

  let parsed: unknown;
  try {
    parsed = JSON.parse(clean);
  } catch (err) {
    logger.error('day_zero.brand_voice.parse_failed', {
      tenantId,
      raw: text.slice(0, 300),
    });
    const voice = neutralFallbackVoice('parse_error');
    await upsertBrandVoice({
      tenantId, brandVoice: voice, model: HAIKU_MODEL,
      inputTokens, outputTokens,
    });
    return {
      ok: false, stage: 2, model: HAIKU_MODEL,
      inputTokens, outputTokens,
      fallback: true, notes: 'parse_error',
    };
  }

  const voice = normalizeBrandVoice(
    parsed,
    useFallback ? 'low' : 'medium',
  );

  await upsertBrandVoice({
    tenantId, brandVoice: voice, model: HAIKU_MODEL,
    inputTokens, outputTokens,
  });

  logger.info('day_zero.brand_voice.complete', {
    tenantId,
    productsAnalyzed: products.length,
    richProducts:     richProducts.length,
    fallbackPrompt:   useFallback,
    confidence:       voice.confidence,
    inputTokens,
    outputTokens,
  });

  return {
    ok: true, stage: 2, model: HAIKU_MODEL,
    inputTokens, outputTokens,
    fallback: useFallback,
    notes: `analyzed=${products.length} rich=${richProducts.length}`,
  };
}

// ── Data loading ────────────────────────────────────────────

interface ProductSample {
  title:         string;
  description:   string | null;
  product_type:  string | null;
  vendor:        string | null;
  tags:          string[] | null;
  price:         string | null;     // numeric komt als string uit pg
}

async function loadProductSample(tenantId: string): Promise<ProductSample[]> {
  // Voorrang aan producten met description; daarna recent geupdate.
  const result = await db.query<ProductSample>(
    `SELECT
       title,
       description,
       product_type,
       vendor,
       tags,
       COALESCE(price, price_max, price_min)::text AS price
     FROM products
     WHERE tenant_id = $1
     ORDER BY
       CASE
         WHEN description IS NOT NULL
           AND char_length(description) >= $3 THEN 0
         ELSE 1
       END,
       updated_at DESC
     LIMIT $2`,
    [tenantId, MAX_PRODUCTS, MIN_DESC_CHARS],
    { allowNoTenant: true }
  );
  return result.rows;
}

// ── Prompt construction ─────────────────────────────────────

function buildPrompt(products: ProductSample[], useFallback: boolean): string {
  const compact = products
    .map((p, i) => {
      const desc = (p.description ?? '').slice(0, MAX_DESC_CHARS);
      const lines: string[] = [`${i + 1}. ${p.title}`];
      if (p.product_type) lines.push(`   type: ${p.product_type}`);
      if (p.vendor)       lines.push(`   vendor: ${p.vendor}`);
      if (p.tags?.length) lines.push(`   tags: ${p.tags.slice(0, 8).join(', ')}`);
      if (p.price)        lines.push(`   price: ${p.price}`);
      if (desc)           lines.push(`   description: ${desc}`);
      return lines.join('\n');
    })
    .join('\n\n');

  // V0 Gap 3c: explicit availability map so Haiku does not misreport
  // "no titles available" when titles ARE present. Titles are always
  // present (NOT NULL in products table). The other fields are optional.
  const richCount         = products.filter(
    p => p.description && p.description.trim().length >= MIN_DESC_CHARS
  ).length;
  const withProductType   = products.filter(p => p.product_type).length;
  const withVendor        = products.filter(p => p.vendor).length;
  const withTags          = products.filter(p => p.tags && p.tags.length > 0).length;
  const withPrice         = products.filter(p => p.price).length;

  const availabilityNote = [
    'Field availability across the sample:',
    `  titles: ${products.length} of ${products.length} (always present)`,
    `  rich descriptions (>= ${MIN_DESC_CHARS} chars): ${richCount} of ${products.length}`,
    `  product_type: ${withProductType} of ${products.length}`,
    `  vendor: ${withVendor} of ${products.length}`,
    `  tags: ${withTags} of ${products.length}`,
    `  price: ${withPrice} of ${products.length}`,
  ].join('\n');

  const fallbackNote = useFallback
    ? '\nIMPORTANT: rich descriptions are absent or too short across the catalogue. Base your fingerprint primarily on titles, product types, vendor, tags, and price range. Set confidence to "low" and reference the limited description data in source_note.\n'
    : '';

  return [
    'You are extracting the brand voice fingerprint for an ecommerce store.',
    'Analyse the product catalogue below and return a structured fingerprint.',
    '',
    availabilityNote,
    fallbackNote,
    'Catalogue sample:',
    compact,
    '',
    'Return ONLY a JSON object with this exact shape (no extra keys, no prose, no markdown fences):',
    '{',
    '  "tone": ["adjective", "adjective"],',
    '  "personality": "1 to 2 sentence description of brand personality",',
    '  "style": "casual" | "professional" | "playful" | "authoritative" | "mixed",',
    '  "signature_phrases": ["..."],',
    '  "taboos": ["..."],',
    '  "target_audience_hint": "1 sentence on who buys here",',
    '  "language_register": "informal" | "formal" | "mixed",',
    '  "confidence": "low" | "medium" | "high",',
    '  "source_note": "1 sentence explaining which fields formed the basis"',
    '}',
    '',
    'Rules:',
    '- tone: 3 to 5 short adjectives, lowercase.',
    '- signature_phrases: 0 to 5 short recurring phrases or hooks.',
    '- taboos: 0 to 3 words or topics this brand should avoid.',
    '- All strings stay under 300 characters.',
    '- source_note: describe which fields were available and used. NEVER write "no titles available" because titles are always present. If descriptions are missing, write something like "Based on titles, types and tags; descriptions absent" or "Based on titles and price range only; minimal metadata".',
  ].join('\n');
}

// ── Parsing + validation ────────────────────────────────────

const STYLE_OPTIONS:    BrandVoiceStyle[]    = [
  'casual', 'professional', 'playful', 'authoritative', 'mixed',
];
const REGISTER_OPTIONS: BrandVoiceRegister[] = ['informal', 'formal', 'mixed'];
const CONFIDENCE_OPTIONS: Confidence[]       = ['low', 'medium', 'high'];

function normalizeBrandVoice(
  parsed: unknown,
  defaultConfidence: Confidence,
): BrandVoice {
  const obj = (parsed && typeof parsed === 'object')
    ? parsed as Record<string, unknown>
    : {};

  const style = isOneOf(obj.style, STYLE_OPTIONS) ? obj.style as BrandVoiceStyle : 'mixed';
  const register = isOneOf(obj.language_register, REGISTER_OPTIONS)
    ? obj.language_register as BrandVoiceRegister
    : 'mixed';
  const confidence = isOneOf(obj.confidence, CONFIDENCE_OPTIONS)
    ? obj.confidence as Confidence
    : defaultConfidence;

  return {
    tone: Array.isArray(obj.tone)
      ? obj.tone.slice(0, 5).map(t => String(t).slice(0, 40).toLowerCase())
      : [],
    personality:           String(obj.personality           ?? '').slice(0, 300),
    style,
    signature_phrases:     Array.isArray(obj.signature_phrases)
      ? obj.signature_phrases.slice(0, 5).map(p => String(p).slice(0, 100))
      : [],
    taboos:                Array.isArray(obj.taboos)
      ? obj.taboos.slice(0, 3).map(t => String(t).slice(0, 60))
      : [],
    target_audience_hint:  String(obj.target_audience_hint  ?? '').slice(0, 300),
    language_register:     register,
    confidence,
    source_note:           String(obj.source_note           ?? '').slice(0, 300),
  };
}

function isOneOf<T extends string>(val: unknown, options: readonly T[]): boolean {
  return typeof val === 'string' && (options as readonly string[]).includes(val);
}

// ── Neutral fallback ────────────────────────────────────────

function neutralFallbackVoice(
  reason: 'no_products' | 'api_error' | 'parse_error',
): BrandVoice {
  const sourceNote: Record<typeof reason, string> = {
    no_products: 'No products synced yet. Neutral fingerprint applied.',
    api_error:   'Brand voice extraction failed. Neutral fingerprint applied.',
    parse_error: 'Brand voice output invalid. Neutral fingerprint applied.',
  };

  return {
    tone:                  ['friendly', 'clear', 'practical'],
    personality:           'Helpful and direct.',
    style:                 'mixed',
    signature_phrases:     [],
    taboos:                [],
    target_audience_hint:  'Mainstream ecommerce shoppers.',
    language_register:     'mixed',
    confidence:            'low',
    source_note:           sourceNote[reason],
  };
}
