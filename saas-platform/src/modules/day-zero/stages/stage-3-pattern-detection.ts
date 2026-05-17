// ============================================================
// src/modules/day-zero/stages/stage-3-pattern-detection.ts
//
// Stage 3 van Day Zero: pattern detection via Claude Sonnet.
//
// Architecture Plan model assignment:
//   "Day Zero AI setup. First impression matters. We pay more
//    here for a sharper baseline marketing plan."
//
// FIX 9-mei: loadTopSkus query had LEFT JOIN products ON p.id =
// li.product_id. Dit faalt omdat order_line_items.product_id een
// raw external string is (Bol EAN, Shopify product_id), niet een
// UUID die naar products.id wijst. Verwijderd: gebruik nu li.title
// direct en behoud li.product_id als externe identifier.
//
// V0 Gap 3c (17 mei 2026): twee verbeteringen voor product_id
// fidelity.
//   (1) Prompt: top_skus invoer toont nu expliciet product_id
//       per regel met "PID:" prefix, en de regels in JSON-shape
//       eisen letterlijk overnemen op positie-volgorde.
//   (2) normalizePatterns: factual fallback. Als Sonnet
//       product_id "unknown" of leeg of niet-matchend levert,
//       vullen we de bron-product_id uit loadTopSkus() op
//       positie-volgorde aan. Voorkomt SKU-memory koppeling
//       breuk in Stage 5.
//
// Sonnet leest GEEN raw orders. Wij doen de zware aggregatie in
// Postgres en geven Sonnet samengevatte data:
//   - Top 10 SKUs (revenue, units, contribution share, product_id)
//   - Monthly revenue voor 12 maanden
//   - Customer counts (totaal + first-orders)
//   - Channel mix per platform_slug
//   - Onboarding context (country, business goal, marketing style)
//
// Bol-only quirk: customers tabel kan leeg zijn. Sonnet krijgt
// dat als signaal en past customer_segments aan.
//
// Public:
//   runPatternDetectionStage(tenantId): Promise<StageRunResult>
// ============================================================

import { db } from '../../../infrastructure/database/connection';
import { logger } from '../../../shared/logging/logger';
import {
  Patterns,
  TopSku,
  SeasonalityMonth,
  CustomerSegment,
  ChannelMix,
  Confidence,
  OnboardingContext,
  StageRunResult,
} from '../types/baseline-plan.types';
import {
  upsertPatterns,
  loadOnboardingContext,
} from '../repository/baseline-plan.repository';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const Anthropic = require('@anthropic-ai/sdk');
const anthropic = new (Anthropic.default ?? Anthropic)();

const SONNET_MODEL       = 'claude-sonnet-4-20250514';
const FALLBACK_MODEL     = 'fallback';
const TOP_SKUS_LIMIT     = 10;
const MAX_OUTPUT_TOKENS  = 2500;

// Filter ad-platforms uit channel/order analyses (zelfde lijst
// als sync.scheduler.ts). Day Zero rekent op store data, niet
// op ad spend.
const STORE_PLATFORM_BLOCKLIST = ['bolcom_ads', 'meta_ads', 'google_ads'];

// ── Public entry point ──────────────────────────────────────

