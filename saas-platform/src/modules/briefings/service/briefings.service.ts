// ============================================================
// src/modules/briefings/service/briefings.service.ts
//
// Single source of truth voor daily briefing generatie.
// Gebruikt door:
//   - GET /api/ai/insights (dashboard, on-demand)
//   - email.service.ts daily cron (06:00 UTC = 07:00 Amsterdam)
//   - Day Zero Stage 5 (first briefing seed)
//   - Admin force trigger
//
// Pipeline (Architecture Plan §AI Pipeline):
//   1. Memory retrieval via memoryInjectionService (top-K cosine)
//   2. Build prompt met memory block + 30-day stats
//   3. Sonnet call (claude-sonnet-4-20250514)
//   4. Sanitize output naar BriefingPayload
//   5. Upsert in tenant_briefings (UTC date als key)
//
// Timezone keuze (V0): briefing_date is UTC. Email cron 06:00 UTC
// = 07:00 NL stuurt briefing voor "vandaag UTC" wat in NL ook
// vandaag is. Edge case 00:00-00:59 UTC = 01:00-01:59 NL is
// acceptabel voor V0 (gebruiker is dan zelden actief).
// ============================================================

import { db } from '../../../infrastructure/database/connection';
import { logger } from '../../../shared/logging/logger';
import { briefingsRepository } from '../repository/briefings.repository';
import { memoryInjectionService } from '../../ai-memory/services/memory-injection.service';
import {
  BriefingPayload,
  BriefingAction,
  BriefingRow,
  BriefingGeneratedVia,
  GenerateBriefingResult,
} from '../types/briefings.types';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const Anthropic = require('@anthropic-ai/sdk');
const anthropic = new (Anthropic.default ?? Anthropic)();

const SONNET_MODEL    = 'claude-sonnet-4-20250514';
const MAX_OUTPUT      = 1000;
const MEMORY_TOP_K    = 7;

class BriefingsService {

  // --------------------------------------------------------------
  // Public API
  // --------------------------------------------------------------

  /**
   * Get today's briefing or generate it if missing. Used by email cron
   * en standaard /api/ai/insights flow.
   */
  async getOrGenerateForToday(
    tenantId: string,
    via:      BriefingGeneratedVia = 'on_demand',
  ): Promise<GenerateBriefingResult> {
    const today    = todayIsoDate();
    const existing = await briefingsRepository.getForDate(tenantId, today);

    if (existing) {
      logger.info('briefings.cache_hit_db', {
        tenantId,
        date: today,
        via:  existing.generated_via,
      });
      return rowToResult(existing, true);
    }

    return this.generateAndStore(tenantId, via);
  }

