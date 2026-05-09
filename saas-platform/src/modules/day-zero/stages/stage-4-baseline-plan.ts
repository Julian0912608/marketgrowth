// ============================================================
// src/modules/day-zero/stages/stage-4-baseline-plan.ts
//
// Stage 4 van Day Zero: baseline marketing plan via Claude Sonnet.
//
// Architecture Plan model assignment:
//   "Day Zero AI setup → claude-sonnet-4-20250514"
//
// Deze stage combineert eerdere Day Zero output:
//   - brand_voice  (Stage 2, Haiku)
//   - patterns     (Stage 3, Sonnet)
//   - onboarding   (country, business_goal, marketing_style)
//
// Output structuur volgt Master Plan §Day Zero ("baseline strategy:
// positioning, audiences, channel priorities, content angles").
//
// Public:
//   runBaselinePlanStage(tenantId): Promise<StageRunResult>
//
// Vereiste: Stage 2 en Stage 3 moeten al gedraaid hebben. Bij
// missing inputs valt de service terug op een minimal plan zodat
// de Day Zero job niet faalt.
// ============================================================

import { logger } from '../../../shared/logging/logger';
import {
  MarketingPlan,
  TargetAudience,
  ChannelPriority,
  ContentAngle,
  BrandVoice,
  Patterns,
  OnboardingContext,
  StageRunResult,
} from '../types/baseline-plan.types';
import {
  upsertMarketingPlan,
  getBrandVoice,
  getPatterns,
  loadOnboardingContext,
} from '../repository/baseline-plan.repository';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const Anthropic = require('@anthropic-ai/sdk');
const anthropic = new (Anthropic.default ?? Anthropic)();

const SONNET_MODEL      = 'claude-sonnet-4-20250514';
const FALLBACK_MODEL    = 'fallback';
const MAX_OUTPUT_TOKENS = 3000;

// ── Public entry point ──────────────────────────────────────

