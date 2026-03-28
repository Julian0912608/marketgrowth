// ============================================================
// Toevoegen aan src/modules/ai-engine/api/ai.routes.ts
//
// GET  /api/ai/products          — lijst van eigen producten
// POST /api/ai/product-content   — genereer marketing content + beeld
//                                  voor een specifiek product
// ============================================================

// ── GET /api/ai/products ──────────────────────────────────────
// Haalt de producten van de tenant op voor de content selector
// Exporteerbaar als losse router entry — voeg toe aan ai.routes.ts

import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { tenantMiddleware }   from '../../../shared/middleware/tenant.middleware';
import { featureGate }        from '../../../shared/middleware/feature-gate.middleware';
import { getTenantContext }   from '../../../shared/middleware/tenant-context';
import { db }                 from '../../../infrastructure/database/connection';
import { logger }             from '../../../shared/logging/logger';

export const productContentRouter = Router();
productContentRouter.use(tenantMiddleware());

const anthropic = require('@anthropic-ai/sdk').default
  ? new (require('@anthropic-ai/sdk').default)({ apiKey: process.env.ANTHROPIC_API_KEY })
  : new (require('@anthropic-ai/sdk').Anthropic)({ apiKey: process.env.ANTHROPIC_API_KEY });

const ProductContentSchema = z.object({
  productId:   z.string().min(1),
  platform:    z.enum(['instagram', 'tiktok', 'facebook', 'pinterest']),
  format:      z.enum(['single', 'carousel', 'story']),
  tone:        z.enum(['lifestyle', 'promotional', 'educational', 'ugc']),
  language:    z.enum(['nl', 'en']).default('nl'),
  generateImage: z.boolean().default(true),
});

function validate<T>(schema: z.ZodSchema<T>, data: unknown): T {
  const result = schema.safeParse(data);
  if (!result.success) {
    const msg = result.error.errors.map(e => e.message).join(', ');
    throw Object.assign(new Error(msg), { httpStatus: 400 });
  }
  return result.data;
}

// ── GET /api/ai/products ──────────────────────────────────────
productContentRouter.get('/products', featureGate('ai-recommendations'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { tenantId } = getTenantContext();
    const { search, limit = '20', offset = '0' } = req.query as Record<string, string>;

    const searchFilter = search
      ? `AND (p.title ILIKE $3 OR p.ean ILIKE $3)`
      : '';
    const params: any[] = [tenantId, parseInt(limit)];
    if (search) params.push(`%${search}%`);

    const result = await db.query(
      `SELECT
         p.id, p.title, p.status, p.price_min, p.price_max,
         p.total_inventory, p.ean, p.condition, p.fulfillment_by,
         p.platform_slug, ti.shop_name, ti.platform_slug AS platform,
         -- Performance data laatste 30 dagen
         COALESCE(SUM(li.total_price), 0)   AS revenue_30d,
         COALESCE(SUM(li.quantity), 0)       AS units_30d,
         COALESCE(COUNT(DISTINCT o.id), 0)   AS orders_30d
       FROM products p
       JOIN tenant_integrations ti ON ti.id = p.integration_id
       LEFT JOIN order_line_items li ON li.product_id = p.external_id
         AND li.tenant_id = $1
       LEFT JOIN orders o ON o.id = li.order_id
         AND o.ordered_at >= now() - INTERVAL '30 days'
         AND o.status NOT IN ('cancelled', 'refunded')
       WHERE p.tenant_id = $1
         AND p.status = 'active'
         AND ti.status = 'active'
         ${searchFilter}
       GROUP BY p.id, ti.shop_name, ti.platform_slug
       ORDER BY revenue_30d DESC, p.title ASC
       LIMIT $2`,
      params,
      { allowNoTenant: true }
    );

    res.json({
      products: result.rows.map(p => ({
        id:           p.id,
        title:        p.title,
        ean:          p.ean,
        priceMin:     p.price_min ? parseFloat(p.price_min) : null,
        priceMax:     p.price_max ? parseFloat(p.price_max) : null,
        inventory:    parseInt(p.total_inventory ?? 0),
        platform:     p.platform,
        shopName:     p.shop_name,
        fulfillmentBy: p.fulfillment_by,
        revenue30d:   parseFloat(p.revenue_30d ?? 0),
        units30d:     parseInt(p.units_30d ?? 0),
        orders30d:    parseInt(p.orders_30d ?? 0),
      })),
    });
  } catch (err) { next(err); }
});

// ── POST /api/ai/product-content ──────────────────────────────
productContentRouter.post('/product-content', featureGate('ai-recommendations'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { tenantId } = getTenantContext();
    const { productId, platform, format, tone, language, generateImage } = validate(ProductContentSchema, req.body);

    // Haal productdetails op
    const productResult = await db.query(
      `SELECT p.*, ti.shop_name, ti.platform_slug AS platform_name,
              COALESCE(SUM(li.total_price), 0) AS revenue_30d,
              COALESCE(SUM(li.quantity), 0)     AS units_30d
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
    const price = product.price_min ? `€${parseFloat(product.price_min).toFixed(2)}` : 'prijs onbekend';
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
      ? `This product has sold ${units} units (€${revenue.toFixed(0)} revenue) in the last 30 days — it's a proven seller.`
      : 'This product has not sold in the last 30 days — position it to drive initial sales.';

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

Also provide a detailed image_prompt field: describe the ideal marketing visual for this product.
The visual should be: professional product photography style, clean background, lifestyle context fitting the tone.
Include specific details: lighting, composition, props, mood.

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

    // Genereer beeld als gevraagd
    let imageUrl: string | null = null;
    if (generateImage && content.image_prompt) {
      try {
        const { generateAdCreative } = require('../../ai-engine/services/nano-banana.service');
        const imageResult = await generateAdCreative({
          product: {
            title:    product.title,
            platform: platform,
          },
          format:   format === 'story' ? 'story' : 'single',
          platform: platform,
          style:    tone === 'lifestyle' ? 'lifestyle' : 'minimal',
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

    // Track usage
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

    logger.info('ai.product-content.generated', { tenantId, productId, platform, format, tone });
    res.json({ ...content, imageUrl, product: { title: product.title, price } });

  } catch (err) { next(err); }
});
