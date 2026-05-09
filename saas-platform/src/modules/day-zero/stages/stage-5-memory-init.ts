// ============================================================
// src/modules/day-zero/stages/stage-5-memory-init.ts
//
// Stage 5 van Day Zero: AI Memory v1 initialization + first
// daily briefing seed.
//
// Master Plan §9 + Architecture Plan §Day Zero Stage 5:
//   "Initialize AI Memory v1. Schedule first daily briefing
//    for 07:00 next morning."
//
// Wat we doen:
//   1. Read brand_voice (Stage 2) + patterns (Stage 3) +
//      marketing_plan (Stage 4) + onboarding context.
//   2. Bouw 5-15 memory records (een per logische unit).
//   3. Embed batch via Voyage AI voyage-3-lite (1 API call).
//   4. Insert in ai_memories (na clear van bestaande Day Zero kinds
//      voor idempotente re-runs via admin trigger).
//   5. Genereer eerste briefing met de bestaande Sonnet flow en
//      seed in tenant_settings.ai_last_briefing zodat de 06:00 UTC
//      cron in email.worker.ts morgen direct content heeft.
//
// De daily briefing global cron draait al (email.worker.ts:
// 'daily-briefing' repeat at '0 6 * * *'). Stage 5 hoeft hem
// niet apart te schedulen.
// ============================================================

import { logger } from '../../../shared/logging/logger';
import { db } from '../../../infrastructure/database/connection';
import {
  BrandVoice,
  Patterns,
  MarketingPlan,
  OnboardingContext,
} from '../types/baseline-plan.types';
import {
  getBrandVoice,
  getPatterns,
  getFullPlan,
  loadOnboardingContext,
} from '../repository/baseline-plan.repository';
import { embeddingService, EMBEDDING_MODEL } from '../../ai-memory/services/embedding.service';
import { aiMemoriesRepository } from '../../ai-memory/repository/ai-memories.repository';
import {
  AiMemoryInput,
  MemoryKind,
} from '../../ai-memory/types/ai-memory.types';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const Anthropic = require('@anthropic-ai/sdk');
const anthropic = new (Anthropic.default ?? Anthropic)();

const SONNET_MODEL = 'claude-sonnet-4-20250514';

// Day Zero kinds: dit zijn de memories die Stage 5 schrijft.
// briefing_outcome komt later (V1 bij briefing-tracking).
const DAY_ZERO_KINDS: MemoryKind[] = [
  'brand_voice',
  'pattern_insight',
  'plan_positioning',
  'plan_focus',
  'target_audience',
  'channel_priority',
  'content_angle',
  'onboarding_fact',
];

// Sync met build-tenant-context.ts en COUNTRIES lijst frontend.
const COUNTRY_NAMES: Record<string, string> = {
  AT: 'Austria', BE: 'Belgium', BG: 'Bulgaria', HR: 'Croatia', CY: 'Cyprus',
  CZ: 'Czech Republic', DK: 'Denmark', EE: 'Estonia', FI: 'Finland', FR: 'France',
  DE: 'Germany', GR: 'Greece', HU: 'Hungary', IE: 'Ireland', IT: 'Italy',
  LV: 'Latvia', LT: 'Lithuania', LU: 'Luxembourg', MT: 'Malta', NL: 'the Netherlands',
  PL: 'Poland', PT: 'Portugal', RO: 'Romania', SK: 'Slovakia', SI: 'Slovenia',
  ES: 'Spain', SE: 'Sweden', GB: 'the United Kingdom', NO: 'Norway', CH: 'Switzerland',
};

// Lokale result type. StageRunResult in baseline-plan.types.ts heeft
// stage: 2 | 3 | 4. Stage 5 returnt zelfde shape met stage: 5.
// Wordt gecast in day-zero.service.ts voor stage_5 stage_data.
export interface MemoryInitStageResult {
  ok:           boolean;
  stage:        5;
  model:        string;
  inputTokens:  number;
  outputTokens: number;
  fallback:     boolean;
  notes?:       string;
}

// ── Public entry point ──────────────────────────────────────

