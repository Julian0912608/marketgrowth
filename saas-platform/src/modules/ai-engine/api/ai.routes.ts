// ============================================================
// src/modules/ai-engine/api/ai.routes.ts
//
// Alle AI routes:
//   GET  /api/ai/insights          — dagelijkse AI briefing
//   GET  /api/ai/credits           — AI credit gebruik
//   POST /api/ai/chat              — AI chat (Growth+)
//   POST /api/ai/social-content    — social media content genereren
//   POST /api/ai/generate-image    — AI marketing beeld (Gemini)
//   POST /api/ai/video-script      — video script (intern/owner)
//   GET  /api/ai/products          — producten voor content studio
//   POST /api/ai/product-content   — product marketing content + beeld
// ============================================================

import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { tenantMiddleware }  from '../../../shared/middleware/tenant.middleware';
import { featureGate }       from '../../../shared/middleware/feature-gate.middleware';
import { getTenantContext }  from '../../../shared/middleware/tenant-context';
import { db }                from '../../../infrastructure/database/connection';
import { cache }             from '../../../infrastructure/cache/redis';
import { logger }            from '../../../shared/logging/logger';

const router = Router();
router.use(tenantMiddleware());

const anthropic = require('@anthropic-ai/sdk').default
  ? new (require('@anthropic-ai/sdk').default)({ apiKey: process.env.ANTHROPIC_API_KEY })
  : new (require('@anthropic-ai/sdk').Anthropic)({ apiKey: process.env.ANTHROPIC_API_KEY });

const CACHE_TTL: Record<string, number> = { starter: 3600, growth: 1800, scale: 900 };

// ── Zod schemas ───────────────────────────────────────────────

const ChatSchema = z.object({
  message: z.string().min(1).max(2000),
});

const SocialContentSchema = z.object({
  platform:      z.enum(['instagram', 'tiktok']),
  tone:          z.enum(['educational', 'inspirational', 'data-driven', 'behind-the-scenes']),
  topic:         z.string().min(1).max(200),
  format:        z.enum(['single', 'carousel', 'video_script']).optional().default('single'),
  customContext: z.string().max(500).optional(),
  count:         z.number().int().min(1).max(7).optional().default(3),
});

const GenerateImageSchema = z.object({
  prompt:     z.string().min(1).max(1000),
  slideTitle: z.string().max(200).optional(),
  slideBody:  z.string().max(2000).optional(),
  index:      z.number().int().min(0).max(20).optional().default(0),
});

const VideoScriptSchema = z.object({
  scenario: z.object({
    store:      z.string().max(100),
    revenue:    z.string().max(50),
    adSpend:    z.string().max(50),
    realRoas:   z.string().max(20),
    metaRoas:   z.string().max(20),
    googleRoas: z.string().max(20),
    bolRoas:    z.string().max(20),
    insight:    z.string().max(300),
    campaigns:  z.number().int().min(0),
    topProduct: z.string().max(100),
    margin:     z.string().max(20),
  }),
  format: z.object({
    label: z.string().max(50),
    words: z.number().int().min(1).max(500),
  }),
  angle: z.object({
    id:    z.string().max(50),
    label: z.string().max(100),
  }),
  index: z.number().int().min(0).max(10).optional().default(0),
  total: z.number().int().min(1).max(10).optional().default(1),
});

const ProductContentSchema = z.object({
  productId:     z.string().min(1),
  platform:      z.enum(['instagram', 'tiktok', 'facebook', 'pinterest']),
  format:        z.enum(['single', 'carousel', 'story']),
  tone:          z.enum(['lifestyle', 'promotional', 'educational', 'ugc']),
  language:      z.enum(['nl', 'en']).default('nl'),
  generateImage: z.boolean().default(true),
});

// ── Validate helper ───────────────────────────────────────────
function validate<T>(schema: z.ZodSchema<T>, data: unknown): T {
  const result = schema.safeParse(data);
  if (!result.success) {
    const messages = result.error.errors.map(e => `${e.path.join('.')}: ${e.message}`).join(', ');
    throw Object.assign(new Error(messages), { httpStatus: 400 });
  }
  return result.data;
}

