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
// SCHEMA FIXES:
//   - p.sku → p.ean AS sku (Bol.com EAN als SKU equivalent)
//   - p.platform → JOIN tenant_integrations voor platform_slug
//
// PR 3a.1: p.image_url is een echte kolom (na migration 007)
// PR 3a.4: GET /products geeft nu has_enrichment + has_description
//          terug zodat frontend "Geen context" badge kan tonen
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

const Anthropic = require('@anthropic-ai/sdk');
const anthropic = new (Anthropic.default ?? Anthropic)();

// ── Cache TTL per plan (seconden) ─────────────────────────────
const CACHE_TTL: Record<string, number> = {
  starter: 14400,
  growth:  3600,
  scale:   1800,
};

// ── Plan credit limieten ──────────────────────────────────────
const PLAN_LIMITS: Record<string, number | null> = {
  starter: 100,
  growth:  2000,
  scale:   null,
};

// ── IP rate limiter voor AI routes ────────────────────────────
const AI_RATE_LIMIT = 30;
const AI_RATE_WINDOW = 60;

async function checkIpRateLimit(req: Request): Promise<boolean> {
  const rawRedis = require('../../../infrastructure/cache/redis').redis as any;
  const ip = req.ip ?? req.headers['x-forwarded-for'] ?? 'unknown';
  const key = `ratelimit:ai:ip:${ip}`;
  try {
    const current = await rawRedis.incr(key);
    if (current === 1) await rawRedis.expire(key, AI_RATE_WINDOW);
    return current <= AI_RATE_LIMIT;
  } catch {
    return true;
  }
}

// ── Redis-backed credit pre-check ────────────────────────────
async function checkCreditPreCheck(tenantId: string, planSlug: string): Promise<boolean> {
  const limit = PLAN_LIMITS[planSlug];
  if (limit === null) return true;

  const rawRedis = require('../../../infrastructure/cache/redis').redis as any;
  const key = `ai:credits:used:${tenantId}:${new Date().toISOString().slice(0, 7)}`;

  try {
    const used = await rawRedis.get(key);
    if (used !== null && parseInt(used) >= limit) {
      logger.info('ai.credits.limit_reached_redis', { tenantId, planSlug, used, limit });
      return false;
    }
  } catch {
    // Redis niet beschikbaar — val terug op DB check
  }

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
    logger.warn('ai.usage.tracking_failed', {
      tenantId,
      count,
      error: (err as Error).message,
    });
  }

  try {
    const rawRedis = require('../../../infrastructure/cache/redis').redis as any;
    const key = `ai:credits:used:${tenantId}:${new Date().toISOString().slice(0, 7)}`;
    await rawRedis.incrby(key, count);
    await rawRedis.expire(key, 35 * 24 * 3600);
  } catch {}
}

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
        message: `You've used all ${limit} AI credits this month. Upgrade for more.`,
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
      ? `You are an AI ecommerce advisor for MarketGrow. Analyze the data and give a concise daily briefing in JSON.
Data: ${stats.orders} orders, €${parseFloat(stats.revenue).toFixed(0)} revenue, AOV €${parseFloat(stats.avg_order_value).toFixed(0)}, ad spend €${parseFloat(ads.total_spend).toFixed(0)}, ROAS ${parseFloat(ads.avg_roas).toFixed(2)}x.
Return ONLY JSON: {"briefing":"2-3 sentences","actions":[{"priority":"high|medium|low","title":"string","description":"string","channel":"string"}],"alerts":["string"]}`
      : `Return ONLY JSON: {"briefing":"Connect your first store to receive AI insights. Once orders come in you will see your daily briefing here.","actions":[{"priority":"medium","title":"Connect your store","description":"Go to Integrations and connect your first shop to unlock AI insights.","channel":"general"}],"alerts":[]}`;

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

    const limit = PLAN_LIMITS[planSlug] ?? 100;
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

    const response = await anthropic.messages.create({
      model:      'claude-sonnet-4-20250514',
      max_tokens: 1500,
      system:     'You are an AI ecommerce advisor for MarketGrow users. You help entrepreneurs with concrete advice on their webshop, marketing, and growth. Keep answers clear and actionable.',
      messages:   [{ role: 'user', content: message }],
    });

    const reply = response.content[0].type === 'text' ? response.content[0].text : '';
    await trackUsage(tenantId, 1, planSlug);

    res.json({ reply });
  } catch (err) { next(err); }
});

