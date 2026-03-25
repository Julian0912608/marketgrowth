// saas-platform/src/modules/ai-engine/api/ai.routes.ts
//
// SECURITY UPDATE: Zod validatie op alle POST endpoints

import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { tenantMiddleware }  from '../../../shared/middleware/tenant.middleware';
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
  customContext: z.string().max(500).optional(),
  count:         z.number().int().min(1).max(5).optional().default(3),
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

// ── Validate helper ───────────────────────────────────────────
function validate<T>(schema: z.ZodSchema<T>, data: unknown): T {
  const result = schema.safeParse(data);
  if (!result.success) {
    const messages = result.error.errors.map(e => `${e.path.join('.')}: ${e.message}`).join(', ');
    throw Object.assign(new Error(messages), { httpStatus: 400 });
  }
  return result.data;
}

// ── GET /api/ai/insights ──────────────────────────────────────
router.get('/insights', async (req: Request, res: Response, next: NextFunction) => {
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

    const stats    = ordersResult.rows[0];
    const ads      = adsResult.rows[0];
    const hasOrders = parseInt(stats.orders) > 0;

    const prompt = hasOrders
      ? `Je bent een AI ecommerce adviseur voor MarketGrow. Analyseer de data en geef een beknopte dagelijkse briefing in JSON.
Data: ${stats.orders} orders, €${parseFloat(stats.revenue).toFixed(0)} omzet, AOV €${parseFloat(stats.avg_order_value).toFixed(0)}, ad spend €${parseFloat(ads.total_spend).toFixed(0)}, ROAS ${parseFloat(ads.avg_roas).toFixed(2)}x.
Return ONLY JSON: {"briefing":"2-3 zinnen","actions":[{"priority":"high|medium|low","title":"string","description":"string"}],"alerts":["string"]}`
      : `Return ONLY JSON: {"briefing":"Verbind je eerste webshop om inzichten te ontvangen. Zodra orders binnenkomen zie je hier je inzichten.","actions":[{"priority":"medium","title":"Koppel je webshop","description":"Ga naar Integraties en verbind je eerste winkel."}],"alerts":[]}`;

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

    try {
      await db.query(
        `INSERT INTO feature_usage (tenant_id, feature_id, period_start, period_end, usage_count)
         SELECT $1, f.id, date_trunc('month', now()),
                (date_trunc('month', now()) + interval '1 month - 1 day')::date, 1
         FROM features f WHERE f.slug = 'ai-recommendations'
         ON CONFLICT (tenant_id, feature_id, period_start)
         DO UPDATE SET usage_count = feature_usage.usage_count + 1, updated_at = now()`,
        [tenantId], { allowNoTenant: true }
      );
    } catch {}

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
router.post('/chat', async (req: Request, res: Response, next: NextFunction) => {
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

    try {
      await db.query(
        `INSERT INTO feature_usage (tenant_id, feature_id, period_start, period_end, usage_count)
         SELECT $1, f.id, date_trunc('month', now()),
                (date_trunc('month', now()) + interval '1 month - 1 day')::date, 1
         FROM features f WHERE f.slug = 'ai-recommendations'
         ON CONFLICT (tenant_id, feature_id, period_start)
         DO UPDATE SET usage_count = feature_usage.usage_count + 1, updated_at = now()`,
        [tenantId], { allowNoTenant: true }
      );
    } catch {}

    res.json({ response: text });
  } catch (err) { next(err); }
});

// ── POST /api/ai/social-content ───────────────────────────────
router.post('/social-content', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { tenantId, planSlug } = getTenantContext();

    if (planSlug === 'starter') {
      res.status(403).json({ error: 'Social Content Generator is available on Growth and Scale plans.' });
      return;
    }

    const { platform, tone, topic, customContext, count } = validate(SocialContentSchema, req.body);

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

    const storeContext = `Real store data:
- Orders last 30 days: ${orders.total_orders}
- Revenue: €${parseFloat(orders.revenue).toFixed(0)}
- AOV: €${parseFloat(orders.avg_order_value).toFixed(0)}
- Ad spend: €${parseFloat(ads.total_spend).toFixed(0)}
- ROAS: ${parseFloat(ads.avg_roas).toFixed(2)}x
- Platforms: ${platforms || 'not specified'}
${customContext ? `\nExtra context: ${customContext}` : ''}`.trim();

    const prompt = `You are a social media content expert for ecommerce entrepreneurs. Create ${count} unique posts for ${platform}.
TOPIC: ${topicGuide[topic] || topic}
TONE: ${toneGuide[tone] || tone}
PLATFORM STYLE: ${platformGuide[platform]}
${storeContext}
Return ONLY a valid JSON array with exactly ${count} post object(s). No markdown:
[{"hook":"...","caption":"...","cta":"...","hashtags":["..."]}]`;

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

    logger.info('ai.social-content.generated', { tenantId, platform, tone, topic, count });
    res.json({ posts });
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

    const prompt = `You are a viral video script writer for MarketGrow — an AI analytics platform for ecommerce entrepreneurs.

Write ${safeTotal > 1 ? `script ${safeIndex + 1} of ${safeTotal} — make it COMPLETELY different from the others. ` : 'a '}${format.label} video script (${format.words} spoken words ±10%) using the "${angle.label}" angle.

ANGLE: ${angleGuide[angle.id] ?? angle.label}

DEMO DATA (present as real — never say "demo"):
- Store: ${scenario.store}
- Revenue: ${scenario.revenue}/month
- Ad spend: ${scenario.adSpend}/month
- Real blended ROAS: ${scenario.realRoas}
- Meta claimed: ${scenario.metaRoas} | Google claimed: ${scenario.googleRoas} | Bol.com: ${scenario.bolRoas}
- Key insight: ${scenario.insight}
- Campaigns: ${scenario.campaigns} | Top product: ${scenario.topProduct} | Margin: ${scenario.margin}

RULES:
- Spoken English, natural — written to be read aloud
- Hook stops scroll in 2 seconds — counterintuitive or shocking
- Mention MarketGrow once naturally, end with: join the waitlist at marketgrow.ai
- FACELESS video — no visual references to a speaker
- Mark pauses with ...
- NO corporate speak

Return ONLY valid JSON (no markdown):
{"hook":"opening hook - 2 seconds only","script":"full spoken script with ... pauses","visualNotes":["scene 1","scene 2","scene 3","scene 4","scene 5"],"hashtags":["tag1","tag2","tag3","tag4","tag5","tag6","tag7","tag8"]}`;

    const response = await anthropic.messages.create({
      model:      'claude-sonnet-4-20250514',
      max_tokens: 1200,
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

export { router as aiRouter };
