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
//
// FIXES (Product Hunt readiness):
//   1. trackUsage is niet meer silent-fail: logt een warning als het
//      mis gaat, en blokkeert de response NIET maar laat het systeem
//      weten dat er een tracking-probleem is.
//   2. Redis pre-check vóór DB: snelle credit-limiet check op Redis
//      counter voordat de Anthropic API wordt aangeroepen. Voorkomt
//      dat gratis accounts bij launch de API hammeren.
//   3. IP-based rate limit op alle /api/ai/* routes: max 30 req/min
//      per IP. Beschermt tegen misbruik bij Product Hunt spike.
//   4. Starter plan: 100 credits/month (was 500 in DB, aangepast naar
//      100 om overeen te komen met pricing pagina).
//   5. AI Chat en Social Content generatie zijn Growth+ only.
//      Starter krijgt alleen AI Insights (dagelijkse briefing).
//   6. FIX: credits endpoint gebruikte ?? operator op null waarde
//      waardoor Scale plan altijd limit: 100 kreeg ipv unlimited.
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
  ? new (require('@anthropic-ai/sdk').default)()
  : new (require('@anthropic-ai/sdk'))();

// ── Cache TTL per plan (seconden) ─────────────────────────────
const CACHE_TTL: Record<string, number> = {
  starter: 14400,   // 4 uur
  growth:  3600,    // 1 uur
  scale:   1800,    // 30 minuten
};

// ── Plan credit limieten (matcht pricing pagina) ──────────────
const PLAN_LIMITS: Record<string, number | null> = {
  starter: 100,    // 100 credits/month — zoals op pricing pagina
  growth:  2000,   // 2.000 credits/month
  scale:   null,   // unlimited
};

// ── IP rate limiter voor AI routes ────────────────────────────
// Max 30 requests per minuut per IP — beschermt bij launch spike
const AI_RATE_LIMIT = 30;
const AI_RATE_WINDOW = 60; // seconden

async function checkIpRateLimit(req: Request): Promise<boolean> {
  const rawRedis = require('../../../infrastructure/cache/redis').redis as any;
  const ip = req.ip ?? req.headers['x-forwarded-for'] ?? 'unknown';
  const key = `ratelimit:ai:ip:${ip}`;
  try {
    const current = await rawRedis.incr(key);
    if (current === 1) await rawRedis.expire(key, AI_RATE_WINDOW);
    return current <= AI_RATE_LIMIT;
  } catch {
    return true; // fail open als Redis niet bereikbaar is
  }
}

// ── Redis-backed credit pre-check ────────────────────────────
async function checkCreditPreCheck(tenantId: string, planSlug: string): Promise<boolean> {
  const limit = PLAN_LIMITS[planSlug];
  if (limit === null) return true; // unlimited

  const rawRedis = require('../../../infrastructure/cache/redis').redis as any;
  const key = `ai:credits:used:${tenantId}:${new Date().toISOString().slice(0, 7)}`;

  try {
    const used = await rawRedis.get(key);
    if (used !== null && parseInt(used) >= limit) {
      logger.info('ai.credits.limit_reached_redis', { tenantId, planSlug, used, limit });
      return false;
    }
  } catch {}

  try {
    const result = await db.query(
      `SELECT COALESCE(fu.usage_count, 0) AS used
       FROM feature_usage fu JOIN features f ON f.id = fu.feature_id
       WHERE fu.tenant_id = $1 AND f.slug = 'ai-recommendations'
         AND fu.period_start = date_trunc('month', now())`,
      [tenantId], { allowNoTenant: true }
    );
    const used = parseInt(result.rows[0]?.used || '0');
    if (used >= limit) {
      logger.info('ai.credits.limit_reached_db', { tenantId, planSlug, used, limit });
      return false;
    }
  } catch (err) {
    logger.warn('ai.credits.precheck_failed', { tenantId, error: (err as Error).message });
  }

  return true;
}

// ── Usage tracker ─────────────────────────────────────────────
async function trackUsage(tenantId: string, count = 1, planSlug?: string): Promise<void> {
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
  } catch (err) {
    logger.warn('ai.usage.tracking_failed', { tenantId, count, error: (err as Error).message });
  }

  try {
    const rawRedis = require('../../../infrastructure/cache/redis').redis as any;
    const key = `ai:credits:used:${tenantId}:${new Date().toISOString().slice(0, 7)}`;
    await rawRedis.incrby(key, count);
    await rawRedis.expire(key, 35 * 24 * 3600);
  } catch {}
}