// ── Usage tracker ─────────────────────────────────────────────
async function trackUsage(tenantId: string, count = 1): Promise<void> {
  try {
    await db.query(
      `INSERT INTO feature_usage (tenant_id, feature_id, period_start, period_end, usage_count)
       SELECT $1, f.id, date_trunc('month', now()),
              (date_trunc('month', now()) + interval '1 month - 1 day')::date, $2
       FROM features f WHERE f.slug = 'ai-recommendations'
       ON CONFLICT (tenant_id, feature_id, period_start)
       DO UPDATE SET usage_count = feature_usage.usage_count + $2, updated_at = now()`,
      [tenantId, count], { allowNoTenant: true }
    );
  } catch {}
}

// ── GET /api/ai/insights ──────────────────────────────────────
router.get('/insights', featureGate('ai-recommendations'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { tenantId, planSlug } = getTenantContext();
    const force = req.query.force === 'true';

    const cacheKey = `ai:insights:${tenantId}`;
    if (!force) {
      const cached = await cache.get(cacheKey);
      if (cached) {
        res.json({ ...JSON.parse(cached), fromCache: true });
        return;
      }
    }

    const [ordersResult, adsResult] = await Promise.all([
      db.query(
        `SELECT COUNT(*)::int AS orders,
                COALESCE(SUM(total_amount - tax_amount), 0) AS revenue,
                COALESCE(AVG(total_amount - tax_amount), 0) AS avg_order_value
         FROM orders
         WHERE tenant_id = $1
           AND ordered_at >= NOW() - INTERVAL '30 days'
           AND status NOT IN ('cancelled','refunded')`,
        [tenantId], { allowNoTenant: true }
      ),
      db.query(
        `SELECT COALESCE(SUM(spend),0)   AS total_spend,
                COALESCE(SUM(revenue),0) AS total_revenue,
                COALESCE(AVG(roas),0)    AS avg_roas
         FROM ad_campaigns
         WHERE tenant_id = $1 AND updated_at >= NOW() - INTERVAL '30 days'`,
        [tenantId], { allowNoTenant: true }
      ),
    ]);

    const stats     = ordersResult.rows[0];
    const ads       = adsResult.rows[0];
    const hasOrders = parseInt(stats.orders) > 0;

    const prompt = hasOrders
      ? `Je bent een AI ecommerce adviseur voor MarketGrow. Analyseer de data en geef een beknopte dagelijkse briefing in JSON.
Data: ${stats.orders} orders, €${parseFloat(stats.revenue).toFixed(0)} omzet, AOV €${parseFloat(stats.avg_order_value).toFixed(0)}, ad spend €${parseFloat(ads.total_spend).toFixed(0)}, ROAS ${parseFloat(ads.avg_roas).toFixed(2)}x.
Return ONLY JSON: {"briefing":"2-3 zinnen","actions":[{"priority":"high|medium|low","title":"string","description":"string","channel":"string"}],"alerts":["string"]}`
      : `Return ONLY JSON: {"briefing":"Verbind je eerste webshop om inzichten te ontvangen. Zodra orders binnenkomen zie je hier je inzichten.","actions":[{"priority":"medium","title":"Koppel je webshop","description":"Ga naar Integraties en verbind je eerste winkel.","channel":"algemeen"}],"alerts":[]}`;

    const response = await anthropic.messages.create({
      model:      'claude-sonnet-4-20250514',
      max_tokens: 1000,
      messages:   [{ role: 'user', content: prompt }],
    });

    const text  = response.content[0].type === 'text' ? response.content[0].text : '';
    const clean = text.replace(/```json|```/g, '').trim();

    let parsed;
    try { parsed = JSON.parse(clean); }
    catch { parsed = { briefing: text.slice(0, 300), actions: [], alerts: [] }; }

    await cache.set(cacheKey, JSON.stringify(parsed), CACHE_TTL[planSlug] || 3600);
    await trackUsage(tenantId, 1);

    logger.info('ai.insights.generated', { tenantId, planSlug, hasOrders, force });
    res.json({ ...parsed, fromCache: false });
  } catch (err) { next(err); }
});

