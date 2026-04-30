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
// PR 3a.4 UPDATE:
//   GET /api/ai/products geeft nu has_enrichment boolean terug,
//   zodat de frontend "Geen context" badge kan tonen op producten
//   zonder enrichment.
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

// ── IP-based rate limiting (in-memory, simple) ────────────────
const ipCounters = new Map<string, { count: number; resetAt: number }>();
function checkIpRateLimit(ip: string, max = 30, windowMs = 60_000): boolean {
  const now = Date.now();
  const entry = ipCounters.get(ip);
  if (!entry || now > entry.resetAt) {
    ipCounters.set(ip, { count: 1, resetAt: now + windowMs });
    return true;
  }
  if (entry.count >= max) return false;
  entry.count++;
  return true;
}

router.use((req: Request, res: Response, next: NextFunction) => {
  const ip = (req.ip || req.socket.remoteAddress || 'unknown').replace(/^::ffff:/, '');
  if (!checkIpRateLimit(ip)) {
    res.status(429).json({ error: 'Too many requests, slow down.' });
    return;
  }
  next();
});

// ── Helpers ───────────────────────────────────────────────────
function validate<T>(schema: z.ZodSchema<T>, data: unknown): T {
  const result = schema.safeParse(data);
  if (!result.success) {
    throw Object.assign(new Error(result.error.errors.map(e => `${e.path.join('.')}: ${e.message}`).join(', ')), { httpStatus: 400 });
  }
  return result.data;
}

async function checkCreditPreCheck(tenantId: string, planSlug: string): Promise<boolean> {
  const limits: Record<string, number> = { starter: 100, growth: 2000, scale: 10000 };
  const limit = limits[planSlug] ?? 100;

  try {
    const result = await db.query(
      `SELECT COALESCE(SUM(usage_count), 0) AS total
       FROM feature_usage fu
       JOIN features f ON f.id = fu.feature_id
       WHERE fu.tenant_id = $1
         AND f.slug = 'ai-recommendations'
         AND fu.period_start = date_trunc('month', now())`,
      [tenantId], { allowNoTenant: true }
    );
    const used = parseInt(result.rows[0]?.total ?? '0', 10);
    return used < limit;
  } catch {
    return true; // fail-open op DB error
  }
}

async function trackUsage(tenantId: string, count: number, planSlug: string): Promise<void> {
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
  } catch (err) {
    logger.warn('ai.usage.track_failed', { tenantId, planSlug, error: (err as Error).message });
  }
}

// ── Validation schemas ────────────────────────────────────────
const ChatSchema = z.object({
  message:  z.string().min(1).max(2000),
  history:  z.array(z.object({
    role:    z.enum(['user', 'assistant']),
    content: z.string(),
  })).max(10).optional(),
});

const SocialContentSchema = z.object({
  platform:    z.enum(['instagram', 'tiktok', 'facebook', 'pinterest']),
  format:      z.enum(['single', 'carousel', 'story']),
  productId:   z.string().uuid().optional(),
  prompt:      z.string().max(500).optional(),
  tone:        z.enum(['lifestyle', 'promotional', 'educational', 'ugc']).default('lifestyle'),
  language:    z.enum(['nl', 'en']).default('nl'),
});

const GenerateImageSchema = z.object({
  productId:   z.string().uuid().optional(),
  prompt:      z.string().min(5).max(1000),
  platform:    z.enum(['instagram', 'tiktok', 'meta', 'google']).default('meta'),
  format:      z.enum(['single', 'carousel', 'story', 'banner']).default('single'),
  style:       z.enum(['minimal', 'bold', 'lifestyle', 'product-focus']).default('minimal'),
  brandColor:  z.string().optional(),
});

const VideoScriptSchema = z.object({
  scenario:   z.string().min(5).max(500),
  format:     z.enum(['short', 'long']).default('short'),
  angle:      z.enum(['educational', 'entertaining', 'inspirational', 'promotional']).default('educational'),
  language:   z.enum(['nl', 'en']).default('nl'),
});

const ProductContentSchema = z.object({
  productId:   z.string().uuid(),
  formats:     z.array(z.string()).optional(),
});