// ── Zod validation helper ─────────────────────────────────────
function validate<T>(schema: z.ZodSchema<T>, data: unknown): T {
  const result = schema.safeParse(data);
  if (!result.success) {
    const messages = result.error.errors.map(e => `${e.path.join('.')}: ${e.message}`).join(', ');
    throw Object.assign(new Error(messages), { httpStatus: 400 });
  }
  return result.data;
}

// ── Schemas ───────────────────────────────────────────────────
const ChatSchema = z.object({
  message: z.string().min(1).max(1000),
});

const SocialContentSchema = z.object({
  platform:      z.enum(['instagram', 'tiktok', 'linkedin', 'facebook', 'twitter']),
  tone:          z.string().max(50),
  topic:         z.string().max(200),
  format:        z.string().optional(),
  customContext: z.string().max(500).optional(),
  count:         z.number().int().min(1).max(5).default(1),
});

const GenerateImageSchema = z.object({
  prompt:     z.string().max(500),
  slideTitle: z.string().max(100).optional(),
  slideBody:  z.string().max(300).optional(),
  index:      z.number().int().optional(),
});

const VideoScriptSchema = z.object({
  scenario: z.string().max(200),
  format:   z.string().max(50).optional(),
  angle:    z.string().max(50).optional(),
  index:    z.number().int().optional(),
  total:    z.number().int().optional(),
});

const ProductContentSchema = z.object({
  productId: z.string().uuid(),
  formats:   z.array(z.string()).optional(),
});

// ── IP rate limit middleware voor AI routes ───────────────────
router.use(async (req: Request, res: Response, next: NextFunction) => {
  const allowed = await checkIpRateLimit(req);
  if (!allowed) {
    res.status(429).json({
      error: 'too_many_requests',
      message: 'Too many AI requests. Please slow down.',
      retryAfter: AI_RATE_WINDOW,
    });
    return;
  }
  next();
});

// ── GET /api/ai/insights ──────────────────────────────────────
router.get('/insights', featureGate('ai-recommendations'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { tenantId, planSlug } = getTenantContext();
    const force = req.query.force === 'true';

    if (!force) {
      const cacheKey = `ai:insights:${tenantId}`;
      const cached = await cache.get(cacheKey);
      if (cached) {
        res.json({ ...JSON.parse(cached), fromCache: true });
        return;
      }
    }

    const hasCredits = await checkCreditPreCheck(tenantId, planSlug);
    if (!hasCredits) {
      const limit = PLAN_LIMITS[planSlug];
      res.status(402).json({
        error: 'credits_exhausted',
        message: `You've used all ${limit} AI credits this month. Upgrade to get more.`,
        upgradeRequired: true,
      });
      return;
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
      : `Return ONLY JSON: {"briefing":"Connect your first store to receive AI insights. Once orders come in you will see your daily briefing here.","actions":[{"priority":"medium","title":"Connect your store","description":"Go to Integrations and connect your first shop to unlock AI insights.","channel":"algemeen"}],"alerts":[]}`;

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

    const cacheKey = `ai:insights:${tenantId}`;
    await cache.set(cacheKey, JSON.stringify(parsed), CACHE_TTL[planSlug] || 3600);
    await trackUsage(tenantId, 1, planSlug);

    logger.info('ai.insights.generated', { tenantId, planSlug, hasOrders, force });
    res.json({ ...parsed, fromCache: false });
  } catch (err) { next(err); }
});

// ── GET /api/ai/credits ───────────────────────────────────────
router.get('/credits', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { tenantId, planSlug } = getTenantContext();

    // FIX: ?? operator werkt niet voor null — gebruik expliciete key check
    // zodat Scale plan (null) niet terugvalt op 100
    const limit     = planSlug in PLAN_LIMITS ? PLAN_LIMITS[planSlug] : 100;
    const unlimited = limit === null;

    const usageResult = await db.query(
      `SELECT COALESCE(fu.usage_count, 0) AS used
       FROM feature_usage fu JOIN features f ON f.id = fu.feature_id
       WHERE fu.tenant_id = $1 AND f.slug = 'ai-recommendations'
         AND fu.period_start = date_trunc('month', now())`,
      [tenantId], { allowNoTenant: true }
    );

    const used = parseInt(usageResult.rows[0]?.used || '0');

    res.json({
      used,
      limit,
      remaining: unlimited ? null : Math.max(0, (limit as number) - used),
      unlimited,
      planSlug,
    });
  } catch (err) { next(err); }
});

