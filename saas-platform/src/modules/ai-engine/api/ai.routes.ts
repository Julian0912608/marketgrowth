// ============================================================
// src/modules/ai-engine/api/ai.routes.ts
//
// AI Insights endpoints — gebruikt Anthropic Claude API
// Plan gating: Starter = weekly, Growth = daily, Scale = on-demand
// ============================================================

import { Router, Request, Response, NextFunction } from 'express';
import { tenantMiddleware } from '../../../shared/middleware/tenant.middleware';
import { getTenantContext } from '../../../shared/middleware/tenant-context';
import { db } from '../../../infrastructure/database/connection';
import { logger } from '../../../shared/logging/logger';
import { cache } from '../../../infrastructure/cache/redis';

export const aiRouter = Router();

aiRouter.use(tenantMiddleware());

// ── GET /api/ai/insights ──────────────────────────────────────
// Haal de dagelijkse AI briefing op (of genereer een nieuwe)
aiRouter.get('/insights', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { tenantId, planSlug } = getTenantContext();
    const forceRefresh = req.query.refresh === 'true';

    // Cache key — per tenant per dag
    const today = new Date().toISOString().split('T')[0];
    const cacheKey = cache.key(tenantId, 'ai-insights', today);

    // Check cache (tenzij force refresh)
    if (!forceRefresh) {
      const cached = await cache.getJson<AiInsightResponse>(cacheKey);
      if (cached) {
        return res.json({ ...cached, fromCache: true });
      }
    }

    // Haal verkoopsdata op voor context
    const salesData = await getSalesContext(tenantId);
    const hasData   = salesData.totalOrders > 0;

    // Genereer insights via Claude API
    const insights = await generateInsights(tenantId, planSlug, salesData, hasData);

    // Sla op in cache (24 uur voor Starter/Growth, 1 uur voor Scale)
    const ttl = planSlug === 'scale' ? 3600 : 86400;
    await cache.setJson(cacheKey, insights, ttl);

    // Log credit gebruik
    await trackAiCredit(tenantId);

    res.json({ ...insights, fromCache: false });
  } catch (err) { next(err); }
});

// ── POST /api/ai/chat ─────────────────────────────────────────
// On-demand AI chat — alleen Growth en Scale
aiRouter.post('/chat', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { tenantId, planSlug } = getTenantContext();

    if (planSlug === 'starter') {
      return res.status(403).json({
        error: 'upgrade_required',
        message: 'AI chat is available from the Growth plan.',
        requiredPlan: 'growth',
      });
    }

    const { message } = req.body as { message: string };
    if (!message?.trim()) {
      return res.status(400).json({ error: 'message is required' });
    }

    const salesData = await getSalesContext(tenantId);
    const reply     = await chatWithClaude(message, salesData, planSlug);

    await trackAiCredit(tenantId);

    res.json({ reply, timestamp: new Date().toISOString() });
  } catch (err) { next(err); }
});

// ── GET /api/ai/credits ───────────────────────────────────────
// Hoeveel AI credits heeft deze tenant nog?
aiRouter.get('/credits', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { tenantId, planSlug } = getTenantContext();

    const limits: Record<string, number | null> = {
      starter: 500,
      growth:  5000,
      scale:   null, // unlimited
    };

    const limit = limits[planSlug] ?? 500;

    // Tel gebruik deze maand
    const periodStart = new Date();
    periodStart.setDate(1);
    periodStart.setHours(0, 0, 0, 0);

    const result = await db.query<{ usage_count: string }>(
      `SELECT COALESCE(SUM(usage_count), 0)::text AS usage_count
       FROM feature_usage fu
       JOIN features f ON f.id = fu.feature_id
       WHERE fu.tenant_id = $1
         AND f.slug = 'ai-recommendations'
         AND fu.period_start >= $2`,
      [tenantId, periodStart],
      { allowNoTenant: true }
    );

    const used = parseInt(result.rows[0]?.usage_count ?? '0');

    res.json({
      used,
      limit,
      remaining: limit === null ? null : Math.max(0, limit - used),
      unlimited: limit === null,
      resetDate: new Date(new Date().getFullYear(), new Date().getMonth() + 1, 1).toISOString(),
    });
  } catch (err) { next(err); }
});

// ── Helpers ───────────────────────────────────────────────────

interface SalesContext {
  totalRevenue:    number;
  totalOrders:     number;
  avgOrderValue:   number;
  topProducts:     { title: string; revenue: number; units: number }[];
  platforms:       { platform: string; revenue: number; orders: number }[];
  revenueLastWeek: number;
  revenueThisWeek: number;
  currency:        string;
}