// ── GET /api/ai/credits ───────────────────────────────────────
router.get('/credits', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { tenantId, planSlug } = getTenantContext();

    const limits: Record<string, number | null> = { starter: 500, growth: 5000, scale: null };
    const limit = limits[planSlug] ?? 500;

    const usageResult = await db.query(
      `SELECT COALESCE(fu.usage_count, 0) AS used
       FROM feature_usage fu JOIN features f ON f.id = fu.feature_id
       WHERE fu.tenant_id = $1 AND f.slug = 'ai-recommendations'
         AND fu.period_start = date_trunc('month', now())`,
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

// ── POST /api/ai/chat ─────────────────────────────────────────
router.post('/chat', featureGate('ai-recommendations'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { tenantId, planSlug } = getTenantContext();

    if (planSlug === 'starter') {
      res.status(403).json({ error: 'AI Chat is beschikbaar vanaf het Growth plan.' });
      return;
    }

    const { message } = validate(ChatSchema, req.body);

    const ordersResult = await db.query(
      `SELECT COUNT(*)::int AS orders, COALESCE(SUM(total_amount - tax_amount), 0) AS revenue
       FROM orders WHERE tenant_id = $1
         AND ordered_at >= NOW() - INTERVAL '30 days'
         AND status NOT IN ('cancelled', 'refunded')`,
      [tenantId], { allowNoTenant: true }
    );
    const stats = ordersResult.rows[0];

    const response = await anthropic.messages.create({
      model:      'claude-sonnet-4-20250514',
      max_tokens: 500,
      system:     `Je bent een ecommerce AI adviseur voor MarketGrow. De gebruiker heeft ${stats.orders} orders en €${parseFloat(stats.revenue).toFixed(2)} omzet de afgelopen 30 dagen. Antwoord altijd in het Nederlands, beknopt en actionabel.`,
      messages:   [{ role: 'user', content: message }],
    });

    const text = response.content[0].type === 'text' ? response.content[0].text : '';
    await trackUsage(tenantId, 1);

    res.json({ response: text });
  } catch (err) { next(err); }
});

// ── POST /api/ai/social-content ───────────────────────────────
router.post('/social-content', featureGate('ai-recommendations'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { tenantId } = getTenantContext();
    const { platform, tone, topic, format, customContext, count } = validate(SocialContentSchema, req.body);

    const [ordersResult, adsResult, integrationsResult] = await Promise.all([
      db.query(
        `SELECT COUNT(*)::int AS total_orders,
                COALESCE(SUM(total_amount - tax_amount),0) AS revenue,
                COALESCE(AVG(total_amount - tax_amount),0) AS avg_order_value
         FROM orders WHERE tenant_id = $1
           AND ordered_at >= NOW() - INTERVAL '30 days'
           AND status NOT IN ('cancelled','refunded')`,
        [tenantId], { allowNoTenant: true }
      ),
      db.query(
        `SELECT COALESCE(SUM(spend),0)       AS total_spend,
                COALESCE(SUM(revenue),0)     AS total_ad_revenue,
                COALESCE(AVG(roas),0)        AS avg_roas,
                COALESCE(SUM(impressions),0) AS total_impressions
         FROM ad_campaigns WHERE tenant_id = $1
           AND updated_at >= NOW() - INTERVAL '30 days'`,
        [tenantId], { allowNoTenant: true }
      ),
      db.query(
        `SELECT platform_slug FROM tenant_integrations WHERE tenant_id = $1 AND status = 'active'`,
        [tenantId], { allowNoTenant: true }
      ),
    ]);

    const orders    = ordersResult.rows[0];
    const ads       = adsResult.rows[0];
    const platforms = integrationsResult.rows.map((r: any) => r.platform_slug).join(', ');

    const storeContext = orders.total_orders > 0
      ? `Real store data (last 30 days): ${orders.total_orders} orders, €${parseFloat(orders.revenue).toFixed(0)} revenue, AOV €${parseFloat(orders.avg_order_value).toFixed(0)}, ad spend €${parseFloat(ads.total_spend).toFixed(0)}, ROAS ${parseFloat(ads.avg_roas).toFixed(2)}x. Platforms: ${platforms || 'unknown'}.`
      : `No store data yet — create general ecommerce content.`;

    const customCtx = customContext ? `\nExtra context from user: ${customContext}` : '';

    const toneGuide: Record<string, string> = {
      'educational':       'Teach the audience something actionable. Use clear steps or insights.',
      'inspirational':     'Motivate and inspire. Focus on results, transformation, and possibilities.',
      'data-driven':       'Lead with a surprising or compelling statistic. Let numbers do the talking.',
      'behind-the-scenes': 'Be authentic, relatable, and transparent. Share real experiences.',
    };

    const topicGuide: Record<string, string> = {
      'roas':                'Return on ad spend, ad profitability, knowing your numbers',
      'product-performance': 'Which products sell best, product analytics, revenue per product',
      'ads-tips':            'Advertising tips for ecommerce, campaign optimisation',
      'ecommerce-growth':    'Growing an ecommerce business, scaling, multi-channel selling',
      'platform-insights':   'Selling on Shopify, Bol.com, Amazon, Etsy',
    };

    const platformGuide: Record<string, string> = {
      instagram: 'Instagram caption style: conversational, line breaks for readability, emojis allowed, strong hook in first line. 15-20 hashtags.',
      tiktok:    'TikTok caption style: very short and punchy, hook must be irresistible, CTA to follow or comment. 5-8 hashtags.',
    };

    const formatGuide: Record<string, string> = {
      single:       'Single image post with hook, caption, CTA, hashtags.',
      carousel:     'Carousel with 5 slides. Each slide: headline + 2-3 lines body + visual_hint.',
      video_script: 'Short video script (30-60 sec). Hook in first 3 seconds. Include visual notes.',
    };

    const outputFormat: Record<string, string> = {
      single:       '[{"hook":"","caption":"","cta":"","hashtags":[],"image_prompt":""}]',
      carousel:     '[{"hook":"","caption":"","cta":"","hashtags":[],"slides":[{"headline":"","body":"","visual_hint":""}]}]',
      video_script: '[{"hook":"","script":"","hashtags":[],"image_prompt":""}]',
    };

    const prompt = `You are a social media content expert for ecommerce brands.
PLATFORM: ${platform}
TOPIC: ${topicGuide[topic] || topic}
TONE: ${toneGuide[tone] || tone}
FORMAT: ${formatGuide[format ?? 'single'] || formatGuide['single']}
PLATFORM STYLE: ${platformGuide[platform]}
${storeContext}${customCtx}
Return ONLY a valid JSON array with exactly ${count} post object(s). No markdown:
${outputFormat[format ?? 'single'] || outputFormat['single']}`;

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
    } catch { posts = []; }

    await trackUsage(tenantId, count);

    logger.info('ai.social-content.generated', { tenantId, platform, tone, topic, count });
    res.json({ posts });
  } catch (err) { next(err); }
});