export async function runBaselinePlanStage(tenantId: string): Promise<StageRunResult> {
  logger.info('day_zero.plan.start', { tenantId });

  const [brandVoice, patterns, onboarding] = await Promise.all([
    getBrandVoice(tenantId),
    getPatterns(tenantId),
    loadOnboardingContext(tenantId),
  ]);

  // Edge case: voorgaande stages hebben niets weggeschreven.
  // Dat zou niet mogen gebeuren als de switch sequentieel werkt,
  // maar we vangen het op om Day Zero niet te laten falen.
  if (!brandVoice || !patterns) {
    logger.warn('day_zero.plan.missing_inputs', {
      tenantId,
      hasBrandVoice: !!brandVoice,
      hasPatterns:   !!patterns,
    });
    const plan = minimalFallbackPlan('missing_inputs', onboarding);
    await upsertMarketingPlan({
      tenantId, marketingPlan: plan, model: FALLBACK_MODEL,
      inputTokens: 0, outputTokens: 0,
    });
    return {
      ok: false, stage: 4, model: FALLBACK_MODEL,
      inputTokens: 0, outputTokens: 0,
      fallback: true, notes: 'missing_inputs',
    };
  }

  const prompt = buildPrompt(brandVoice, patterns, onboarding);

  let response;
  try {
    response = await anthropic.messages.create({
      model:      SONNET_MODEL,
      max_tokens: MAX_OUTPUT_TOKENS,
      messages:   [{ role: 'user', content: prompt }],
    });
  } catch (err) {
    logger.error('day_zero.plan.api_error', {
      tenantId,
      error: (err as Error).message,
    });
    const plan = minimalFallbackPlan('api_error', onboarding);
    await upsertMarketingPlan({
      tenantId, marketingPlan: plan, model: FALLBACK_MODEL,
      inputTokens: 0, outputTokens: 0,
    });
    return {
      ok: false, stage: 4, model: FALLBACK_MODEL,
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
    logger.error('day_zero.plan.parse_failed', {
      tenantId,
      raw: text.slice(0, 400),
    });
    const plan = minimalFallbackPlan('parse_error', onboarding);
    await upsertMarketingPlan({
      tenantId, marketingPlan: plan, model: SONNET_MODEL,
      inputTokens, outputTokens,
    });
    return {
      ok: false, stage: 4, model: SONNET_MODEL,
      inputTokens, outputTokens,
      fallback: true, notes: 'parse_error',
    };
  }

  const plan = normalizeMarketingPlan(parsed);

  await upsertMarketingPlan({
    tenantId, marketingPlan: plan, model: SONNET_MODEL,
    inputTokens, outputTokens,
  });

  logger.info('day_zero.plan.complete', {
    tenantId,
    audiences:        plan.target_audiences.length,
    channels:         plan.channel_priorities.length,
    contentAngles:    plan.content_angles.length,
    inputTokens,
    outputTokens,
  });

  return {
    ok: true, stage: 4, model: SONNET_MODEL,
    inputTokens, outputTokens,
    fallback: false,
    notes: `audiences=${plan.target_audiences.length} channels=${plan.channel_priorities.length} angles=${plan.content_angles.length}`,
  };
}

// ── Prompt construction ─────────────────────────────────────

function buildPrompt(
  brandVoice:  BrandVoice,
  patterns:    Patterns,
  onboarding:  OnboardingContext,
): string {
  return [
    'You are writing the baseline marketing plan for an early-stage ecommerce founder.',
    'You have three sources of truth: brand voice, business patterns, and the founder\'s onboarding answers.',
    'Be specific and tied to the data. Avoid generic playbooks.',
    '',
    'Founder context:',
    `  country: ${onboarding.countryCode ?? 'unknown'}`,
    `  sells to: ${(onboarding.sellsToCountries ?? []).join(', ') || 'unknown'}`,
    `  business goal: ${onboarding.businessGoal ?? 'unknown'}`,
    `  marketing style preference: ${onboarding.marketingStyle ?? 'unknown'}`,
    '',
    'Brand voice (Stage 2 output):',
    JSON.stringify(brandVoice, null, 2),
    '',
    'Patterns (Stage 3 output):',
    JSON.stringify(patterns, null, 2),
    '',
    'Return ONLY a JSON object with this exact shape (no markdown fences, no prose outside JSON):',
    '{',
    '  "positioning": "1 to 2 sentences",',
    '  "value_propositions": ["3 to 5 specific bullets tied to top SKUs and audience"],',
    '  "target_audiences": [',
    '    { "name": "...", "description": "1 to 2 sentences", "key_message": "1 sentence in brand voice" }',
    '  ],',
    '  "channel_priorities": [',
    '    { "channel": "meta_ads | organic_social | email | seo | bolcom_ads | google_ads | content | community", "priority_rank": 1, "rationale": "why this channel for this business", "weekly_action": "1 concrete action this week" }',
    '  ],',
    '  "content_angles": [',
    '    { "angle": "...", "example_hook": "1 sentence in brand voice", "best_channel": "..." }',
    '  ],',
    '  "weekly_cadence": ["3 to 5 recurring weekly actions"],',
    '  "next_30_days_focus": "1 to 2 sentences on the single most important thing to do in the next 30 days",',
    '  "warnings": ["data gaps, risks, or assumptions worth flagging"]',
    '}',
    '',
    'Rules:',
    '- target_audiences: max 3, in priority order. Each key_message uses brand voice tone.',
    '- channel_priorities: ranked from highest priority. Match the founder\'s marketing_style preference where possible.',
    '- content_angles: max 5. Each angle is concrete, not generic.',
    '- weekly_cadence: 3 to 5 actions a solo founder can realistically do.',
    '- warnings: include if data_quality is low, customer table is empty, or marketing_style does not match channel mix.',
    '- All strings stay under 600 characters.',
  ].join('\n');
}

// ── Parsing + validation ────────────────────────────────────

function normalizeMarketingPlan(parsed: unknown): MarketingPlan {
  const obj = (parsed && typeof parsed === 'object')
    ? parsed as Record<string, unknown>
    : {};

  const audiences: TargetAudience[] = Array.isArray(obj.target_audiences)
    ? obj.target_audiences.slice(0, 3).map((a: unknown) => {
        const o = a as Record<string, unknown>;
        return {
          name:         String(o.name ?? '').slice(0, 100),
          description:  String(o.description ?? '').slice(0, 500),
          key_message:  String(o.key_message ?? '').slice(0, 400),
        };
      })
    : [];

  const channels: ChannelPriority[] = Array.isArray(obj.channel_priorities)
    ? obj.channel_priorities.slice(0, 8).map((c: unknown, i: number) => {
        const o = c as Record<string, unknown>;
        const rank = toInt(o.priority_rank);
        return {
          channel:        String(o.channel ?? '').slice(0, 60),
          priority_rank:  rank > 0 ? rank : i + 1,
          rationale:      String(o.rationale ?? '').slice(0, 500),
          weekly_action:  String(o.weekly_action ?? '').slice(0, 400),
        };
      })
    : [];

  const angles: ContentAngle[] = Array.isArray(obj.content_angles)
    ? obj.content_angles.slice(0, 5).map((a: unknown) => {
        const o = a as Record<string, unknown>;
        return {
          angle:         String(o.angle ?? '').slice(0, 200),
          example_hook:  String(o.example_hook ?? '').slice(0, 400),
          best_channel:  String(o.best_channel ?? '').slice(0, 60),
        };
      })
    : [];

  return {
    positioning:        String(obj.positioning ?? '').slice(0, 500),
    value_propositions: Array.isArray(obj.value_propositions)
      ? obj.value_propositions.slice(0, 5).map(x => String(x).slice(0, 400))
      : [],
    target_audiences:   audiences,
    channel_priorities: channels.sort((a, b) => a.priority_rank - b.priority_rank),
    content_angles:     angles,
    weekly_cadence:     Array.isArray(obj.weekly_cadence)
      ? obj.weekly_cadence.slice(0, 5).map(x => String(x).slice(0, 300))
      : [],
    next_30_days_focus: String(obj.next_30_days_focus ?? '').slice(0, 500),
    warnings:           Array.isArray(obj.warnings)
      ? obj.warnings.slice(0, 5).map(x => String(x).slice(0, 300))
      : [],
  };
}

function toInt(v: unknown): number {
  if (typeof v === 'number') return Number.isFinite(v) ? Math.round(v) : 0;
  if (typeof v === 'string') {
    const n = parseInt(v, 10);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

// ── Minimal fallback plan ───────────────────────────────────

function minimalFallbackPlan(
  reason:      'missing_inputs' | 'api_error' | 'parse_error',
  onboarding:  OnboardingContext,
): MarketingPlan {
  const reasonText: Record<typeof reason, string> = {
    missing_inputs: 'Day Zero stages 2 or 3 did not produce data. Plan will regenerate on next Day Zero run.',
    api_error:      'Plan generation call failed. Minimal baseline applied. Day Zero can be re-triggered from settings.',
    parse_error:    'Plan generation returned invalid JSON. Minimal baseline applied. Day Zero can be re-triggered.',
  };

  const country = onboarding.countryCode ?? 'EU';
  const style   = onboarding.marketingStyle ?? 'mix';

  return {
    positioning:        `Early-stage ecommerce store serving the ${country} market. Positioning will sharpen as more sales data accumulates.`,
    value_propositions: [
      'Curated product selection.',
      'Direct customer connection through founder-led brand.',
      'Fast feedback loop on what is working.',
    ],
    target_audiences: [
      {
        name:         'Early adopters',
        description:  'Buyers willing to try a new store and provide feedback.',
        key_message:  'Be among the first to try and shape what comes next.',
      },
    ],
    channel_priorities: [
      {
        channel:        style === 'paid' ? 'meta_ads' : 'organic_social',
        priority_rank:  1,
        rationale:      `Matches founder marketing style preference (${style}). Lowest barrier to first results.`,
        weekly_action:  'Publish 3 posts this week. Review engagement metrics on Sunday.',
      },
    ],
    content_angles: [
      {
        angle:         'Founder story',
        example_hook:  'Why I started this store and what I am building it for.',
        best_channel:  'organic_social',
      },
    ],
    weekly_cadence: [
      'Review previous week metrics on Monday morning.',
      'Publish 3 content pieces across chosen channels.',
      'Send 1 email to existing audience.',
    ],
    next_30_days_focus: 'Establish a publishing rhythm and gather first conversion signals to refine the plan.',
    warnings:           [reasonText[reason]],
  };
}