export async function runPatternDetectionStage(tenantId: string): Promise<StageRunResult> {
  logger.info('day_zero.patterns.start', { tenantId });

  const [
    onboarding,
    totals,
    topSkus,
    monthlyRevenue,
    customerStats,
    channelMix,
  ] = await Promise.all([
    loadOnboardingContext(tenantId),
    loadTotals(tenantId),
    loadTopSkus(tenantId),
    loadMonthlyRevenue(tenantId),
    loadCustomerStats(tenantId),
    loadChannelMix(tenantId),
  ]);

  // Edge case: tenant heeft 0 orders. Zonder data geen zinvolle patterns.
  if (totals.orders === 0) {
    logger.warn('day_zero.patterns.no_orders', { tenantId });
    const patterns = emptyPatterns('no_orders');
    await upsertPatterns({
      tenantId, patterns, model: FALLBACK_MODEL,
      inputTokens: 0, outputTokens: 0,
    });
    return {
      ok: true, stage: 3, model: FALLBACK_MODEL,
      inputTokens: 0, outputTokens: 0,
      fallback: true, notes: 'no_orders',
    };
  }

  const prompt = buildPrompt({
    onboarding,
    totals,
    topSkus,
    monthlyRevenue,
    customerStats,
    channelMix,
  });

  let response;
  try {
    response = await anthropic.messages.create({
      model:      SONNET_MODEL,
      max_tokens: MAX_OUTPUT_TOKENS,
      messages:   [{ role: 'user', content: prompt }],
    });
  } catch (err) {
    logger.error('day_zero.patterns.api_error', {
      tenantId,
      error: (err as Error).message,
    });
    const patterns = emptyPatterns('api_error');
    await upsertPatterns({
      tenantId, patterns, model: FALLBACK_MODEL,
      inputTokens: 0, outputTokens: 0,
    });
    return {
      ok: false, stage: 3, model: FALLBACK_MODEL,
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
    logger.error('day_zero.patterns.parse_failed', {
      tenantId,
      raw: text.slice(0, 400),
    });
    const patterns = emptyPatterns('parse_error');
    await upsertPatterns({
      tenantId, patterns, model: SONNET_MODEL,
      inputTokens, outputTokens,
    });
    return {
      ok: false, stage: 3, model: SONNET_MODEL,
      inputTokens, outputTokens,
      fallback: true, notes: 'parse_error',
    };
  }

  const patterns = normalizePatterns(parsed, {
    factualTopSkus:  topSkus,
    factualChannels: channelMix,
    totalRevenue:    totals.revenue,
    totalOrders:     totals.orders,
    customerStats,
  });

  await upsertPatterns({
    tenantId, patterns, model: SONNET_MODEL,
    inputTokens, outputTokens,
  });

  // V0 Gap 3c: log when factual product_id fallback was used
  const pidFallbacksUsed = patterns.top_skus.filter((s, i) => {
    const factual = topSkus[i]?.productId ?? null;
    return s.product_id === factual && factual !== null;
  }).length;

  logger.info('day_zero.patterns.complete', {
    tenantId,
    topSkus:                patterns.top_skus.length,
    segments:               patterns.customer_segments.length,
    channels:               patterns.channel_mix.length,
    quality:                patterns.data_quality,
    productIdFallbacksUsed: pidFallbacksUsed,
    inputTokens,
    outputTokens,
  });

  return {
    ok: true, stage: 3, model: SONNET_MODEL,
    inputTokens, outputTokens,
    fallback: false,
    notes: `top_skus=${patterns.top_skus.length} segments=${patterns.customer_segments.length} channels=${patterns.channel_mix.length}`,
  };
}

// ── Aggregate loaders ───────────────────────────────────────

interface Totals {
  orders:   number;
  revenue:  number;     // excl VAT
  aov:      number;
  firstOrderAt: Date | null;
  lastOrderAt:  Date | null;
}

async function loadTotals(tenantId: string): Promise<Totals> {
  const result = await db.query<{
    orders:    string;
    revenue:   string;
    first_at:  Date | null;
    last_at:   Date | null;
  }>(
    `SELECT
       COUNT(*)::text                                         AS orders,
       COALESCE(SUM(total_amount - tax_amount), 0)::text      AS revenue,
       MIN(ordered_at)                                        AS first_at,
       MAX(ordered_at)                                        AS last_at
     FROM orders
     WHERE tenant_id = $1
       AND ordered_at >= now() - INTERVAL '12 months'
       AND COALESCE(status, '') NOT IN ('cancelled', 'refunded')`,
    [tenantId],
    { allowNoTenant: true }
  );

  const row = result.rows[0];
  const orders  = parseInt(row?.orders  ?? '0', 10);
  const revenue = parseFloat(row?.revenue ?? '0');

  return {
    orders,
    revenue,
    aov:          orders > 0 ? revenue / orders : 0,
    firstOrderAt: row?.first_at ?? null,
    lastOrderAt:  row?.last_at  ?? null,
  };
}

async function loadTopSkus(tenantId: string) {
  // GEEN JOIN op products. order_line_items.product_id is een
  // platform-external string (Bol EAN, Shopify product_id), geen
  // UUID die naar products.id wijst. Title staat al in li.title.
  const result = await db.query<{
    product_id:   string | null;
    title:        string;
    revenue:      string;
    units:        string;
  }>(
    `SELECT
       li.product_id,
       MAX(li.title)                              AS title,
       SUM(li.total_price)::text                  AS revenue,
       SUM(li.quantity)::text                     AS units
     FROM order_line_items li
     JOIN orders o ON o.id = li.order_id
     WHERE li.tenant_id = $1
       AND o.ordered_at >= now() - INTERVAL '12 months'
       AND COALESCE(o.status, '') NOT IN ('cancelled', 'refunded')
     GROUP BY li.product_id
     ORDER BY SUM(li.total_price) DESC NULLS LAST
     LIMIT $2`,
    [tenantId, TOP_SKUS_LIMIT],
    { allowNoTenant: true }
  );

  return result.rows.map(r => ({
    productId:  r.product_id,
    title:      r.title,
    revenue:    parseFloat(r.revenue) || 0,
    units:      parseInt(r.units, 10) || 0,
  }));
}

async function loadMonthlyRevenue(tenantId: string) {
  const result = await db.query<{
    year_month:  string;
    month:       number;
    revenue:     string;
    orders:      string;
  }>(
    `SELECT
       TO_CHAR(ordered_at, 'YYYY-MM')                    AS year_month,
       EXTRACT(MONTH FROM ordered_at)::int               AS month,
       SUM(total_amount - tax_amount)::text              AS revenue,
       COUNT(*)::text                                    AS orders
     FROM orders
     WHERE tenant_id = $1
       AND ordered_at >= now() - INTERVAL '12 months'
       AND COALESCE(status, '') NOT IN ('cancelled', 'refunded')
     GROUP BY TO_CHAR(ordered_at, 'YYYY-MM'),
              EXTRACT(MONTH FROM ordered_at)
     ORDER BY year_month ASC`,
    [tenantId],
    { allowNoTenant: true }
  );

  return result.rows.map(r => ({
    yearMonth: r.year_month,
    month:     r.month,
    revenue:   parseFloat(r.revenue) || 0,
    orders:    parseInt(r.orders, 10) || 0,
  }));
}

interface CustomerStats {
  totalCustomers:   number;
  firstOrderCount:  number;
  hasCustomerTable: boolean;
}

async function loadCustomerStats(tenantId: string): Promise<CustomerStats> {
  const result = await db.query<{
    total_customers:    string;
    first_order_count:  string;
  }>(
    `SELECT
       (SELECT COUNT(*)::text FROM customers WHERE tenant_id = $1)
         AS total_customers,
       (SELECT COUNT(*)::text FROM orders
          WHERE tenant_id = $1
            AND COALESCE(is_first_order, false) = true
            AND COALESCE(status, '') NOT IN ('cancelled', 'refunded')
            AND ordered_at >= now() - INTERVAL '12 months')
         AS first_order_count`,
    [tenantId],
    { allowNoTenant: true }
  );

  const row = result.rows[0];
  const totalCustomers  = parseInt(row?.total_customers   ?? '0', 10);
  const firstOrderCount = parseInt(row?.first_order_count ?? '0', 10);

  return {
    totalCustomers,
    firstOrderCount,
    hasCustomerTable: totalCustomers > 0,
  };
}

async function loadChannelMix(tenantId: string) {
  const result = await db.query<{
    platform_slug: string;
    revenue:       string;
    orders:        string;
  }>(
    `SELECT
       COALESCE(platform_slug, 'unknown')               AS platform_slug,
       SUM(total_amount - tax_amount)::text             AS revenue,
       COUNT(*)::text                                   AS orders
     FROM orders
     WHERE tenant_id = $1
       AND ordered_at >= now() - INTERVAL '12 months'
       AND COALESCE(status, '') NOT IN ('cancelled', 'refunded')
       AND COALESCE(platform_slug, '') NOT IN ($2, $3, $4)
     GROUP BY COALESCE(platform_slug, 'unknown')
     ORDER BY SUM(total_amount - tax_amount) DESC`,
    [tenantId, ...STORE_PLATFORM_BLOCKLIST],
    { allowNoTenant: true }
  );

  return result.rows.map(r => ({
    platformSlug: r.platform_slug,
    revenue:      parseFloat(r.revenue) || 0,
    orders:       parseInt(r.orders, 10) || 0,
  }));
}

// ── Prompt construction ─────────────────────────────────────

interface PromptInputs {
  onboarding:      OnboardingContext;
  totals:          Totals;
  topSkus:         { productId: string | null; title: string; revenue: number; units: number }[];
  monthlyRevenue:  { yearMonth: string; month: number; revenue: number; orders: number }[];
  customerStats:   CustomerStats;
  channelMix:      { platformSlug: string; revenue: number; orders: number }[];
}

function buildPrompt(inp: PromptInputs): string {
  const { onboarding, totals, topSkus, monthlyRevenue, customerStats, channelMix } = inp;

  // V0 Gap 3c: explicit PID per line so Sonnet can copy verbatim.
  // The "PID:" prefix makes the identifier visually distinct from
  // the title and reduces confusion with the title field.
  const topSkusText = topSkus.length > 0
    ? topSkus.map((s, i) => {
        const pid = s.productId ?? '(no product_id)';
        return `  ${i + 1}. PID: ${pid} | Title: ${s.title} | Revenue: EUR ${s.revenue.toFixed(2)} | Units: ${s.units}`;
      }).join('\n')
    : '  (no SKU data)';

  const monthlyText = monthlyRevenue.length > 0
    ? monthlyRevenue.map(m =>
        `  ${m.yearMonth}: EUR ${m.revenue.toFixed(2)} (${m.orders} orders)`
      ).join('\n')
    : '  (no monthly data)';

  const channelText = channelMix.length > 0
    ? channelMix.map(c =>
        `  ${c.platformSlug}: EUR ${c.revenue.toFixed(2)} excl VAT, ${c.orders} orders`
      ).join('\n')
    : '  (no channel data)';

  const customerText = customerStats.hasCustomerTable
    ? `  total customers in DB: ${customerStats.totalCustomers}\n  first-time orders (12mo): ${customerStats.firstOrderCount}`
    : `  customer entities not available (likely Bol-only tenant). Infer segments from order patterns and top SKUs.\n  first-time orders (12mo, where flag exists): ${customerStats.firstOrderCount}`;

  return [
    'You are analysing 12 months of ecommerce data for an early-stage founder.',
    'Detect patterns that will drive a marketing plan. Be specific, not generic.',
    '',
    'Founder context (from onboarding):',
    `  country: ${onboarding.countryCode ?? 'unknown'}`,
    `  sells to: ${(onboarding.sellsToCountries ?? []).join(', ') || 'unknown'}`,
    `  business goal: ${onboarding.businessGoal ?? 'unknown'}`,
    `  marketing style: ${onboarding.marketingStyle ?? 'unknown'}`,
    '',
    'Aggregated business data (last 12 months):',
    `  total orders: ${totals.orders}`,
    `  total revenue (excl VAT): EUR ${totals.revenue.toFixed(2)}`,
    `  AOV: EUR ${totals.aov.toFixed(2)}`,
    `  first order date: ${totals.firstOrderAt ?? 'unknown'}`,
    `  last order date: ${totals.lastOrderAt ?? 'unknown'}`,
    '',
    'Top SKUs by revenue (each line lists PID = product_id and Title verbatim):',
    topSkusText,
    '',
    'Monthly revenue:',
    monthlyText,
    '',
    'Customer signals:',
    customerText,
    '',
    'Channel mix (store platforms only, ad accounts excluded):',
    channelText,
    '',
    'Return ONLY a JSON object with this exact shape (no markdown fences, no prose outside JSON):',
    '{',
    '  "top_skus": [',
    '    { "product_id": "...", "title": "...", "revenue_excl_vat": 0, "units_sold": 0, "contribution_pct": 0, "reason": "1 sentence why this is a top sku" }',
    '  ],',
    '  "seasonality": [',
    '    { "month": 1, "index": 1.0, "notable": false }',
    '  ],',
    '  "seasonality_summary": "1 to 2 sentences",',
    '  "customer_segments": [',
    '    { "label": "...", "description": "1 to 2 sentences", "estimated_share_pct": 0, "signals": ["..."] }',
    '  ],',
    '  "channel_mix": [',
    '    { "channel": "...", "revenue_share_pct": 0, "orders_share_pct": 0, "trend": "up" | "down" | "stable" | "unknown" }',
    '  ],',
    '  "key_insights": ["3 to 5 specific insights"],',
    '  "data_quality": "low" | "medium" | "high"',
    '}',
    '',
    'Rules:',
    '- top_skus: copy product_id (PID), title, revenue_excl_vat (= Revenue), units_sold (= Units) VERBATIM from the input lines in the SAME ORDER. Do not invent, abbreviate, or replace product_id with "unknown" or "n/a". If a PID is missing (line shows "(no product_id)"), use null for product_id. The product_id field is a platform-external string (Bol EAN, Shopify product_id) and must be returned exactly as given.',
    '- top_skus: add contribution_pct yourself; the listed SKUs combined sum to 100.',
    '- seasonality: include all 12 months. index 1.0 = year average. Mark notable when index > 1.3 or < 0.7.',
    '- customer_segments: max 3 segments. If customer table is empty, infer from order behaviour and top SKUs.',
    '- channel_mix: one entry per platform_slug from input. Compute shares from totals.',
    '- key_insights: concrete and tied to the data. No generic advice.',
    '- data_quality: low if < 50 orders or < 6 months data, high if > 500 orders and 12 months coverage, else medium.',
  ].join('\n');
}

// ── Parsing + validation ────────────────────────────────────

interface NormalizeContext {
  factualTopSkus:   { productId: string | null; title: string; revenue: number; units: number }[];
  factualChannels:  { platformSlug: string; revenue: number; orders: number }[];
  totalRevenue:     number;
  totalOrders:      number;
  customerStats:    CustomerStats;
}

// V0 Gap 3c: detect Sonnet output that lost product_id fidelity.
// "unknown", "n/a", empty strings and obvious placeholders all
// signal the model dropped the actual identifier.
const SUSPECT_PID_VALUES = new Set([
  'unknown', 'n/a', 'na', 'none', 'null', 'placeholder', '-', '?',
]);

function isSuspectProductId(raw: unknown): boolean {
  if (raw == null) return true;
  const s = String(raw).trim();
  if (s.length === 0) return true;
  return SUSPECT_PID_VALUES.has(s.toLowerCase());
}

function normalizePatterns(parsed: unknown, ctx: NormalizeContext): Patterns {
  const obj = (parsed && typeof parsed === 'object')
    ? parsed as Record<string, unknown>
    : {};

  const topSkus: TopSku[] = Array.isArray(obj.top_skus)
    ? obj.top_skus.slice(0, TOP_SKUS_LIMIT).map((s: unknown, i: number) => {
        const o = s as Record<string, unknown>;

        // V0 Gap 3c: factual fallback for product_id. If Sonnet
        // returned a placeholder ("unknown", "n/a", empty) or null,
        // restore the real identifier from loadTopSkus() based on
        // positional order (prompt asks Sonnet to preserve order).
        let productId: string | null = null;
        if (isSuspectProductId(o.product_id)) {
          productId = ctx.factualTopSkus[i]?.productId ?? null;
          if (productId) {
            logger.info('day_zero.patterns.pid_fallback_applied', {
              position:        i,
              suspectValue:    String(o.product_id ?? '').slice(0, 32),
              factualValue:    productId.slice(0, 32),
            });
          }
        } else {
          productId = String(o.product_id).slice(0, 64);
        }

        return {
          product_id:        productId,
          title:             String(o.title ?? '').slice(0, 200),
          revenue_excl_vat:  toNum(o.revenue_excl_vat),
          units_sold:        Math.round(toNum(o.units_sold)),
          contribution_pct:  clampPct(toNum(o.contribution_pct)),
          reason:            String(o.reason ?? '').slice(0, 300),
        };
      })
    : [];

  const seasonality: SeasonalityMonth[] = Array.isArray(obj.seasonality)
    ? obj.seasonality.slice(0, 12).map((s: unknown) => {
        const o = s as Record<string, unknown>;
        const month = Math.max(1, Math.min(12, Math.round(toNum(o.month))));
        return {
          month,
          index:    Number.isFinite(toNum(o.index)) ? toNum(o.index) : 1.0,
          notable:  Boolean(o.notable),
        };
      })
    : [];

  const customerSegments: CustomerSegment[] = Array.isArray(obj.customer_segments)
    ? obj.customer_segments.slice(0, 3).map((s: unknown) => {
        const o = s as Record<string, unknown>;
        return {
          label:                String(o.label                ?? '').slice(0, 80),
          description:          String(o.description          ?? '').slice(0, 400),
          estimated_share_pct:  clampPct(toNum(o.estimated_share_pct)),
          signals:              Array.isArray(o.signals)
            ? o.signals.slice(0, 5).map(x => String(x).slice(0, 200))
            : [],
        };
      })
    : [];

  const channelMix: ChannelMix[] = Array.isArray(obj.channel_mix)
    ? obj.channel_mix.slice(0, 10).map((c: unknown) => {
        const o = c as Record<string, unknown>;
        const trend = String(o.trend ?? 'unknown').toLowerCase();
        return {
          channel:            String(o.channel ?? '').slice(0, 60),
          revenue_share_pct:  clampPct(toNum(o.revenue_share_pct)),
          orders_share_pct:   clampPct(toNum(o.orders_share_pct)),
          trend:              ['up', 'down', 'stable', 'unknown'].includes(trend)
                                ? (trend as ChannelMix['trend'])
                                : 'unknown',
        };
      })
    : [];

  const keyInsights: string[] = Array.isArray(obj.key_insights)
    ? obj.key_insights.slice(0, 5).map(x => String(x).slice(0, 400))
    : [];

  const dataQuality = ['low', 'medium', 'high'].includes(String(obj.data_quality))
    ? (String(obj.data_quality) as Confidence)
    : 'medium';

  return {
    top_skus:              topSkus,
    seasonality,
    seasonality_summary:   String(obj.seasonality_summary ?? '').slice(0, 400),
    customer_segments:     customerSegments,
    channel_mix:           channelMix,
    key_insights:          keyInsights,
    data_quality:          dataQuality,
  };
}

function toNum(v: unknown): number {
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
  if (typeof v === 'string') {
    const n = parseFloat(v);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

function clampPct(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, n));
}

// ── Empty fallback ──────────────────────────────────────────

function emptyPatterns(reason: 'no_orders' | 'parse_error' | 'api_error'): Patterns {
  const reasonText: Record<typeof reason, string> = {
    no_orders:    'No orders in last 12 months. Patterns will be generated after first sales.',
    parse_error:  'Pattern detection returned invalid JSON. Defaults applied.',
    api_error:    'Pattern detection call failed. Defaults applied.',
  };

  return {
    top_skus:             [],
    seasonality:          [],
    seasonality_summary:  reasonText[reason],
    customer_segments:    [],
    channel_mix:          [],
    key_insights:         [reasonText[reason]],
    data_quality:         'low',
  };
}