// ── POST /api/ai/generate-image ───────────────────────────────
router.post('/generate-image', featureGate('ai-recommendations'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { tenantId } = getTenantContext();
    const { prompt, slideTitle, slideBody, index } = validate(GenerateImageSchema, req.body);
    const { generateAdCreative } = require('../services/nano-banana.service');

    const result = await generateAdCreative({
      product: {
        title:    slideTitle || prompt.slice(0, 60),
        platform: 'instagram',
      },
      format:   'single',
      platform: 'instagram',
      style:    'minimal',
    });

    await trackUsage(tenantId, 1);
    logger.info('ai.generate-image.complete', { tenantId, index });
    res.json({ imageUrl: result.imageUrl });
  } catch (err) { next(err); }
});

// ── POST /api/ai/video-script ─────────────────────────────────
// Interne tool — alleen voor owner/admin
router.post('/video-script', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { userId } = getTenantContext();

    const userResult = await db.query(
      `SELECT role FROM users WHERE id = $1`,
      [userId], { allowNoTenant: true }
    );
    if (userResult.rows[0]?.role !== 'owner') {
      res.status(403).json({ error: 'Not authorized' });
      return;
    }

    const { scenario, format, angle, index, total } = validate(VideoScriptSchema, req.body);

    const angleGuide: Record<string, string> = {
      'problem-reveal': 'Open with the painful problem every ecommerce seller faces, build tension, then reveal how MarketGrow solves it.',
      'data-story':     'Lead with ONE surprising specific number. Let the number do the work. Unpack the story behind it.',
      'before-after':   'Paint the before picture (chaos, blind decisions, wasted spend) then the after (clarity, smart decisions, growth).',
      'tip-listicle':   'Give exactly 3 specific, actionable tips. Each backed by a number. Fast paced. Numbered out loud.',
      'founder-story':  'First-person voice. Tell the story of discovering this insight. Authentic, relatable, real.',
    };

    const safeIndex = index ?? 0;
    const safeTotal = total ?? 1;

    const prompt = `You are writing a short-form video script for MarketGrow (an AI-powered ecommerce analytics platform).

ANGLE: ${angle.label}
ANGLE GUIDE: ${angleGuide[angle.id] || ''}
FORMAT: ${format.label} (target: ~${format.words} words)
VARIATION: Script ${safeIndex + 1} of ${safeTotal} — make this distinctly different from other variations.

STORE DATA (use this to make the script concrete):
- Store: ${scenario.store}
- Revenue (30d): ${scenario.revenue}
- Ad spend (30d): ${scenario.adSpend}
- Real ROAS: ${scenario.realRoas}x
- Meta reported ROAS: ${scenario.metaRoas}x
- Google reported ROAS: ${scenario.googleRoas}x
- Bol.com ROAS: ${scenario.bolRoas}x
- AI insight: ${scenario.insight}
- Active campaigns: ${scenario.campaigns}
- Top product: ${scenario.topProduct}
- Margin: ${scenario.margin}

Return ONLY JSON (no markdown):
{"hook":"first 3 seconds — must stop the scroll","script":"full script with [VISUAL: ...] notes","visualNotes":["visual cue 1","visual cue 2"],"hashtags":["tag1","tag2"]}`;

    const response = await anthropic.messages.create({
      model:      'claude-sonnet-4-20250514',
      max_tokens: 600,
      messages:   [{ role: 'user', content: prompt }],
    });

    const text  = response.content[0].type === 'text' ? response.content[0].text : '{}';
    const clean = text.replace(/```json|```/g, '').trim();

    let parsed;
    try { parsed = JSON.parse(clean); }
    catch {
      const match = clean.match(/\{[\s\S]*\}/);
      parsed = match ? JSON.parse(match[0]) : { hook: '', script: text, visualNotes: [], hashtags: [] };
    }

    res.json(parsed);
  } catch (err) { next(err); }
});

