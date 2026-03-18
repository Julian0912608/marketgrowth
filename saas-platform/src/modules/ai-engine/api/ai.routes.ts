import { Router, Request, Response, NextFunction } from 'express';
import Anthropic from '@anthropic-ai/sdk';
import { db } from '../../../infrastructure/database/connection';
import { cache } from '../../../infrastructure/cache/redis';
import { getTenantContext } from '../../../shared/middleware/tenant-context';
import { tenantMiddleware } from '../../../shared/middleware/tenant.middleware';
import { logger } from '../../../shared/logging/logger';

const router = Router();
router.use(tenantMiddleware());

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const CACHE_TTL: Record<string, number> = {
  starter: 86400,
  growth:  3600,
  scale:   3600,
};

// ── GET /api/ai/insights ─────────────────────────────────────
router.get('/insights', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { tenantId, planSlug } = getTenantContext();
    const force = req.query.force === 'true';
    const cacheKey = 'ai:insights:' + tenantId;

    // Cache check (overgeslagen bij force=true)
    if (!force) {
      const cached = await cache.get(cacheKey);
      if (cached) {
        return res.json({ ...JSON.parse(cached), fromCache: true });
      }
    }

    // Verkoopdata ophalen
    const [ordersResult, productsResult, integrationsResult] = await Promise.all([
      db.query(
        `SELECT
           COUNT(*)::int AS total_orders,
           COALESCE(SUM(o.total_amount - o.tax_amount), 0) AS revenue,
           COALESCE(AVG(o.total_amount - o.tax_amount), 0) AS avg_order_value
         FROM orders o
         WHERE o.tenant_id = $1
           AND o.ordered_at >= NOW() - INTERVAL '30 days'
           AND o.status NOT IN ('cancelled', 'refunded')`,
        [tenantId], { allowNoTenant: true }
      ),
      db.query(
        `SELECT oli.title, SUM(oli.quantity)::int AS sold, SUM(oli.total_price) AS revenue
         FROM order_line_items oli
         JOIN orders o ON o.id = oli.order_id
         WHERE oli.tenant_id = $1
           AND o.ordered_at >= NOW() - INTERVAL '30 days'
           AND o.status NOT IN ('cancelled', 'refunded')
           AND oli.total_price > 0
         GROUP BY oli.title
         ORDER BY revenue DESC
         LIMIT 5`,
        [tenantId], { allowNoTenant: true }
      ),
      db.query(
        `SELECT platform_slug FROM tenant_integrations WHERE tenant_id = $1 AND status != 'disconnected'`,
        [tenantId], { allowNoTenant: true }
      ),
    ]);

    const stats       = ordersResult.rows[0];
    const topProducts = productsResult.rows;
    const integrations = integrationsResult.rows;

    // Geen integraties → vraag om te koppelen
    if (integrations.length === 0) {
      return res.json({
        briefing: 'Koppel je eerste winkel om AI-inzichten te ontvangen. Ga naar Integraties om Bol.com, Shopify of een ander platform te verbinden.',
        actions:  [{ priority: 'high', title: 'Koppel je winkel', description: 'Ga naar de Integraties pagina om je eerste verkoopkanaal te verbinden.' }],
        alerts:   [],
        fromCache: false,
      });
    }

    const platformNames = integrations.map((i: any) => i.platform_slug).join(', ');
    const hasOrders     = parseInt(stats.total_orders) > 0;

    const prompt = hasOrders
      ? 'Je bent een ecommerce AI adviseur. Analyseer deze verkoopdata van de afgelopen 30 dagen en geef concrete, actiegerichte inzichten in het Nederlands.\n\n' +
        'Verkoopdata:\n' +
        '- Totaal orders: ' + stats.total_orders + '\n' +
        '- Omzet (excl. BTW): \u20ac' + parseFloat(stats.revenue).toFixed(2) + '\n' +
        '- Gemiddelde orderwaarde: \u20ac' + parseFloat(stats.avg_order_value).toFixed(2) + '\n' +
        '- Gekoppelde platforms: ' + platformNames + '\n' +
        '- Top producten: ' + topProducts.map((p: any) => p.title + ' (' + p.sold + 'x, \u20ac' + parseFloat(p.revenue).toFixed(2) + ')').join(', ') + '\n\n' +
        'Geef een JSON response met exact deze structuur (geen markdown, alleen JSON):\n' +
        '{"briefing":"2-3 zinnen samenvatting","actions":[{"priority":"high","title":"Titel","description":"Beschrijving"},{"priority":"medium","title":"Titel","description":"Beschrijving"},{"priority":"low","title":"Titel","description":"Beschrijving"}],"alerts":["Waarschuwing of lege array"]}'
      : 'Je bent een ecommerce AI adviseur. De gebruiker heeft ' + integrations.length + ' winkel(s) gekoppeld (' + platformNames + ') maar nog geen orders de afgelopen 30 dagen.\n\n' +
        'Geef een motiverende briefing in het Nederlands als JSON (geen markdown, alleen JSON):\n' +
        '{"briefing":"Positieve boodschap dat setup goed staat","actions":[{"priority":"high","title":"Wacht op eerste orders","description":"Je winkel is gekoppeld. Zodra orders binnenkomen zie je hier je inzichten."},{"priority":"medium","title":"Controleer sync status","description":"Ga naar Integraties en check of de sync actief is."}],"alerts":[]}';

    const response = await anthropic.messages.create({
      model:      'claude-sonnet-4-20250514',
      max_tokens: 1000,
      messages:   [{ role: 'user', content: prompt }],
    });

    const text  = response.content[0].type === 'text' ? response.content[0].text : '';
    const clean = text.replace(/```json|```/g, '').trim();

    let parsed;
    try {
      parsed = JSON.parse(clean);
    } catch {
      parsed = { briefing: text.slice(0, 300), actions: [], alerts: [] };
    }

    // Cache opslaan
    await cache.set(cacheKey, JSON.stringify(parsed), CACHE_TTL[planSlug] || 3600);

    // Credit bijhouden
    try {
      await db.query(
        'INSERT INTO feature_usage (tenant_id, feature_id, period_start, period_end, usage_count) ' +
        "SELECT $1, f.id, date_trunc('month', now()), (date_trunc('month', now()) + interval '1 month - 1 day')::date, 1 " +
        "FROM features f WHERE f.slug = 'ai-recommendations' " +
        'ON CONFLICT (tenant_id, feature_id, period_start) ' +
        'DO UPDATE SET usage_count = feature_usage.usage_count + 1, updated_at = now()',
        [tenantId], { allowNoTenant: true }
      );
    } catch {}

    logger.info('ai.insights.generated', { tenantId, planSlug, hasOrders, force });
    res.json({ ...parsed, fromCache: false });
  } catch (err) { next(err); }
});