export async function runMemoryInitStage(tenantId: string): Promise<MemoryInitStageResult> {
  const startedAt = Date.now();
  logger.info('day_zero.memory_init.start', { tenantId });

  // 1. Lees alle Day Zero output
  const [brandVoice, patterns, fullPlan, onboarding] = await Promise.all([
    getBrandVoice(tenantId),
    getPatterns(tenantId),
    getFullPlan(tenantId),
    loadOnboardingContext(tenantId),
  ]);

  const marketingPlan = fullPlan?.marketing_plan && Object.keys(fullPlan.marketing_plan).length > 0
    ? (fullPlan.marketing_plan as MarketingPlan)
    : null;

  if (!brandVoice && !patterns && !marketingPlan) {
    logger.warn('day_zero.memory_init.no_inputs', { tenantId });
    return {
      ok:           true,
      stage:        5,
      model:        EMBEDDING_MODEL,
      inputTokens:  0,
      outputTokens: 0,
      fallback:     true,
      notes:        'Geen Day Zero output beschikbaar. Stage 5 gracefully overgeslagen.',
    };
  }

  // 2. Bouw memory records
  const memoryInputs = buildMemoryInputs(tenantId, brandVoice, patterns, marketingPlan, onboarding);

  if (memoryInputs.length === 0) {
    logger.warn('day_zero.memory_init.no_records', { tenantId });
    return {
      ok:           true,
      stage:        5,
      model:        EMBEDDING_MODEL,
      inputTokens:  0,
      outputTokens: 0,
      fallback:     true,
      notes:        'Geen memory records uit Day Zero output kunnen extraheren.',
    };
  }

  // 3. Embed batch via Voyage
  let embeddings: number[][];
  try {
    embeddings = await embeddingService.embed(
      memoryInputs.map(m => m.content),
      'document',
    );
  } catch (err: any) {
    logger.error('day_zero.memory_init.embed_failed', {
      tenantId,
      error: err?.message ?? 'unknown',
      count: memoryInputs.length,
    });
    return {
      ok:           false,
      stage:        5,
      model:        EMBEDDING_MODEL,
      inputTokens:  0,
      outputTokens: 0,
      fallback:     true,
      notes:        'Voyage embedding API failure. Memory niet geinitialiseerd. Re-trigger Day Zero via admin.',
    };
  }

  if (embeddings.length !== memoryInputs.length) {
    logger.error('day_zero.memory_init.embedding_mismatch', {
      tenantId,
      expected: memoryInputs.length,
      got:      embeddings.length,
    });
    return {
      ok:           false,
      stage:        5,
      model:        EMBEDDING_MODEL,
      inputTokens:  0,
      outputTokens: 0,
      fallback:     true,
      notes:        'Voyage retourneerde verkeerd aantal embeddings.',
    };
  }

  // 4. Wis bestaande Day Zero kinds, dan insert (idempotent voor re-runs)
  await aiMemoriesRepository.deleteByTenantAndKinds(tenantId, DAY_ZERO_KINDS);

  const itemsToInsert = memoryInputs.map((input, i) => ({
    ...input,
    embedding: embeddings[i],
  }));
  await aiMemoriesRepository.insertMany(itemsToInsert);

  const counts = await aiMemoriesRepository.countByKind(tenantId);

  // 5. Seed first daily briefing (zodat morgen 06:00 UTC cron content heeft)
  let briefingSeeded = false;
  let briefingTokens = { input: 0, output: 0 };
  try {
    const seed = await seedFirstBriefing(tenantId, brandVoice, marketingPlan, onboarding);
    briefingSeeded = seed.ok;
    briefingTokens = seed.tokens;
  } catch (err: any) {
    logger.warn('day_zero.first_briefing.failed', {
      tenantId,
      error: err?.message ?? 'unknown',
    });
    // Niet fataal: morgen genereert /api/ai/insights het zelf bij eerste login.
  }

  const durationMs = Date.now() - startedAt;
  logger.info('day_zero.memory_init.complete', {
    tenantId,
    memoriesInserted: itemsToInsert.length,
    countsByKind:     counts,
    briefingSeeded,
    durationMs,
  });

  return {
    ok:           true,
    stage:        5,
    model:        briefingSeeded ? SONNET_MODEL : EMBEDDING_MODEL,
    inputTokens:  briefingTokens.input,
    outputTokens: briefingTokens.output,
    fallback:     false,
    notes:        `Geseeded: ${itemsToInsert.length} memories (${Object.keys(counts).join(', ')}). First briefing: ${briefingSeeded ? 'ja' : 'wacht op 06:00 UTC cron'}.`,
  };
}

// ── Memory record builders ──────────────────────────────────