// ── Bol.com producttitel opzoeken via order line items ────────
// sku is NULL voor Bol.com — zoek via product_id (= external_id van het product)
async function getBolcomTitleFromOrders(tenantId: string, externalId: string, ean: string): Promise<string | null> {
  try {
    // Stap 1: zoek via product_id (= external_id)
    const result = await db.query<{ title: string }>(
      `SELECT li.title
       FROM order_line_items li
       WHERE li.tenant_id = $1
         AND li.product_id = $2
         AND li.title IS NOT NULL
         AND li.title != ''
         AND li.title !~ '^[0-9]{8,14}$'
       ORDER BY li.id DESC
       LIMIT 1`,
      [tenantId, externalId],
      { allowNoTenant: true }
    );
    if (result.rows[0]?.title) return result.rows[0].title;

    // Stap 2: fallback via sku (voor platforms die sku wel vullen)
    if (ean) {
      const result2 = await db.query<{ title: string }>(
        `SELECT li.title
         FROM order_line_items li
         WHERE li.tenant_id = $1
           AND li.sku = $2
           AND li.title IS NOT NULL
           AND li.title != ''
           AND li.title !~ '^[0-9]{8,14}$'
         ORDER BY li.id DESC
         LIMIT 1`,
        [tenantId, ean],
        { allowNoTenant: true }
      );
      if (result2.rows[0]?.title) return result2.rows[0].title;
    }

    // Stap 3: fallback — zoek op EAN in de title van andere line items
    // (soms staat EAN in de title van een ander product met dezelfde EAN)
    if (ean) {
      const result3 = await db.query<{ title: string }>(
        `SELECT li.title
         FROM order_line_items li
         WHERE li.tenant_id = $1
           AND li.title IS NOT NULL
           AND li.title != ''
           AND li.title !~ '^[0-9]{8,14}$'
         ORDER BY li.id DESC
         LIMIT 1`,
        [tenantId],
        { allowNoTenant: true }
      );
      // Geef de meest recente echte titel terug als fallback
      if (result3.rows[0]?.title) return null; // liever niets dan verkeerde titel
    }

    return null;
  } catch {
    return null;
  }
}