// ── GET /api/ai/insights ──────────────────────────────────────
router.get('/insights', featureGate('ai-recommendations'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { tenantId, planSlug } = getTenantContext();

    const cached = await cache.get(`ai:insights:${tenantId}`);
    if (cached) {
      const cachedObj = cached as unknown as Record<string, unknown>;
      res.json({ ...cachedObj, cached: true });
      return;
    }

    const hasCredits = await checkCreditPreCheck(tenantId, planSlug);
    if (!hasCredits) {
      res.status(402).json({
        error:           'credits_exhausted',
        message:         `Monthly AI credit limit reached for the ${planSlug} plan. Upgrade to get more.`,
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

    const text  = response.content[0].type === 'text' ? response.content[0].text : '{}';
    const clean = text.replace(/```json|```/g, '').trim();

    let payload;
    try { payload = JSON.parse(clean); }
    catch { payload = { briefing: 'AI inzichten konden niet worden gegenereerd.', actions: [], alerts: [] }; }

    payload.metrics = {
      orders30d: parseInt(stats.orders),
      revenue30d: parseFloat(stats.revenue),
      aov: parseFloat(stats.avg_order_value),
      adSpend: parseFloat(ads.total_spend),
      roas: parseFloat(ads.avg_roas),
    };

    await cache.set(`ai:insights:${tenantId}`, payload, 3600);
    await trackUsage(tenantId, 1, planSlug);

    res.json(payload);
  } catch (err) { next(err); }
});

// ── GET /api/ai/credits ───────────────────────────────────────
router.get('/credits', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { tenantId, planSlug } = getTenantContext();

    const limits: Record<string, number> = { starter: 100, growth: 2000, scale: 10000 };
    const limit = limits[planSlug] ?? 100;

    const result = await db.query(
      `SELECT COALESCE(SUM(usage_count), 0) AS total
       FROM feature_usage fu
       JOIN features f ON f.id = fu.feature_id
       WHERE fu.tenant_id = $1
         AND f.slug = 'ai-recommendations'
         AND fu.period_start = date_trunc('month', now())`,
      [tenantId], { allowNoTenant: true }
    );

    const used = parseInt(result.rows[0]?.total ?? '0', 10);

    res.json({
      used,
      limit,
      remaining: Math.max(0, limit - used),
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
        error:           'plan_insufficient',
        message:         'AI Chat is available from the Growth plan.',
        upgradeRequired: true,
        requiredPlan:    'growth',
      });
      return;
    }

    const hasCredits = await checkCreditPreCheck(tenantId, planSlug);
    if (!hasCredits) {
      res.status(402).json({ error: 'credits_exhausted', message: 'Monthly AI credit limit reached.' });
      return;
    }

    const { message, history = [] } = validate(ChatSchema, req.body);

    const messages = [
      ...history.map(h => ({ role: h.role, content: h.content })),
      { role: 'user' as const, content: message },
    ];

    const response = await anthropic.messages.create({
      model:      'claude-sonnet-4-20250514',
      max_tokens: 1500,
      system:     'Je bent een AI ecommerce adviseur voor MarketGrow gebruikers. Je helpt ondernemers met concrete adviezen over hun webshop, marketing, en groei. Houd antwoorden helder en actionable.',
      messages,
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

    let productContext = '';
    if (input.productId) {
      const productResult = await db.query(
        `SELECT title, sku, platform_slug AS platform, price_min,
                COALESCE((SELECT SUM(quantity) FROM order_line_items WHERE product_id = p.id::text), 0) AS units_sold
         FROM products p WHERE p.id = $1 AND p.tenant_id = $2`,
        [input.productId, tenantId], { allowNoTenant: true }
      );
      const product = productResult.rows[0];
      if (product) {
        productContext = `Product: ${product.title} (${product.platform}, €${product.price_min ?? 0}, ${product.units_sold} verkocht)`;
      }
    }

    const prompt = `Genereer ${input.platform} ${input.format} content in ${input.language}.
${productContext}
Tone: ${input.tone}. ${input.prompt ?? ''}

Return ONLY JSON: {"hook":"...","caption":"...","cta":"...","hashtags":["tag1","tag2"]}`;

    const response = await anthropic.messages.create({
      model:      'claude-sonnet-4-20250514',
      max_tokens: 800,
      messages:   [{ role: 'user', content: prompt }],
    });

    const text  = response.content[0].type === 'text' ? response.content[0].text : '{}';
    const clean = text.replace(/```json|```/g, '').trim();

    let content;
    try { content = JSON.parse(clean); }
    catch { content = { error: 'Failed to parse content' }; }

    await trackUsage(tenantId, 2, planSlug);
    res.json(content);
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

    let productCtx: any = { title: 'Product', platform: 'shopify' };
    if (input.productId) {
      const r = await db.query(
        `SELECT title, sku, platform_slug AS platform, price_min,
                description, image_url
         FROM products p WHERE p.id = $1 AND p.tenant_id = $2`,
        [input.productId, tenantId], { allowNoTenant: true }
      );
      if (r.rows[0]) {
        productCtx = {
          title:       r.rows[0].title,
          description: r.rows[0].description,
          price:       r.rows[0].price_min ? parseFloat(r.rows[0].price_min) : undefined,
          platform:    r.rows[0].platform,
          imageUrl:    r.rows[0].image_url,
        };
      }
    }

    const result = await generateAdCreative({
      product:    productCtx,
      format:     input.format     as 'single' | 'carousel' | 'story' | 'banner',
      platform:   input.platform   as 'instagram' | 'tiktok' | 'meta' | 'google',
      style:      input.style      as 'minimal' | 'bold' | 'lifestyle' | 'product-focus',
      brandColor: input.brandColor,
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

    const input = validate(VideoScriptSchema, req.body);

    const prompt = `Generate a ${input.format} video script for ${input.scenario}.
Angle: ${input.angle}. Language: ${input.language}.
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

    logger.info('ai.video-script.generated', { userId, scenario: input.scenario, format: input.format, angle: input.angle });
    res.json(script);
  } catch (err) { next(err); }
});

// ── GET /api/ai/products ──────────────────────────────────────
// PR 3a.4 UPDATE: voegt has_enrichment boolean toe via LEFT JOIN
router.get('/products', featureGate('ai-recommendations'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { tenantId } = getTenantContext();

    const result = await db.query(
      `SELECT p.id, p.title,
              p.ean AS sku,
              COALESCE(ti.platform_slug, 'unknown') AS platform,
              p.price_min,
              p.total_inventory, p.image_url,
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

    const { productId, formats } = validate(ProductContentSchema, req.body);

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

export default router;