function buildMemoryInputs(
  tenantId:    string,
  brandVoice:  BrandVoice | null,
  patterns:    Patterns | null,
  plan:        MarketingPlan | null,
  onboarding:  OnboardingContext,
): AiMemoryInput[] {

  const out: AiMemoryInput[] = [];

  // ── Brand voice (1 record) ──────────────────────────────
  if (brandVoice) {
    const bv: any  = brandVoice;
    const tones    = bv.tone_descriptors  ?? bv.tones    ?? [];
    const voices   = bv.voice_descriptors ?? bv.voice    ?? [];
    const samples  = bv.sample_phrases    ?? bv.phrases  ?? [];
    const summary  = bv.summary           ?? bv.note     ?? '';

    const parts: string[] = [];
    if (Array.isArray(tones)   && tones.length   > 0) parts.push('Tone: ' + tones.slice(0, 5).join(', ') + '.');
    if (Array.isArray(voices)  && voices.length  > 0) parts.push('Voice: ' + voices.slice(0, 5).join(', ') + '.');
    if (Array.isArray(samples) && samples.length > 0) parts.push('Sample phrasing: "' + samples.slice(0, 3).join('"; "') + '".');
    if (typeof summary === 'string' && summary.trim().length > 0) parts.push(summary.trim());

    const content = parts.join(' ').trim();
    if (content.length > 0) {
      out.push({
        tenantId,
        kind:      'brand_voice',
        content:   'Brand voice fingerprint. ' + content,
        metadata:  { source: 'day_zero_stage_2' },
        sourceRef: 'baseline_marketing_plans:brand_voice',
      });
    }
  }

  // ── Pattern insights (3-7 records) ──────────────────────
  if (patterns) {
    const p: any   = patterns;
    const insights = Array.isArray(p.key_insights) ? p.key_insights : [];

    for (const insight of insights.slice(0, 7)) {
      const text = typeof insight === 'string'
        ? insight
        : (insight?.text ?? insight?.insight ?? insight?.description ?? '');

      if (typeof text === 'string' && text.trim().length > 10) {
        out.push({
          tenantId,
          kind:      'pattern_insight',
          content:   'Business pattern: ' + text.trim(),
          metadata:  { source: 'day_zero_stage_3' },
          sourceRef: 'baseline_marketing_plans:patterns.key_insights',
        });
      }
    }

    // Top SKUs als context (1 extra record als er data is)
    const topSkus = Array.isArray(p.top_skus) ? p.top_skus : [];
    if (topSkus.length > 0) {
      const skuLines = topSkus.slice(0, 5).map((s: any) => {
        const title = s?.title ?? s?.name ?? 'unknown';
        const rev   = typeof s?.revenue_share === 'number'
          ? ' (' + (s.revenue_share * 100).toFixed(0) + '% revenue share)'
          : '';
        return `${title}${rev}`;
      });
      out.push({
        tenantId,
        kind:      'pattern_insight',
        content:   'Top SKUs by revenue: ' + skuLines.join('; ') + '.',
        metadata:  { source: 'day_zero_stage_3', insight_type: 'top_skus' },
        sourceRef: 'baseline_marketing_plans:patterns.top_skus',
      });
    }
  }

  // ── Plan positioning (1 record) ─────────────────────────
  if (plan?.positioning && plan.positioning.trim().length > 0) {
    const valueProps = Array.isArray(plan.value_propositions) ? plan.value_propositions : [];
    const vpText     = valueProps.length > 0
      ? ' Value propositions: ' + valueProps.slice(0, 5).join('; ') + '.'
      : '';
    out.push({
      tenantId,
      kind:      'plan_positioning',
      content:   'Positioning: ' + plan.positioning.trim() + '.' + vpText,
      metadata:  { source: 'day_zero_stage_4' },
      sourceRef: 'baseline_marketing_plans:marketing_plan.positioning',
    });
  }

  // ── Plan focus + weekly cadence (1 record) ──────────────
  const cadence   = Array.isArray(plan?.weekly_cadence) ? plan!.weekly_cadence : [];
  const focusText = plan?.next_30_days_focus?.trim() ?? '';
  if (focusText.length > 0 || cadence.length > 0) {
    const cadenceText = cadence.length > 0
      ? 'Weekly cadence: ' + cadence.slice(0, 5).join('; ') + '.'
      : '';
    const focusBlock  = focusText.length > 0 ? focusText + ' ' : '';
    out.push({
      tenantId,
      kind:      'plan_focus',
      content:   'Next 30 days focus and rhythm. ' + focusBlock + cadenceText,
      metadata:  { source: 'day_zero_stage_4' },
      sourceRef: 'baseline_marketing_plans:marketing_plan.focus',
    });
  }

  // ── Target audiences (1-3 records) ──────────────────────
  if (Array.isArray(plan?.target_audiences)) {
    for (const a of plan!.target_audiences.slice(0, 3)) {
      if (a?.name && a?.description) {
        const km = a.key_message ? ' Key message: ' + a.key_message + '.' : '';
        out.push({
          tenantId,
          kind:      'target_audience',
          content:   'Target audience "' + a.name + '": ' + a.description + '.' + km,
          metadata:  { source: 'day_zero_stage_4', audience_name: a.name },
          sourceRef: 'baseline_marketing_plans:marketing_plan.target_audiences',
        });
      }
    }
  }

  // ── Channel priorities (top 2 ranked) ───────────────────
  if (Array.isArray(plan?.channel_priorities)) {
    const sorted = [...plan!.channel_priorities].sort(
      (a, b) => (a.priority_rank ?? 99) - (b.priority_rank ?? 99),
    );
    for (const c of sorted.slice(0, 2)) {
      if (c?.channel && c?.rationale) {
        const wa = c.weekly_action ? ' Weekly action: ' + c.weekly_action + '.' : '';
        out.push({
          tenantId,
          kind:      'channel_priority',
          content:   'Channel priority #' + (c.priority_rank ?? '?') + ' is ' + c.channel + '. Rationale: ' + c.rationale + '.' + wa,
          metadata:  {
            source:  'day_zero_stage_4',
            channel: c.channel,
            rank:    c.priority_rank,
          },
          sourceRef: 'baseline_marketing_plans:marketing_plan.channel_priorities',
        });
      }
    }
  }

  // ── Content angles (1-2 records) ────────────────────────
  if (Array.isArray(plan?.content_angles)) {
    for (const a of plan!.content_angles.slice(0, 2)) {
      if (a?.angle && a?.example_hook) {
        const bc = a.best_channel ? ' Best on: ' + a.best_channel + '.' : '';
        out.push({
          tenantId,
          kind:      'content_angle',
          content:   'Content angle "' + a.angle + '": example hook "' + a.example_hook + '".' + bc,
          metadata:  { source: 'day_zero_stage_4', angle: a.angle },
          sourceRef: 'baseline_marketing_plans:marketing_plan.content_angles',
        });
      }
    }
  }

  // ── Onboarding fact (1 record) ──────────────────────────
  const onboardingContent = buildOnboardingMemoryContent(onboarding);
  if (onboardingContent) {
    out.push({
      tenantId,
      kind:      'onboarding_fact',
      content:   onboardingContent,
      metadata:  {
        source:          'onboarding_wizard',
        country_code:    onboarding.countryCode,
        business_goal:   onboarding.businessGoal,
        marketing_style: onboarding.marketingStyle,
      },
      sourceRef: 'tenants:onboarding_columns',
    });
  }

  return out;
}