// ── GET /api/ai/products ──────────────────────────────────────
// Gebruikt order_line_items als bron — die hebben de echte Bol.com titels
router.get('/products', featureGate('ai-recommendations'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { tenantId } = getTenantContext();
    const { search, limit = '20' } = req.query as Record<string, string>;

    const searchFilter = search ? `AND oli.title ILIKE $3` : '';
    const params: any[] = [tenantId, parseInt(limit)];
    if (search) params.push(`%${search}%`);

    const result = await db.query(
      `SELECT
         oli.title,
         o.platform_slug                      AS platform,
         ti.shop_name,
         SUM(oli.total_price)                 AS revenue_30d,
         SUM(oli.quantity)::int               AS units_30d,
         COUNT(DISTINCT o.id)::int            AS orders_30d,
         AVG(oli.unit_price)                  AS avg_price,
         MAX(p.ean)                           AS ean,
         MAX(p.id::text)                      AS product_id,
         MAX(p.image_url)                     AS image_url,
         MAX(p.price_min::text)               AS price_min
       FROM order_line_items oli
       JOIN orders o ON o.id = oli.order_id
       JOIN tenant_integrations ti
         ON ti.tenant_id = $1
         AND ti.status = 'active'
         AND ti.platform_slug = o.platform_slug
       LEFT JOIN products p
         ON p.tenant_id = $1
         AND p.ean IS NOT NULL
         AND p.ean = oli.sku
       WHERE oli.tenant_id = $1
         AND o.ordered_at >= now() - INTERVAL '90 days'
         AND o.status NOT IN ('cancelled', 'refunded')
         AND oli.title IS NOT NULL
         AND oli.title != ''
         AND oli.title !~ '^[0-9]{8,14}$'
         ${searchFilter}
       GROUP BY oli.title, o.platform_slug, ti.shop_name
       ORDER BY revenue_30d DESC
       LIMIT $2`,
      params,
      { allowNoTenant: true }
    );

    res.json({
      products: result.rows.map((p: any) => ({
        id:        p.product_id || p.title.slice(0, 36),
        title:     p.title,
        ean:       p.ean ?? null,
        imageUrl:  p.image_url ?? null,
        priceMin:  p.price_min ? parseFloat(p.price_min) : (p.avg_price ? parseFloat(p.avg_price) : null),
        priceMax:  null,
        inventory: 0,
        platform:  p.platform,
        shopName:  p.shop_name,
        revenue30d: parseFloat(p.revenue_30d ?? 0),
        units30d:   parseInt(p.units_30d ?? 0),
        orders30d:  parseInt(p.orders_30d ?? 0),
      })),
    });
  } catch (err) { next(err); }
});