async function getSalesContext(tenantId: string): Promise<SalesContext> {
  try {
    const thirtyDaysAgo = new Date(Date.now() - 30 * 86400000);
    const sevenDaysAgo  = new Date(Date.now() - 7  * 86400000);
    const twoWeeksAgo   = new Date(Date.now() - 14 * 86400000);

    const [summary, products, platforms, weekComparison] = await Promise.all([
      // Totalen afgelopen 30 dagen
      db.query<{ total_revenue: string; total_orders: string; avg_order_value: string; currency: string }>(
        `SELECT COALESCE(SUM(total_amount), 0)::text AS total_revenue,
                COUNT(*)::text AS total_orders,
                COALESCE(AVG(total_amount), 0)::text AS avg_order_value,
                COALESCE(MAX(currency), 'EUR') AS currency
         FROM orders
         WHERE tenant_id = $1 AND ordered_at >= $2 AND status = 'completed'`,
        [tenantId, thirtyDaysAgo],
        { allowNoTenant: true }
      ),
      // Top 5 producten
      db.query<{ title: string; revenue: string; units: string }>(
        `SELECT oli.title,
                SUM(oli.total_price)::text AS revenue,
                SUM(oli.quantity)::text AS units
         FROM order_line_items oli
         JOIN orders o ON o.id = oli.order_id
         WHERE oli.tenant_id = $1 AND o.ordered_at >= $2 AND o.status = 'completed'
         GROUP BY oli.title ORDER BY revenue DESC LIMIT 5`,
        [tenantId, thirtyDaysAgo],
        { allowNoTenant: true }
      ),
      // Per platform
      db.query<{ platform: string; revenue: string; orders: string }>(
        `SELECT platform_slug AS platform,
                SUM(total_amount)::text AS revenue,
                COUNT(*)::text AS orders
         FROM orders
         WHERE tenant_id = $1 AND ordered_at >= $2 AND status = 'completed'
         GROUP BY platform_slug ORDER BY revenue DESC`,
        [tenantId, thirtyDaysAgo],
        { allowNoTenant: true }
      ),
      // Week-over-week vergelijking
      db.query<{ last_week: string; this_week: string }>(
        `SELECT
           COALESCE(SUM(CASE WHEN ordered_at >= $2 AND ordered_at < $3 THEN total_amount END), 0)::text AS last_week,
           COALESCE(SUM(CASE WHEN ordered_at >= $3 THEN total_amount END), 0)::text AS this_week
         FROM orders
         WHERE tenant_id = $1 AND ordered_at >= $2 AND status = 'completed'`,
        [tenantId, twoWeeksAgo, sevenDaysAgo],
        { allowNoTenant: true }
      ),
    ]);

    const s = summary.rows[0];
    const w = weekComparison.rows[0];

    return {
      totalRevenue:    parseFloat(s?.total_revenue ?? '0'),
      totalOrders:     parseInt(s?.total_orders ?? '0'),
      avgOrderValue:   parseFloat(s?.avg_order_value ?? '0'),
      currency:        s?.currency ?? 'EUR',
      revenueLastWeek: parseFloat(w?.last_week ?? '0'),
      revenueThisWeek: parseFloat(w?.this_week ?? '0'),
      topProducts:     products.rows.map(p => ({
        title:   p.title,
        revenue: parseFloat(p.revenue),
        units:   parseInt(p.units),
      })),
      platforms: platforms.rows.map(p => ({
        platform: p.platform,
        revenue:  parseFloat(p.revenue),
        orders:   parseInt(p.orders),
      })),
    };
  } catch {
    return {
      totalRevenue: 0, totalOrders: 0, avgOrderValue: 0,
      currency: 'EUR', revenueLastWeek: 0, revenueThisWeek: 0,
      topProducts: [], platforms: [],
    };
  }
}

interface AiInsightResponse {
  briefing:        string;
  actions:         { priority: 'high' | 'medium' | 'low'; title: string; description: string }[];
  opportunities:   string[];
  alerts:          string[];
  generatedAt:     string;
  planSlug:        string;
  hasData:         boolean;
}