  /**
   * Force fresh generation. Overwrite van bestaande briefing voor vandaag.
   * Gebruikt door /api/ai/insights met ?force=true en admin trigger.
   */
  async generateAndStore(
    tenantId: string,
    via:      BriefingGeneratedVia = 'on_demand',
  ): Promise<GenerateBriefingResult> {
    const today     = todayIsoDate();
    const startedAt = Date.now();

    // 1. Pull stats (gevalideerd kolommen via project_knowledge)
    const [ordersResult, adsResult] = await Promise.all([
      db.query<{ orders: number; revenue: string; aov: string }>(
        `SELECT COUNT(*)::int AS orders,
                COALESCE(SUM(total_amount - tax_amount), 0)::text AS revenue,
                COALESCE(AVG(total_amount - tax_amount), 0)::text AS aov
         FROM orders
         WHERE tenant_id = $1
           AND ordered_at >= NOW() - INTERVAL '30 days'
           AND status NOT IN ('cancelled', 'refunded')`,
        [tenantId],
        { allowNoTenant: true },
      ),
      db.query<{ spend: string; revenue: string; roas: string }>(
        `SELECT COALESCE(SUM(spend), 0)::text   AS spend,
                COALESCE(SUM(revenue), 0)::text AS revenue,
                COALESCE(AVG(roas), 0)::text    AS roas
         FROM ad_campaigns
         WHERE tenant_id = $1
           AND updated_at >= NOW() - INTERVAL '30 days'`,
        [tenantId],
        { allowNoTenant: true },
      ),
    ]);

    const stats = ordersResult.rows[0] ?? { orders: 0, revenue: '0', aov: '0' };
    const ads   = adsResult.rows[0]    ?? { spend: '0', revenue: '0', roas: '0' };
    const hasOrders = (stats.orders ?? 0) > 0;

    // 2. Memory retrieval
    const memoryQuery = buildMemoryQuery(stats, hasOrders);
    const injection   = await memoryInjectionService.getRelevantMemories(
      tenantId,
      memoryQuery,
      MEMORY_TOP_K,
    );

    // 3. Sonnet call
    const prompt = buildPrompt(stats, ads, hasOrders, injection.promptBlock);

    let response: any;
    try {
      response = await anthropic.messages.create({
        model:      SONNET_MODEL,
        max_tokens: MAX_OUTPUT,
        messages:   [{ role: 'user', content: prompt }],
      });
    } catch (err: any) {
      logger.error('briefings.generate.sonnet_failed', {
        tenantId,
        error: err?.message ?? 'unknown',
      });
      throw new Error('Sonnet API failure: ' + (err?.message ?? 'unknown'));
    }

    const text  = response.content?.[0]?.type === 'text' ? response.content[0].text : '';
    const clean = text.replace(/```json|```/g, '').trim();

    let parsed: BriefingPayload;
    try {
      const raw = JSON.parse(clean);
      parsed    = sanitizeBriefingPayload(raw, hasOrders);
    } catch {
      logger.warn('briefings.generate.parse_failed', {
        tenantId,
        rawSnip: text.slice(0, 200),
      });
      parsed = {
        briefing: text.slice(0, 300) || fallbackBriefingText(hasOrders),
        actions:  [],
        alerts:   [],
      };
    }

    const usage = (response as any).usage ?? {};

    // 4. Upsert
    await briefingsRepository.upsert({
      tenantId,
      briefingDate: today,
      briefingText: parsed.briefing,
      actions:      parsed.actions,
      alerts:       parsed.alerts,
      model:        SONNET_MODEL,
      inputTokens:  usage.input_tokens  ?? 0,
      outputTokens: usage.output_tokens ?? 0,
      memoriesUsed: injection.metrics.afterFilter,
      generatedVia: via,
    });

    logger.info('briefings.generate.complete', {
      tenantId,
      date:         today,
      hasOrders,
      memoriesUsed: injection.metrics.afterFilter,
      tokens:       (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0),
      durationMs:   Date.now() - startedAt,
      via,
    });

    return {
      briefing:     parsed.briefing,
      actions:      parsed.actions,
      alerts:       parsed.alerts,
      briefingDate: today,
      model:        SONNET_MODEL,
      inputTokens:  usage.input_tokens  ?? 0,
      outputTokens: usage.output_tokens ?? 0,
      memoriesUsed: injection.metrics.afterFilter,
      generatedVia: via,
      fromCache:    false,
    };
  }

  /**
   * Pure DB read voor email cron en analytics. Geen AI call.
   */
  async getLatestBriefing(tenantId: string): Promise<BriefingRow | null> {
    return briefingsRepository.getLatest(tenantId);
  }
}

// ============================================================
// Helpers
// ============================================================

function todayIsoDate(): string {
  return new Date().toISOString().slice(0, 10);
}

function rowToResult(row: BriefingRow, fromCache: boolean): GenerateBriefingResult {
  const dateStr = typeof row.briefing_date === 'string'
    ? row.briefing_date
    : new Date(row.briefing_date as any).toISOString().slice(0, 10);

  return {
    briefing:     row.briefing_text,
    actions:      Array.isArray(row.actions) ? row.actions : [],
    alerts:       Array.isArray(row.alerts) ? row.alerts : [],
    briefingDate: dateStr,
    model:        row.model,
    inputTokens:  row.input_tokens,
    outputTokens: row.output_tokens,
    memoriesUsed: row.memories_used,
    generatedVia: row.generated_via,
    fromCache,
  };
}