// ── POST /api/ai/product-content ──────────────────────────────
// Genereert marketing content + AI beeld voor een specifiek product
router.post('/product-content', featureGate('ai-recommendations'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { tenantId } = getTenantContext();
    const { productId, platform, format, tone, language, generateImage } = validate(ProductContentSchema, req.body);

    // Haal productdetails + performance op
    const productResult = await db.query(
      `SELECT p.*, ti.shop_name, ti.platform_slug AS platform_name,
              COALESCE(SUM(li.total_price), 0) AS revenue_30d,
              COALESCE(SUM(li.quantity), 0)    AS units_30d
       FROM products p
       JOIN tenant_integrations ti ON ti.id = p.integration_id
       LEFT JOIN order_line_items li ON li.product_id = p.external_id AND li.tenant_id = $1
       LEFT JOIN orders o ON o.id = li.order_id
         AND o.ordered_at >= now() - INTERVAL '30 days'
         AND o.status NOT IN ('cancelled', 'refunded')
       WHERE p.id = $2 AND p.tenant_id = $1
       GROUP BY p.id, ti.shop_name, ti.platform_slug`,
      [tenantId, productId],
      { allowNoTenant: true }
    );

    if (!productResult.rows[0]) {
      res.status(404).json({ error: 'Product niet gevonden' });
      return;
    }

    const product = productResult.rows[0];
    const price   = product.price_min ? `€${parseFloat(product.price_min).toFixed(2)}` : 'prijs onbekend';
    const revenue = parseFloat(product.revenue_30d ?? 0);
    const units   = parseInt(product.units_30d ?? 0);

    const langGuide = language === 'nl' ? 'Write in Dutch.' : 'Write in English.';

    const toneGuide: Record<string, string> = {
      lifestyle:    'Lifestyle angle — show how this product fits into the customer\'s daily life. Aspirational, warm, relatable.',
      promotional:  'Sales-focused — highlight the offer, urgency, and value. Clear CTA to buy now.',
      educational:  'Teach something about the product — features, benefits, how to use it. Informative and trust-building.',
      ugc:          'User-generated content style — authentic, personal, first-person. As if a real customer is sharing their experience.',
    };

    const formatGuide: Record<string, string> = {
      single:   'Single image post: hook (first line stops the scroll), caption (3-4 lines), strong CTA, hashtags.',
      carousel: '5-slide carousel: slide 1 = attention-grabbing headline, slides 2-4 = product benefits/features, slide 5 = CTA. Each slide: headline + 2 lines body.',
      story:    'Vertical story: ultra short hook (max 8 words), 1 key benefit, CTA button text.',
    };

    const platformGuide: Record<string, string> = {
      instagram: '15-20 hashtags. Mix popular and niche. Emojis allowed. Strong visual hook.',
      tiktok:    '5-8 hashtags. Very short punchy text. Trending language. Hook must work in first 2 seconds.',
      facebook:  '3-5 hashtags. Longer, more descriptive captions work here. Link-friendly.',
      pinterest: '5-10 hashtags. Describe the visual. Keywords matter for search.',
    };

    const performanceContext = units > 0
      ? `This product has sold ${units} units (€${revenue.toFixed(0)} revenue) in the last 30 days — it's a proven seller. Use this social proof.`
      : 'This product has not sold in the last 30 days — position it to drive initial sales with curiosity or urgency.';

    const prompt = `You are a product marketing expert creating social media content for an ecommerce seller.

PRODUCT: ${product.title}
PRICE: ${price}
PLATFORM WHERE SOLD: ${product.platform_name}
PERFORMANCE: ${performanceContext}
${product.ean ? `EAN: ${product.ean}` : ''}

CHANNEL: ${platform}
FORMAT: ${formatGuide[format]}
TONE: ${toneGuide[tone]}
PLATFORM STYLE: ${platformGuide[platform]}
LANGUAGE: ${langGuide}

Also provide an image_prompt field: describe the ideal marketing visual for this product in detail.
The visual should be: professional product photography style, lifestyle context fitting the tone, specific details about lighting, composition, props, mood.

Return ONLY valid JSON (no markdown):
${format === 'carousel'
  ? '{"slides":[{"headline":"...","body":"...","visual_hint":"..."}],"caption":"...","cta":"...","hashtags":["..."],"image_prompt":"..."}'
  : '{"hook":"...","caption":"...","cta":"...","hashtags":["..."],"image_prompt":"..."}'
}`;

    const response = await anthropic.messages.create({
      model:      'claude-sonnet-4-20250514',
      max_tokens: 1500,
      messages:   [{ role: 'user', content: prompt }],
    });

    const text  = response.content[0].type === 'text' ? response.content[0].text : '{}';
    const clean = text.replace(/```json|```/g, '').trim();

    let content;
    try { content = JSON.parse(clean); }
    catch { content = { hook: '', caption: text, cta: '', hashtags: [], image_prompt: product.title }; }

    // Genereer marketing beeld via Gemini als gevraagd
    let imageUrl: string | null = null;
    if (generateImage && content.image_prompt) {
      try {
        const { generateAdCreative } = require('../services/nano-banana.service');
        const imageResult = await generateAdCreative({
          product: { title: product.title, platform },
          format:  format === 'story' ? 'story' : 'single',
          platform,
          style:   tone === 'lifestyle' ? 'lifestyle' : 'minimal',
          customPrompt: content.image_prompt,
        });
        imageUrl = imageResult.imageUrl ?? null;
      } catch (imgErr) {
        logger.warn('ai.product-content.image_failed', {
          tenantId,
          error: (imgErr as Error).message,
        });
      }
    }

    await trackUsage(tenantId, 1);
    logger.info('ai.product-content.generated', { tenantId, productId, platform, format, tone });

    res.json({
      ...content,
      imageUrl,
      product: { title: product.title, price },
    });
  } catch (err) { next(err); }
});

// ── POST /api/ai/product-content-from-image ───────────────────
// Genereert marketing content op basis van een geüploade productfoto
const ImageUploadSchema = z.object({
  imageBase64:   z.string().min(100).max(10_000_000), // max ~7.5MB base64
  platform:      z.enum(['instagram', 'tiktok', 'facebook', 'pinterest']),
  format:        z.enum(['single', 'carousel', 'story']),
  tone:          z.enum(['lifestyle', 'promotional', 'educational', 'ugc']),
  language:      z.enum(['nl', 'en']).default('nl'),
  generateImage: z.boolean().default(false), // default false — ze hebben al een foto
});