function buildOnboardingMemoryContent(o: OnboardingContext): string | null {
  const parts: string[] = [];

  if (o.countryCode) {
    const name = COUNTRY_NAMES[o.countryCode] ?? o.countryCode;
    parts.push('Founder is based in ' + name + ' (country code ' + o.countryCode + ').');
  }
  if (Array.isArray(o.sellsToCountries) && o.sellsToCountries.length > 0) {
    parts.push('Sells to: ' + o.sellsToCountries.slice(0, 10).join(', ') + '.');
  }
  if (o.businessGoal) {
    parts.push('Business goal: ' + o.businessGoal + '.');
  }
  if (o.marketingStyle) {
    parts.push('Marketing style preference: ' + o.marketingStyle + '.');
  }

  if (parts.length === 0) return null;
  return 'Founder context. ' + parts.join(' ');
}

// ── First daily briefing seed ───────────────────────────────

async function seedFirstBriefing(
  tenantId:   string,
  brandVoice: BrandVoice | null,
  plan:       MarketingPlan | null,
  onboarding: OnboardingContext,
): Promise<{ ok: boolean; tokens: { input: number; output: number } }> {

  // Bestaat al? Skip om geen tokens te branden bij re-trigger.
  const existing = await db.query<{ value: string }>(
    `SELECT value FROM tenant_settings WHERE tenant_id = $1 AND key = 'ai_last_briefing'`,
    [tenantId],
    { allowNoTenant: true },
  );
  if (existing.rows[0]?.value && existing.rows[0].value.length > 20) {
    logger.info('day_zero.first_briefing.skip_existing', { tenantId });
    return { ok: false, tokens: { input: 0, output: 0 } };
  }

  // Haal stats voor briefing context
  const statsResult = await db.query<{ orders: number; revenue: string }>(
    `SELECT
       COUNT(*)::int AS orders,
       COALESCE(SUM(total_amount - tax_amount), 0)::text AS revenue
     FROM orders
     WHERE tenant_id = $1
       AND ordered_at >= NOW() - INTERVAL '30 days'
       AND status NOT IN ('cancelled', 'refunded')`,
    [tenantId],
    { allowNoTenant: true },
  );

  const stats   = statsResult.rows[0] ?? { orders: 0, revenue: '0' };
  const country = onboarding.countryCode
    ? (COUNTRY_NAMES[onboarding.countryCode] ?? onboarding.countryCode)
    : 'EU';
  const goal        = onboarding.businessGoal   ?? 'steady';
  const style       = onboarding.marketingStyle ?? 'mix';
  const positioning = plan?.positioning?.trim() || 'early-stage ecommerce store';
  const focus       = plan?.next_30_days_focus?.trim() || 'establish a publishing rhythm and gather first conversion signals';

  const prompt = `You are an AI ecommerce advisor for MarketGrow. Write the first daily briefing for a founder who just completed Day Zero setup.

Founder context:
- Country: ${country}
- Business goal: ${goal}
- Marketing style: ${style}
- Positioning: ${positioning}
- Next 30 days focus: ${focus}

Last 30 days stats:
- Orders: ${stats.orders}
- Revenue (excl. VAT): EUR ${parseFloat(stats.revenue).toFixed(0)}

Return ONLY valid JSON in this exact shape:
{"briefing":"2 to 3 sentences welcoming the founder and connecting their stats to the focus","actions":[{"priority":"high|medium|low","title":"string","description":"string","channel":"meta_ads|google_ads|organic_social|email|seo|general"}],"alerts":[]}

Rules:
- Briefing must reference the focus and stats specifically.
- Provide max 2 actions for the first briefing.
- No fabricated numbers. Only reference the stats provided above.
- Tone matches a real ecom advisor talking to a beginner founder.`;

  const response = await anthropic.messages.create({
    model:      SONNET_MODEL,
    max_tokens: 800,
    messages:   [{ role: 'user', content: prompt }],
  });

  const text  = response.content[0]?.type === 'text' ? response.content[0].text : '{}';
  const clean = text.replace(/```json|```/g, '').trim();

  let parsed: any;
  try {
    parsed = JSON.parse(clean);
  } catch {
    parsed = { briefing: text.slice(0, 300), actions: [], alerts: [] };
  }

  // email.service.ts leest tenant_settings.ai_last_briefing als briefing-text.
  // Schrijf alleen het briefing veld (acties zijn later via /api/ai/insights).
  const briefingText = (typeof parsed.briefing === 'string' && parsed.briefing.trim().length > 0)
    ? parsed.briefing.trim()
    : 'Welcome to MarketGrow. Your first daily briefing is ready. Check your dashboard for tailored recommendations.';

  // Robust upsert: UPDATE eerst, INSERT als 0 rows. Geen aanname over UNIQUE constraint.
  const updateRes = await db.query(
    `UPDATE tenant_settings
     SET value = $1, updated_at = now()
     WHERE tenant_id = $2 AND key = 'ai_last_briefing'`,
    [briefingText, tenantId],
    { allowNoTenant: true },
  );

  if ((updateRes.rowCount ?? 0) === 0) {
    await db.query(
      `INSERT INTO tenant_settings (tenant_id, key, value)
       VALUES ($1, 'ai_last_briefing', $2)`,
      [tenantId, briefingText],
      { allowNoTenant: true },
    );
  }

  const usage = (response as any).usage ?? {};
  return {
    ok:     true,
    tokens: {
      input:  usage.input_tokens  ?? 0,
      output: usage.output_tokens ?? 0,
    },
  };
}