function buildMemoryQuery(
  stats:     { orders: number; revenue: string; aov: string },
  hasOrders: boolean,
): string {
  if (!hasOrders) {
    return 'Daily briefing for a store with no orders yet. What is the positioning, brand voice, target audience, channel priorities and first-week action plan?';
  }
  return `Daily briefing context for ${stats.orders} orders, EUR ${parseFloat(stats.revenue).toFixed(0)} revenue, AOV EUR ${parseFloat(stats.aov).toFixed(0)} over the last 30 days. What positioning, target audience, channel priorities, content angles and weekly cadence apply?`;
}

function fallbackBriefingText(hasOrders: boolean): string {
  return hasOrders
    ? 'Your stats are processing. Today\'s briefing will refine in the next 24 hours.'
    : 'Connect your first store to receive AI insights. Once orders come in you will see your daily briefing here.';
}

function sanitizeBriefingPayload(raw: any, hasOrders: boolean): BriefingPayload {
  const briefingRaw = typeof raw?.briefing === 'string' ? raw.briefing.trim() : '';
  const briefing    = briefingRaw.length > 0 ? briefingRaw : fallbackBriefingText(hasOrders);

  const actions: BriefingAction[] = Array.isArray(raw?.actions)
    ? raw.actions.slice(0, 4).map((a: any) => ({
        priority:    ['high', 'medium', 'low'].includes(a?.priority) ? a.priority : 'medium',
        title:       String(a?.title ?? '').slice(0, 200),
        description: String(a?.description ?? '').slice(0, 500),
        channel:     String(a?.channel ?? 'general').slice(0, 50),
      }))
    : [];

  const alerts: string[] = Array.isArray(raw?.alerts)
    ? raw.alerts.slice(0, 5).map((s: any) => String(s).slice(0, 300))
    : [];

  return { briefing, actions, alerts };
}

function buildPrompt(
  stats:       { orders: number; revenue: string; aov: string },
  ads:         { spend: string; revenue: string; roas: string },
  hasOrders:   boolean,
  memoryBlock: string,
): string {
  const memoryHeader = memoryBlock.length > 0 ? memoryBlock + '\n\n' : '';

  if (!hasOrders) {
    return memoryHeader + `You are an AI ecommerce advisor for MarketGrow. The founder has not received orders yet.

Return ONLY JSON in this exact shape:
{"briefing":"Connect your first store to receive AI insights. Once orders come in you will see your daily briefing here.","actions":[{"priority":"medium","title":"Connect your store","description":"Go to Integrations and connect your first shop to unlock AI insights.","channel":"general"}],"alerts":[]}`;
  }

  return memoryHeader + `You are an AI ecommerce advisor for MarketGrow. Use the memory context above (the founder's positioning, brand voice, target audiences, channel priorities and content angles) plus today's data to write a concise daily briefing.

Last 30 days data:
- Orders: ${stats.orders}
- Revenue (excl. VAT): EUR ${parseFloat(stats.revenue).toFixed(0)}
- AOV: EUR ${parseFloat(stats.aov).toFixed(0)}
- Ad spend: EUR ${parseFloat(ads.spend).toFixed(0)}
- ROAS: ${parseFloat(ads.roas).toFixed(2)}x

Rules:
- Reference at least one specific item from the memory context (positioning, audience, channel, angle).
- Do not fabricate numbers. Only reference the stats above.
- Actions must be concrete, plan-aligned and tied to either memory or stats.
- Match the founder's voice and goal as captured in the memory.

Return ONLY JSON in this exact shape:
{"briefing":"2 to 3 sentences","actions":[{"priority":"high|medium|low","title":"string","description":"string","channel":"meta_ads|google_ads|organic_social|email|seo|general"}],"alerts":["string"]}`;
}

export const briefingsService = new BriefingsService();