async function generateInsights(
  tenantId: string,
  planSlug: string,
  data: SalesContext,
  hasData: boolean
): Promise<AiInsightResponse> {

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY niet ingesteld');

  const wowChange = data.revenueLastWeek > 0
    ? ((data.revenueThisWeek - data.revenueLastWeek) / data.revenueLastWeek * 100).toFixed(1)
    : null;

  const systemPrompt = `Je bent een AI business analyst voor ecommerce ondernemers.
Je analyseert verkoopsdata en geeft concrete, actiegerichte adviezen in het Nederlands.
Wees direct, specifiek en positief maar eerlijk. Geen vaagtaal.
Antwoord ALLEEN in dit exacte JSON formaat zonder markdown of uitleg:
{
  "briefing": "2-3 zinnen samenvatting van de huidige situatie",
  "actions": [
    {"priority": "high|medium|low", "title": "Actie titel", "description": "Concrete actie die ondernomen kan worden"}
  ],
  "opportunities": ["Kans 1", "Kans 2"],
  "alerts": ["Alert als iets aandacht nodig heeft"]
}`;

  const userPrompt = hasData
    ? `Analyseer deze ecommerce data van de afgelopen 30 dagen en geef advies:

OMZET: €${data.totalRevenue.toFixed(2)} (${data.totalOrders} orders, gem. €${data.avgOrderValue.toFixed(2)})
WEEK-OVER-WEEK: ${wowChange ? `${wowChange}% (vorige week €${data.revenueLastWeek.toFixed(2)} → deze week €${data.revenueThisWeek.toFixed(2)})` : 'Geen vergelijkingsdata'}
TOP PRODUCTEN: ${data.topProducts.map(p => `${p.title} (€${p.revenue.toFixed(0)}, ${p.units}x)`).join(', ') || 'Geen data'}
PLATFORMS: ${data.platforms.map(p => `${p.platform}: €${p.revenue.toFixed(0)}`).join(', ') || 'Geen data'}

Geef ${planSlug === 'starter' ? '2-3' : '4-5'} concrete acties. Focus op wat NU gedaan kan worden.`
    : `Deze ondernemer heeft nog geen verkoopsdata gekoppeld. Geef advies over:
1. Hoe ze het meeste uit MarketGrow halen door hun winkel te koppelen
2. Wat voor inzichten ze kunnen verwachten
3. Eerste stappen na het koppelen
Wees bemoedigend en praktisch.`;

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model:      'claude-sonnet-4-20250514',
      max_tokens: 1000,
      system:     systemPrompt,
      messages:   [{ role: 'user', content: userPrompt }],
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    logger.error('ai.insights.api_error', { status: response.status, error: err });
    throw new Error(`Claude API fout: ${response.status}`);
  }

  const result = await response.json() as { content: { type: string; text: string }[] };
  const text   = result.content.find(b => b.type === 'text')?.text ?? '{}';

  let parsed: any;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Fallback als JSON niet parseable is
    parsed = {
      briefing:      text.substring(0, 200),
      actions:       [],
      opportunities: [],
      alerts:        [],
    };
  }

  return {
    briefing:      parsed.briefing      ?? '',
    actions:       parsed.actions       ?? [],
    opportunities: parsed.opportunities ?? [],
    alerts:        parsed.alerts        ?? [],
    generatedAt:   new Date().toISOString(),
    planSlug,
    hasData,
  };
}

async function chatWithClaude(
  message: string,
  data: SalesContext,
  planSlug: string
): Promise<string> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY niet ingesteld');

  const context = data.totalOrders > 0
    ? `Verkoopscontext: €${data.totalRevenue.toFixed(2)} omzet, ${data.totalOrders} orders afgelopen 30 dagen.`
    : 'Nog geen verkoopsdata beschikbaar.';

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model:      'claude-sonnet-4-20250514',
      max_tokens: 500,
      system:     `Je bent een AI ecommerce assistent voor MarketGrow. ${context} Geef korte, praktische antwoorden in het Nederlands.`,
      messages:   [{ role: 'user', content: message }],
    }),
  });

  if (!response.ok) throw new Error(`Claude API fout: ${response.status}`);

  const result = await response.json() as { content: { type: string; text: string }[] };
  return result.content.find(b => b.type === 'text')?.text ?? 'Geen antwoord ontvangen.';
}

async function trackAiCredit(tenantId: string): Promise<void> {
  try {
    const periodStart = new Date();
    periodStart.setDate(1);
    periodStart.setHours(0, 0, 0, 0);
    const periodEnd = new Date(periodStart.getFullYear(), periodStart.getMonth() + 1, 1);

    await db.query(
      `INSERT INTO feature_usage (tenant_id, feature_id, period_start, period_end, usage_count)
       SELECT $1, f.id, $2, $3, 1
       FROM features f WHERE f.slug = 'ai-recommendations'
       ON CONFLICT (tenant_id, feature_id, period_start)
       DO UPDATE SET usage_count = feature_usage.usage_count + 1, updated_at = now()`,
      [tenantId, periodStart, periodEnd],
      { allowNoTenant: true }
    );
  } catch (err) {
    logger.warn('ai.credit_tracking.failed', { tenantId, error: (err as Error).message });
  }
}