// ── POST /api/ai/chat ─────────────────────────────────────────
router.post('/chat', featureGate('ai-recommendations'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { tenantId, planSlug } = getTenantContext();

    if (planSlug === 'starter') {
      res.status(403).json({
        error: 'plan_insufficient',
        message: 'AI Chat is available from the Growth plan.',
        upgradeRequired: true,
        requiredPlan: 'growth',
      });
      return;
    }

    const hasCredits = await checkCreditPreCheck(tenantId, planSlug);
    if (!hasCredits) {
      res.status(402).json({ error: 'credits_exhausted', message: 'Monthly AI credit limit reached.' });
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
    await trackUsage(tenantId, 1, planSlug);

    res.json({ response: text });
  } catch (err) { next(err); }
});

// ── POST /api/ai/social-content ───────────────────────────────
router.post('/social-content', featureGate('ai-recommendations'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { tenantId, planSlug } = getTenantContext();

    if (planSlug === 'starter') {
      res.status(403).json({
        error: 'plan_insufficient',
        message: 'Social Content generation is available from the Growth plan.',
        upgradeRequired: true,
        requiredPlan: 'growth',
      });
      return;
    }

    const hasCredits = await checkCreditPreCheck(tenantId, planSlug);
    if (!hasCredits) {
      res.status(402).json({ error: 'credits_exhausted', message: 'Monthly AI credit limit reached.' });
      return;
    }

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
      'behind-the-scenes': 'Show the real, unpolished side of running a store. Authenticity wins.',
      'promotional':       'Drive action. Clear offer, clear benefit, clear CTA.',
    };

    const platformGuide: Record<string, string> = {
      instagram: 'Visual-first. Hook in first line. Use line breaks. 3-5 hashtags at end.',
      tiktok:    'Ultra-short, punchy. Hook must land in first 2 seconds when read aloud. No hashtag blocks.',
      linkedin:  'Professional tone. Start with insight or bold claim. Paragraphs, no hashtag spam.',
      facebook:  'Conversational. Can be longer. Ask a question to drive comments.',
      twitter:   'Under 250 chars. Punchy. One clear idea.',
    };

    const formatGuide: Record<string, string> = {
      single:   'One complete social media post.',
      carousel: 'A carousel post: array of slides, each with "title" and "body" (max 2 lines each). Include a strong hook slide and a CTA slide.',
      reel:     'A Reel/TikTok script: array of scenes, each with "visual" (what to film) and "text" (on-screen text, max 8 words).',
    };

    const outputFormat: Record<string, string> = {
      single:   '[{"caption":"...","hashtags":["..."],"cta":"..."}]',
      carousel: '[{"type":"carousel","slides":[{"title":"...","body":"..."}],"caption":"...","cta":"..."}]',
      reel:     '[{"type":"reel","scenes":[{"visual":"...","text":"..."}],"voiceover":"...","music_vibe":"..."}]',
    };

    const prompt = `You are a world-class social media strategist for ecommerce brands.
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

    await trackUsage(tenantId, count, planSlug);

    logger.info('ai.social-content.generated', { tenantId, platform, tone, topic, count });
    res.json({ posts });
  } catch (err) { next(err); }
});

// ── POST /api/ai/generate-image ───────────────────────────────
router.post('/generate-image', featureGate('ai-recommendations'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { tenantId, planSlug } = getTenantContext();

    if (planSlug === 'starter') {
      res.status(403).json({
        error: 'plan_insufficient',
        message: 'AI image generation is available from the Growth plan.',
        upgradeRequired: true,
        requiredPlan: 'growth',
      });
      return;
    }

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

    await trackUsage(tenantId, 1, planSlug);
    logger.info('ai.generate-image.complete', { tenantId, index });
    res.json({ imageUrl: result.imageUrl });
  } catch (err) { next(err); }
});

// ── POST /api/ai/video-script ─────────────────────────────────
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
    };

    const formatGuide: Record<string, string> = {
      'tiktok-30s': '30 seconds. ~75 words max. Hook (3s) → Problem (7s) → Solution/Insight (15s) → CTA (5s). Count words.',
      'tiktok-60s': '60 seconds. ~150 words max. Richer story arc. Can include a mini case study.',
      'instagram-reel': '15-30 seconds. Punchy. Visual-first language. Tell the viewer what to look at.',
    };

    const prompt = `You are writing a ${format || 'TikTok'} video script for MarketGrow, an AI ecommerce analytics tool.
ANGLE: ${angleGuide[angle || 'problem-reveal'] || angle}
FORMAT: ${formatGuide[format || 'tiktok-30s'] || format}
SCENARIO: ${scenario}
${total && index !== undefined ? `This is script ${index + 1} of ${total}. Make it DIFFERENT from the others — different hook, different angle, different examples.` : ''}

Return ONLY JSON:
{
  "hook": "First 1-2 sentences spoken — must grab attention immediately",
  "body": "Main content — spoken words only, no stage directions",
  "cta": "Final call to action — 1 sentence",
  "onScreenText": ["Text overlay 1", "Text overlay 2", "Text overlay 3"],
  "estimatedSeconds": 30,
  "visualNotes": "Brief note on what to show on screen"
}`;

    const response = await anthropic.messages.create({
      model:      'claude-sonnet-4-20250514',
      max_tokens: 800,
      messages:   [{ role: 'user', content: prompt }],
    });

    const text  = response.content[0].type === 'text' ? response.content[0].text : '{}';
    const clean = text.replace(/```json|```/g, '').trim();

    let script;
    try { script = JSON.parse(clean); }
    catch { script = { hook: text.slice(0, 100), body: text, cta: '', onScreenText: [] }; }

    logger.info('ai.video-script.generated', { userId, scenario, format, angle });
    res.json(script);
  } catch (err) { next(err); }
});

// ── GET /api/ai/products ──────────────────────────────────────
router.get('/products', featureGate('ai-recommendations'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { tenantId } = getTenantContext();

    const result = await db.query(
      `SELECT p.id, p.title, p.sku, p.platform, p.price_min,
              p.total_inventory, p.image_url, p.external_url,
              COALESCE(SUM(li.quantity), 0) AS units_sold
       FROM products p
       LEFT JOIN order_line_items li ON li.product_id = p.id
         AND li.tenant_id = p.tenant_id
       WHERE p.tenant_id = $1 AND p.status = 'active'
       GROUP BY p.id
       ORDER BY units_sold DESC, p.updated_at DESC
       LIMIT 50`,
      [tenantId], { allowNoTenant: true }
    );

    res.json({ products: result.rows });
  } catch (err) { next(err); }
});

// ── POST /api/ai/product-content ─────────────────────────────
router.post('/product-content', featureGate('ai-recommendations'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { tenantId, planSlug } = getTenantContext();

    if (planSlug === 'starter') {
      res.status(403).json({
        error: 'plan_insufficient',
        message: 'Product content generation is available from the Growth plan.',
        upgradeRequired: true,
        requiredPlan: 'growth',
      });
      return;
    }

    const hasCredits = await checkCreditPreCheck(tenantId, planSlug);
    if (!hasCredits) {
      res.status(402).json({ error: 'credits_exhausted', message: 'Monthly AI credit limit reached.' });
      return;
    }

    const { productId, formats } = validate(ProductContentSchema, req.body);

    const productResult = await db.query(
      `SELECT p.id, p.title, p.sku, p.platform, p.price_min,
              p.total_inventory, p.image_url,
              COALESCE(SUM(li.quantity), 0) AS units_sold,
              COALESCE(SUM(li.total_price), 0) AS total_revenue
       FROM products p
       LEFT JOIN order_line_items li ON li.product_id = p.id AND li.tenant_id = p.tenant_id
       WHERE p.id = $1 AND p.tenant_id = $2
       GROUP BY p.id`,
      [productId, tenantId], { allowNoTenant: true }
    );

    const product = productResult.rows[0];
    if (!product) {
      res.status(404).json({ error: 'Product not found' });
      return;
    }

    const prompt = `You are a world-class ecommerce copywriter and content strategist.
Product: "${product.title}" (${product.platform}, SKU: ${product.sku || 'N/A'})
Price: €${product.price_min || 0} | Units sold: ${product.units_sold} | Revenue: €${parseFloat(product.total_revenue || 0).toFixed(0)}

Generate complete marketing content for this product. Return ONLY JSON:
{
  "adHeadlines": ["headline1", "headline2", "headline3"],
  "adDescriptions": ["desc1 (max 90 chars)", "desc2 (max 90 chars)"],
  "instagramCaption": "...",
  "instagramHashtags": ["tag1", "tag2"],
  "tiktokHook": "First 3 seconds spoken — ultra punchy",
  "emailSubjectLine": "...",
  "seoTitle": "...",
  "seoMetaDescription": "max 155 chars",
  "keyBenefits": ["benefit1", "benefit2", "benefit3"]
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
    catch { content = { error: 'Failed to parse content' }; }

    await trackUsage(tenantId, 3, planSlug);

    logger.info('ai.product-content.generated', { tenantId, productId });
    res.json({ content, product: { id: product.id, title: product.title } });
  } catch (err) { next(err); }
});

export { router as aiRouter };
export default router;