// ── POST /api/ai/chat ────────────────────────────────────────
router.post('/chat', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { tenantId, planSlug } = getTenantContext();

    if (planSlug === 'starter') {
      res.status(403).json({ error: 'AI Chat is beschikbaar vanaf het Growth plan.' });
      return;
    }

    const { message } = req.body;
    if (!message) { res.status(400).json({ error: 'Bericht is verplicht' }); return; }

    const ordersResult = await db.query(
      'SELECT COUNT(*)::int AS orders, COALESCE(SUM(total_amount - tax_amount), 0) AS revenue ' +
      "FROM orders WHERE tenant_id = $1 AND ordered_at >= NOW() - INTERVAL '30 days' " +
      "AND status NOT IN ('cancelled', 'refunded')",
      [tenantId], { allowNoTenant: true }
    );
    const stats = ordersResult.rows[0];

    const response = await anthropic.messages.create({
      model:      'claude-sonnet-4-20250514',
      max_tokens: 500,
      system:     'Je bent een ecommerce AI adviseur voor MarketGrow. De gebruiker heeft ' + stats.orders + ' orders en \u20ac' + parseFloat(stats.revenue).toFixed(2) + ' omzet de afgelopen 30 dagen. Antwoord altijd in het Nederlands, beknopt en actionabel.',
      messages:   [{ role: 'user', content: message }],
    });

    const text = response.content[0].type === 'text' ? response.content[0].text : '';

    try {
      await db.query(
        'INSERT INTO feature_usage (tenant_id, feature_id, period_start, period_end, usage_count) ' +
        "SELECT $1, f.id, date_trunc('month', now()), (date_trunc('month', now()) + interval '1 month - 1 day')::date, 1 " +
        "FROM features f WHERE f.slug = 'ai-recommendations' " +
        'ON CONFLICT (tenant_id, feature_id, period_start) ' +
        'DO UPDATE SET usage_count = feature_usage.usage_count + 1, updated_at = now()',
        [tenantId], { allowNoTenant: true }
      );
    } catch {}

    res.json({ response: text });
  } catch (err) { next(err); }
});