// ── POST /api/ai/social-content ───────────────────────────────
router.post('/social-content', featureGate('ai-recommendations'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { tenantId, planSlug } = getTenantContext();

    if (planSlug === 'starter') {
      res.status(403).json({
        error: 'plan_insufficient',
        message: 'Social content generation is available from the Growth plan.',
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

    const input = validate(SocialContentSchema, req.body);

    const count = input.count ?? 1;
    const prompt = `Generate ${count} ${input.platform} ${input.format ?? 'post'} variant${count > 1 ? 's' : ''} about: ${input.topic}.
Tone: ${input.tone}.
${input.customContext ? `Context: ${input.customContext}` : ''}

Return ONLY JSON array of ${count}: [{"hook":"...","caption":"...","cta":"...","hashtags":["tag1","tag2"]}]`;

    const response = await anthropic.messages.create({
      model:      'claude-sonnet-4-20250514',
      max_tokens: 1500,
      messages:   [{ role: 'user', content: prompt }],
    });

    const text  = response.content[0].type === 'text' ? response.content[0].text : '[]';
    const clean = text.replace(/```json|```/g, '').trim();

    let content;
    try { content = JSON.parse(clean); }
    catch { content = [{ error: 'Failed to parse content' }]; }

    await trackUsage(tenantId, count * 2, planSlug);
    res.json({ variants: content });
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

    const hasCredits = await checkCreditPreCheck(tenantId, planSlug);
    if (!hasCredits) {
      res.status(402).json({ error: 'credits_exhausted', message: 'Monthly AI credit limit reached.' });
      return;
    }

    const input = validate(GenerateImageSchema, req.body);

    const { generateAdCreative } = await import('../services/nano-banana.service');

    const result = await generateAdCreative({
      product:    { title: input.slideTitle ?? 'Product', platform: 'shopify' },
      format:     'single',
      platform:   'meta',
      style:      'minimal',
    });

    await trackUsage(tenantId, 2, planSlug);
    res.json(result);
  } catch (err) { next(err); }
});

// ── POST /api/ai/video-script ─────────────────────────────────
router.post('/video-script', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { tenantId, userId, planSlug } = getTenantContext();

    if (planSlug === 'starter') {
      res.status(403).json({
        error: 'plan_insufficient',
        message: 'Video script generation is available from the Growth plan.',
      });
      return;
    }

    const hasCredits = await checkCreditPreCheck(tenantId, planSlug);
    if (!hasCredits) {
      res.status(402).json({ error: 'credits_exhausted' });
      return;
    }

    const { scenario, format, angle } = validate(VideoScriptSchema, req.body);

    const prompt = `Generate a ${format ?? 'short'} video script for: ${scenario}.
Angle: ${angle ?? 'educational'}.
Return ONLY JSON: {"hook":"first 3 sec hook","body":"main content","cta":"closing CTA","onScreenText":["text1","text2"]}`;

    const response = await anthropic.messages.create({
      model:      'claude-sonnet-4-20250514',
      max_tokens: 1500,
      messages:   [{ role: 'user', content: prompt }],
    });

    const text  = response.content[0].type === 'text' ? response.content[0].text : '{}';
    const clean = text.replace(/```json|```/g, '').trim();

    let script;
    try { script = JSON.parse(clean); }
    catch { script = { hook: text.slice(0, 100), body: text, cta: '', onScreenText: [] }; }

    await trackUsage(tenantId, 1, planSlug);

    logger.info('ai.video-script.generated', { userId, scenario, format, angle });
    res.json(script);
  } catch (err) { next(err); }
});

// ── GET /api/ai/products ──────────────────────────────────────
// PR 3a.1: gebruikt p.image_url uit migration 007
// PR 3a.4: voegt has_enrichment + has_description toe voor frontend badge
router.get('/products', featureGate('ai-recommendations'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { tenantId } = getTenantContext();

    const result = await db.query(
      `SELECT p.id, p.title,
              p.ean AS sku,
              COALESCE(ti.platform_slug, 'unknown') AS platform,
              p.price_min,
              p.total_inventory,
              p.image_url,
              COALESCE(SUM(li.quantity), 0) AS units_sold,
              CASE
                WHEN p.description IS NOT NULL AND LENGTH(p.description) > 50 THEN true
                ELSE false
              END AS has_description,
              CASE
                WHEN pe.id IS NOT NULL THEN true
                ELSE false
              END AS has_enrichment
       FROM products p
       LEFT JOIN tenant_integrations ti ON ti.id = p.integration_id
       LEFT JOIN order_line_items li ON li.product_id = p.id::text
         AND li.tenant_id = p.tenant_id
       LEFT JOIN product_enrichment pe ON pe.product_id = p.id
         AND pe.tenant_id = p.tenant_id
       WHERE p.tenant_id = $1 AND p.status = 'active'
       GROUP BY p.id, ti.platform_slug, pe.id
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

    const { productId } = validate(ProductContentSchema, req.body);

    const productResult = await db.query(
      `SELECT p.id, p.title,
              p.ean AS sku,
              COALESCE(ti.platform_slug, 'unknown') AS platform,
              p.price_min,
              p.total_inventory, p.image_url,
              COALESCE(SUM(li.quantity), 0) AS units_sold,
              COALESCE(SUM(li.total_price), 0) AS total_revenue
       FROM products p
       LEFT JOIN tenant_integrations ti ON ti.id = p.integration_id
       LEFT JOIN order_line_items li ON li.product_id = p.id::text AND li.tenant_id = p.tenant_id
       WHERE p.id = $1 AND p.tenant_id = $2
       GROUP BY p.id, ti.platform_slug`,
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