router.post('/product-content-from-image', featureGate('ai-recommendations'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { tenantId } = getTenantContext();
    const { imageBase64, platform, format, tone, language, generateImage } = validate(ImageUploadSchema, req.body);

    const langGuide = language === 'nl' ? 'Write in Dutch.' : 'Write in English.';

    const toneGuide: Record<string, string> = {
      lifestyle:    'Lifestyle — aspirationeel, warm, laat zien hoe het product in het dagelijks leven past.',
      promotional:  'Promotioneel — sales-gericht, urgentie, duidelijke CTA om nu te kopen.',
      educational:  'Educatief — informerend, vertrouwen opbouwen, features en voordelen uitleggen.',
      ugc:          'UGC-stijl — authentiek, eerste persoon, alsof een echte klant het deelt.',
    };

    const formatGuide: Record<string, string> = {
      single:   'Single post: hook + caption (3-4 regels) + CTA + hashtags.',
      carousel: '5-slide carousel: slide 1 = koptekst, slides 2-4 = voordelen, slide 5 = CTA.',
      story:    'Story: ultra korte hook (max 8 woorden) + 1 key voordeel + CTA knoptekst.',
    };

    const platformGuide: Record<string, string> = {
      instagram: '15-20 hashtags. Emojis toegestaan. Sterke visuele hook.',
      tiktok:    '5-8 hashtags. Kort en pakkend. Hook werkt in eerste 2 seconden.',
      facebook:  '3-5 hashtags. Langere beschrijvingen werken hier goed.',
      pinterest: '5-10 hashtags. Beschrijf het visueel. Keywords voor zoekopdrachten.',
    };

    const prompt = `You are a product marketing expert. Analyze the product photo and create social media content.

CHANNEL: ${platform}
FORMAT: ${formatGuide[format]}
TONE: ${toneGuide[tone]}
PLATFORM STYLE: ${platformGuide[platform]}
LANGUAGE: ${langGuide}

Look at the product in the image and:
1. Identify what the product is
2. Create compelling marketing content for it
3. Provide an image_prompt describing the ideal enhanced version of this photo for marketing

Return ONLY valid JSON (no markdown):
${format === 'carousel'
  ? '{"productName":"...","slides":[{"headline":"...","body":"...","visual_hint":"..."}],"caption":"...","cta":"...","hashtags":["..."],"image_prompt":"..."}'
  : '{"productName":"...","hook":"...","caption":"...","cta":"...","hashtags":["..."],"image_prompt":"..."}'
}`;

    // Gebruik Claude vision om de foto te analyseren en content te maken
    const response = await anthropic.messages.create({
      model:      'claude-sonnet-4-20250514',
      max_tokens: 1500,
      messages: [{
        role: 'user',
        content: [
          {
            type: 'image',
            source: {
              type:       'base64',
              media_type: 'image/jpeg',
              data:       imageBase64,
            },
          },
          { type: 'text', text: prompt },
        ],
      }],
    });

    const text  = response.content[0].type === 'text' ? response.content[0].text : '{}';
    const clean = text.replace(/```json|```/g, '').trim();

    let content;
    try { content = JSON.parse(clean); }
    catch { content = { hook: '', caption: text, cta: '', hashtags: [], image_prompt: 'product photo' }; }

    // Optioneel: genereer een AI-verbeterd beeld
    let imageUrl: string | null = null;
    if (generateImage && content.image_prompt) {
      try {
        const { generateAdCreative } = require('../services/nano-banana.service');
        const imageResult = await generateAdCreative({
          product: { title: content.productName || 'product', platform },
          format:  format === 'story' ? 'story' : 'single',
          platform,
          style:   tone === 'lifestyle' ? 'lifestyle' : 'minimal',
          customPrompt: content.image_prompt,
        });
        imageUrl = imageResult.imageUrl ?? null;
      } catch (imgErr) {
        logger.warn('ai.image-upload.generate_failed', { tenantId, error: (imgErr as Error).message });
      }
    }

    await trackUsage(tenantId, 1);
    logger.info('ai.product-content-from-image.generated', { tenantId, platform, format, tone });

    res.json({
      ...content,
      imageUrl,
      product: { title: content.productName || 'Geüpload product', price: '' },
    });
  } catch (err) { next(err); }
});

export { router as aiRouter };