// ── GET /api/ai/credits ──────────────────────────────────────
router.get('/credits', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { tenantId, planSlug } = getTenantContext();

    const limits: Record<string, number | null> = {
      starter: 500,
      growth:  5000,
      scale:   null,
    };
    const limit = limits[planSlug] ?? 500;

    const usageResult = await db.query(
      'SELECT COALESCE(fu.usage_count, 0) AS used ' +
      'FROM feature_usage fu JOIN features f ON f.id = fu.feature_id ' +
      "WHERE fu.tenant_id = $1 AND f.slug = 'ai-recommendations' " +
      "AND fu.period_start = date_trunc('month', now())",
      [tenantId], { allowNoTenant: true }
    );

    const used      = parseInt(usageResult.rows[0]?.used || '0');
    const unlimited = limit === null;

    res.json({
      used,
      limit,
      remaining: unlimited ? null : Math.max(0, limit - used),
      unlimited,
    });
  } catch (err) { next(err); }
});
// ── POST /api/ai/social-content ──────────────────────────────
// Voeg dit toe aan saas-platform/src/modules/ai-engine/api/ai.routes.ts
// Plak dit blok direct VOOR de export { router as aiRouter } regel

router.post('/social-content', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { tenantId, planSlug } = getTenantContext();

    // Alleen Growth+ heeft toegang
    if (planSlug === 'starter') {
      res.status(403).json({ error: 'Social Content Generator is available on Growth and Scale plans.' });
      return;
    }

    const { platform, tone, topic, customContext, count = 3 } = req.body as {
      platform:      'instagram' | 'tiktok';
      tone:          'educational' | 'inspirational' | 'data-driven' | 'behind-the-scenes';
      topic:         string;
      customContext?: string;
      count?:        number;
    };

    // Haal echte store data op om posts te personaliseren
    const [ordersResult, adsResult, integrationsResult] = await Promise.all([
      db.query(
        `SELECT
           COUNT(*)::int                              AS total_orders,
           COALESCE(SUM(total_amount - tax_amount),0) AS revenue,
           COALESCE(AVG(total_amount - tax_amount),0) AS avg_order_value
         FROM orders
         WHERE tenant_id = $1
           AND ordered_at >= NOW() - INTERVAL '30 days'
           AND status NOT IN ('cancelled','refunded')`,
        [tenantId], { allowNoTenant: true }
      ),
      db.query(
        `SELECT
           COALESCE(SUM(spend),0)       AS total_spend,
           COALESCE(SUM(revenue),0)     AS total_ad_revenue,
           COALESCE(AVG(roas),0)        AS avg_roas,
           COALESCE(SUM(impressions),0) AS total_impressions,
           COALESCE(SUM(clicks),0)      AS total_clicks
         FROM ad_campaigns
         WHERE tenant_id = $1
           AND updated_at >= NOW() - INTERVAL '30 days'`,
        [tenantId], { allowNoTenant: true }
      ),
      db.query(
        `SELECT platform_slug FROM tenant_integrations WHERE tenant_id = $1 AND status = 'active'`,
        [tenantId], { allowNoTenant: true }
      ),
    ]);

    const orders       = ordersResult.rows[0];
    const ads          = adsResult.rows[0];
    const platforms    = integrationsResult.rows.map((r: any) => r.platform_slug).join(', ');

    const toneGuide: Record<string, string> = {
      'educational':       'Teach the audience something actionable. Use clear steps or insights.',
      'inspirational':     'Motivate and inspire. Focus on results, transformation, and possibilities.',
      'data-driven':       'Lead with a surprising or compelling statistic. Let numbers do the talking.',
      'behind-the-scenes': 'Be authentic, relatable, and transparent. Share real experiences.',
    };

    const topicGuide: Record<string, string> = {
      'roas':                'Return on ad spend, ad profitability, knowing your numbers',
      'product-performance': 'Which products sell best, product analytics, revenue per product',
      'ads-tips':            'Advertising tips for ecommerce, campaign optimisation, Meta/Google/TikTok ads',
      'ecommerce-growth':    'Growing an ecommerce business, scaling, multi-channel selling',
      'platform-insights':   'Selling on Shopify, Bol.com, Amazon, Etsy — platform-specific insights',
    };

    const platformGuide: Record<string, string> = {
      instagram: 'Instagram caption style: conversational, line breaks for readability, emojis allowed, strong hook in first line. 15-20 hashtags.',
      tiktok:    'TikTok caption style: very short and punchy, hook must be irresistible, CTA to follow or comment. 5-8 hashtags.',
    };

    const storeContext = `
Real store data (use this to make posts feel authentic and specific):
- Orders last 30 days: ${orders.total_orders}
- Revenue last 30 days: €${parseFloat(orders.revenue).toFixed(0)}
- Average order value: €${parseFloat(orders.avg_order_value).toFixed(0)}
- Ad spend last 30 days: €${parseFloat(ads.total_spend).toFixed(0)}
- Ad revenue (attributed): €${parseFloat(ads.total_ad_revenue).toFixed(0)}
- Average ROAS: ${parseFloat(ads.avg_roas).toFixed(2)}x
- Total impressions: ${parseInt(ads.total_impressions).toLocaleString()}
- Connected platforms: ${platforms || 'not specified'}
${customContext ? `\nAdditional context from the user: ${customContext}` : ''}
    `.trim();

    const prompt = `You are a social media content expert for ecommerce entrepreneurs. Create ${count} unique, high-quality social media post(s) for ${platform}.

TOPIC: ${topicGuide[topic] || topic}
TONE: ${toneGuide[tone] || tone}
PLATFORM STYLE: ${platformGuide[platform]}

${storeContext}

IMPORTANT RULES:
- Write in English
- Each post must feel real, specific, and valuable — not generic
- Use the store data naturally (don't just list numbers, tell a story)
- The hook must stop the scroll — make it unexpected or counterintuitive
- No corporate language. Write like a founder talking to other founders
- CTA should be natural, not pushy

Return ONLY a valid JSON array with exactly ${count} post object(s). No markdown, no explanation, just JSON:
[
  {
    "hook": "First line that stops the scroll (1-2 sentences max)",
    "caption": "Main body of the post (3-6 sentences, use line breaks)",
    "cta": "Call to action (1 sentence)",
    "hashtags": ["hashtag1", "hashtag2", "hashtag3"]
  }
]`;

    const response = await anthropic.messages.create({
      model:      'claude-sonnet-4-20250514',
      max_tokens: 2000,
      messages:   [{ role: 'user', content: prompt }],
    });

    const text  = response.content[0].type === 'text' ? response.content[0].text : '[]';
    const clean = text.replace(/```json|```/g, '').trim();

    let posts;
    try {
      posts = JSON.parse(clean);
      if (!Array.isArray(posts)) posts = [posts];
    } catch {
      posts = [];
    }

    // Credit bijhouden
    try {
      await db.query(
        `INSERT INTO feature_usage (tenant_id, feature_id, period_start, period_end, usage_count)
         SELECT $1, f.id, date_trunc('month', now()),
                (date_trunc('month', now()) + interval '1 month - 1 day')::date, $2
         FROM features f WHERE f.slug = 'ai-recommendations'
         ON CONFLICT (tenant_id, feature_id, period_start)
         DO UPDATE SET usage_count = feature_usage.usage_count + $2, updated_at = now()`,
        [tenantId, count],
        { allowNoTenant: true }
      );
    } catch {}

    logger.info('ai.social-content.generated', { tenantId, platform, tone, topic, count });
    res.json({ posts });

  } catch (err) { next(err); }
});
export { router as aiRouter };
