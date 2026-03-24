// ============================================================
// src/modules/ai-engine/api/ai.routes.ts
// ============================================================

import { Router, Request, Response, NextFunction } from 'express';
import Anthropic from '@anthropic-ai/sdk';
import { db }               from '../../../infrastructure/database/connection';
import { cache }            from '../../../infrastructure/cache/redis';
import { getTenantContext } from '../../../shared/middleware/tenant-context';
import { tenantMiddleware } from '../../../shared/middleware/tenant.middleware';
import { logger }           from '../../../shared/logging/logger';
import { generateAdCreative, generateCarouselSlides } from '../services/nano-banana.service';

const router = Router();
router.use(tenantMiddleware());

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const CACHE_TTL: Record<string, number> = {
  starter: 86400,
  growth:  3600,
  scale:   3600,
};

// ── Image prompt helpers ──────────────────────────────────────

interface StoreData {
  revenue:    string;
  orders:     number;
  roas:       string;
  topProduct: string;
}

const TOPIC_VISUAL: Record<string, string> = {
  'roas':                'data dashboard with ROAS metrics, charts showing ad performance, clean analytics interface',
  'product-performance': 'ecommerce product display, bestseller badge, revenue stats overlay, product photography style',
  'ads-tips':            'advertising campaign interface, ad creative mockup, marketing strategy visual',
  'ecommerce-growth':    'growth chart trending upward, revenue milestone, scaling business visual',
  'platform-insights':   'multi-platform dashboard showing Shopify Bol.com Amazon logos, unified analytics screen',
};

const PLATFORM_VISUAL: Record<string, string> = {
  'instagram': '1:1 square format, Instagram-optimised, thumb-stopping, clean dark background, bold typography overlay space',
  'tiktok':    '9:16 vertical format, TikTok-style, energetic composition, bold colors, mobile-first design',
};

const TONE_VISUAL: Record<string, string> = {
  'educational':       'clean infographic style, minimal design, clear visual hierarchy, professional SaaS look',
  'inspirational':     'aspirational imagery, warm accent colors, success-oriented, motivational mood',
  'data-driven':       'data visualization, charts and numbers prominently featured, tech dark-mode aesthetic',
  'behind-the-scenes': 'authentic candid style, real workspace, natural lighting, relatable founder imagery',
};

function buildEnrichedImagePrompt(opts: {
  basePrompt:  string;
  platform:    string;
  topic:       string;
  tone:        string;
  format:      string;
  storeData:   StoreData;
}): string {
  const { basePrompt, platform, topic, tone, format, storeData } = opts;
  const topicVisual   = TOPIC_VISUAL[topic]   ?? 'ecommerce analytics dashboard';
  const platformStyle = PLATFORM_VISUAL[platform] ?? PLATFORM_VISUAL['instagram'];
  const toneStyle     = TONE_VISUAL[tone]     ?? 'clean professional design';

  return `Create a professional social media visual for an ecommerce analytics SaaS platform called MarketGrow.

TOPIC VISUAL: ${topicVisual}
STYLE: ${toneStyle}
FORMAT: ${platformStyle}
${storeData.topProduct ? `STORE CONTEXT: Top product is "${storeData.topProduct}"` : ''}
${storeData.roas !== '0.00' ? `PERFORMANCE CONTEXT: ${storeData.roas}x ROAS, ${storeData.orders} orders last 30 days` : ''}

CONTENT BRIEF: ${basePrompt}

DESIGN REQUIREMENTS:
- Brand colors: indigo #4f46e5 as primary accent, dark slate #0f172a background
- Leave clean space for text overlay (top or bottom third)
- No real people or faces
- No copyrighted logos or brand marks
- High-quality photorealistic output
- The visual must directly relate to: ${topic.replace(/-/g, ' ')}
${format === 'story' ? '- Vertical 9:16 format optimised for mobile stories' : ''}`;
}

function buildSlideImagePrompt(opts: {
  slideHeadline: string;
  slideBody:     string;
  visualHint:    string;
  basePrompt:    string;
  slideIndex:    number;
  totalSlides:   number;
  platform:      string;
  topic:         string;
  tone:          string;
  storeData:     StoreData;
}): string {
  const { slideHeadline, slideBody, visualHint, basePrompt, slideIndex, totalSlides, platform, topic, tone, storeData } = opts;
  const topicVisual   = TOPIC_VISUAL[topic]   ?? 'ecommerce analytics dashboard';
  const platformStyle = PLATFORM_VISUAL[platform] ?? PLATFORM_VISUAL['instagram'];
  const toneStyle     = TONE_VISUAL[tone]     ?? 'clean professional design';

  const slideRole = slideIndex === 1
    ? 'OPENING slide — strong visual hook, make viewers want to swipe'
    : slideIndex === totalSlides
    ? 'FINAL slide — clear call-to-action visual with MarketGrow branding'
    : `MIDDLE slide ${slideIndex} of ${totalSlides} — focused on: "${slideHeadline}"`;

  return `Create carousel slide ${slideIndex} of ${totalSlides} for a social media post about ecommerce analytics.

SLIDE ROLE: ${slideRole}
SLIDE CONTENT: "${slideHeadline}" — ${slideBody}
VISUAL HINT: ${visualHint}

TOPIC VISUAL: ${topicVisual}
STYLE: ${toneStyle}
FORMAT: ${platformStyle} — 1:1 square carousel slide
${storeData.topProduct ? `STORE CONTEXT: Top product "${storeData.topProduct}"` : ''}
${storeData.roas !== '0.00' ? `PERFORMANCE: ${storeData.roas}x ROAS` : ''}

DESIGN REQUIREMENTS:
- Brand colors: indigo #4f46e5 accent, dark slate #0f172a background
- Large readable area for headline: "${slideHeadline}"
- CONSISTENT visual style with other slides in this carousel
- No real people or faces
- High-quality photorealistic output
- Topic: ${topic.replace(/-/g, ' ')}`;
}

// ── GET /api/ai/insights ──────────────────────────────────────
router.get('/insights', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { tenantId, planSlug } = getTenantContext();
    const force    = req.query.force === 'true';
    const cacheKey = 'ai:insights:' + tenantId;

    if (!force) {
      const cached = await cache.get(cacheKey);
      if (cached) return res.json({ ...JSON.parse(cached), fromCache: true });
    }

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

    const stats        = ordersResult.rows[0];
    const topProducts  = productsResult.rows;
    const integrations = integrationsResult.rows;

    if (integrations.length === 0) {
      return res.json({
        briefing:  'Connect your first store to start receiving AI insights. Go to Integrations to link Bol.com, Shopify or another platform.',
        actions:   [{ priority: 'high', title: 'Connect your store', description: 'Go to Integrations and link your first platform.' }],
        alerts:    [],
        fromCache: false,
      });
    }

    const hasOrders = stats.total_orders > 0;

    const prompt = hasOrders
      ? `You are an ecommerce AI analyst. Analyse the data below and give an actionable daily briefing.

DATA:
- Orders (last 30 days): ${stats.total_orders}
- Revenue (last 30 days): €${parseFloat(stats.revenue).toFixed(2)}
- Avg order value: €${parseFloat(stats.avg_order_value).toFixed(2)}
- Connected platforms: ${integrations.map((i: any) => i.platform_slug).join(', ')}
- Top products: ${topProducts.map((p: any) => `${p.title} (${p.sold} sold, €${parseFloat(p.revenue).toFixed(0)})`).join(', ')}

Return ONLY valid JSON (no markdown):
{"briefing":"2-3 sentence summary of performance and key opportunity","actions":[{"priority":"high","title":"Action title","description":"Specific actionable recommendation"},{"priority":"medium","title":"Action title","description":"Specific actionable recommendation"},{"priority":"low","title":"Action title","description":"Specific actionable recommendation"}],"alerts":["Alert message if any issue detected"]}`
      : `You are an ecommerce AI analyst. The store has no orders yet.
Return ONLY valid JSON:
{"briefing":"Encourage connecting store and explain what insights will appear once data flows in","actions":[{"priority":"high","title":"Sync your store data","description":"Trigger a full sync from Integrations to start seeing insights."},{"priority":"medium","title":"Check sync status","description":"Go to Integrations and verify the sync is active."}],"alerts":[]}`;

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

// ── POST /api/ai/chat ─────────────────────────────────────────
router.post('/chat', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { tenantId, planSlug } = getTenantContext();

    if (planSlug === 'starter') {
      res.status(403).json({ error: 'AI Chat is available from the Growth plan.' });
      return;
    }

    const { message } = req.body;
    if (!message) { res.status(400).json({ error: 'Message is required' }); return; }

    const ordersResult = await db.query(
      `SELECT COUNT(*)::int AS orders, COALESCE(SUM(total_amount - tax_amount), 0) AS revenue
       FROM orders WHERE tenant_id = $1 AND ordered_at >= NOW() - INTERVAL '30 days'
       AND status NOT IN ('cancelled', 'refunded')`,
      [tenantId], { allowNoTenant: true }
    );
    const stats = ordersResult.rows[0];

    const response = await anthropic.messages.create({
      model:      'claude-sonnet-4-20250514',
      max_tokens: 500,
      system:     `You are an ecommerce AI advisor for MarketGrow. The user has ${stats.orders} orders and €${parseFloat(stats.revenue).toFixed(2)} revenue in the last 30 days. Answer in English, concise and actionable.`,
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

// ── GET /api/ai/credits ───────────────────────────────────────
router.get('/credits', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { tenantId, planSlug } = getTenantContext();

    const limits: Record<string, number | null> = {
      starter: 100,
      growth:  2000,
      scale:   null,
    };
    const limit     = limits[planSlug] ?? 100;
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

// ── POST /api/ai/social-content ───────────────────────────────
router.post('/social-content', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { tenantId, planSlug } = getTenantContext();

    if (planSlug === 'starter') {
      res.status(403).json({ error: 'Social Content Generator is available on Growth and Scale plans.' });
      return;
    }

    const {
      platform,
      tone,
      topic,
      format        = 'single',
      customContext = '',
      count         = 3,
      generateImage = false,
    } = req.body as {
      platform:       'instagram' | 'tiktok';
      tone:           string;
      topic:          string;
      format?:        'single' | 'carousel' | 'video_script';
      customContext?: string;
      count?:         number;
      generateImage?: boolean;
    };

    const [ordersResult, adsResult, topProductsResult, integrationsResult] = await Promise.all([
      db.query(
        `SELECT
           COUNT(*)::int                              AS total_orders,
           COALESCE(SUM(total_amount - tax_amount),0) AS revenue,
           COALESCE(AVG(total_amount - tax_amount),0) AS avg_order_value,
           COALESCE(MAX(total_amount - tax_amount),0) AS highest_order
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
           COALESCE(MAX(roas),0)        AS best_roas,
           COALESCE(SUM(impressions),0) AS total_impressions,
           COUNT(CASE WHEN status='active' THEN 1 END)::int AS active_campaigns
         FROM ad_campaigns
         WHERE tenant_id = $1 AND updated_at >= NOW() - INTERVAL '30 days'`,
        [tenantId], { allowNoTenant: true }
      ),
      db.query(
        `SELECT oli.title, SUM(oli.quantity)::int AS sold, SUM(oli.total_price) AS revenue
         FROM order_line_items oli
         JOIN orders o ON o.id = oli.order_id
         WHERE oli.tenant_id = $1
           AND o.ordered_at >= NOW() - INTERVAL '30 days'
           AND o.status NOT IN ('cancelled','refunded')
         GROUP BY oli.title ORDER BY revenue DESC LIMIT 3`,
        [tenantId], { allowNoTenant: true }
      ),
      db.query(
        `SELECT platform_slug FROM tenant_integrations WHERE tenant_id = $1 AND status = 'active'`,
        [tenantId], { allowNoTenant: true }
      ),
    ]);

    const orders      = ordersResult.rows[0];
    const ads         = adsResult.rows[0];
    const topProducts = topProductsResult.rows;
    const platforms   = integrationsResult.rows.map((r: any) => r.platform_slug).join(', ');

    const storeData: StoreData = {
      revenue:    parseFloat(orders.revenue).toFixed(0),
      orders:     orders.total_orders,
      roas:       parseFloat(ads.avg_roas).toFixed(2),
      topProduct: topProducts[0]?.title ?? '',
    };

    const topProductsText = topProducts.length > 0
      ? `Top products:\n${topProducts.map((p: any) => `  - ${p.title}: ${p.sold} sold, €${parseFloat(p.revenue).toFixed(0)} revenue`).join('\n')}`
      : '';

    const storeContext = `
REAL STORE DATA:
Sales (last 30 days):
- Orders: ${orders.total_orders}
- Revenue: €${parseFloat(orders.revenue).toFixed(0)}
- Average order value: €${parseFloat(orders.avg_order_value).toFixed(0)}
- Highest single order: €${parseFloat(orders.highest_order).toFixed(0)}

Advertising (last 30 days):
- Ad spend: €${parseFloat(ads.total_spend).toFixed(0)}
- Ad revenue attributed: €${parseFloat(ads.total_ad_revenue).toFixed(0)}
- Average ROAS: ${parseFloat(ads.avg_roas).toFixed(2)}x
- Best campaign ROAS: ${parseFloat(ads.best_roas).toFixed(2)}x
- Impressions: ${parseInt(ads.total_impressions).toLocaleString()}
- Active campaigns: ${ads.active_campaigns}

${topProductsText}
Connected platforms: ${platforms || 'not specified'}
${customContext ? `\nAdditional context: ${customContext}` : ''}`.trim();

    const formatGuide: Record<string, string> = {
      'single':       'Create a single standalone post with hook, caption, and CTA.',
      'carousel':     `Create a ${count}-slide carousel. Slide 1: hook/attention. Slides 2-${count-1}: one insight per slide. Last slide: CTA.`,
      'video_script': 'Create a 30-60 second video script. Hook (0-3s), main content (3-45s), CTA (45-60s). Spoken word, natural.',
    };

    const toneGuide: Record<string, string> = {
      'educational':       'Teach something actionable. Clear steps or insights.',
      'inspirational':     'Motivate and inspire. Focus on results and possibilities.',
      'data-driven':       'Lead with a surprising statistic. Let numbers tell the story.',
      'behind-the-scenes': 'Authentic and transparent. Share real experiences.',
    };

    const platformGuide: Record<string, string> = {
      instagram: 'Instagram: conversational, line breaks, emojis allowed, strong hook. 15-20 hashtags.',
      tiktok:    'TikTok: short and punchy, irresistible hook, CTA to follow/comment. 5-8 hashtags.',
    };

    const topicGuide: Record<string, string> = {
      'roas':                'Return on ad spend — true blended ROAS vs platform-reported ROAS, ad profitability',
      'product-performance': 'Which products sell best, product analytics, revenue per SKU, bestsellers',
      'ads-tips':            'Advertising tips for ecommerce, campaign optimisation, Meta/Google/Bol.com ads',
      'ecommerce-growth':    'Growing an ecommerce business, scaling, multi-channel selling, revenue milestones',
      'platform-insights':   'Selling on Shopify, Bol.com, Amazon, Etsy — platform-specific insights',
    };

    const jsonSchema = format === 'carousel'
      ? `[{"slides":[{"headline":"short bold headline","body":"2-3 sentences","visual_hint":"specific description of what image works best for THIS slide — be very specific about what is shown"}],"caption":"post caption","cta":"call to action","hashtags":[...],"image_prompt":"overall visual style and brand direction for the carousel"}]`
      : format === 'video_script'
      ? `[{"hook":"2-second opener","script":"full script with ... pauses","cta":"closing CTA","hashtags":[...],"image_prompt":"specific thumbnail visual — what is shown, style, colors, composition"}]`
      : `[{"hook":"scroll-stopping first line","caption":"post body","cta":"1 sentence CTA","hashtags":[...],"image_prompt":"specific image description — what is shown, style, composition, colors — directly related to ${topic}"}]`;

    const prompt = `You are a social media content expert for ecommerce entrepreneurs. Create ${format === 'carousel' ? '1 carousel post' : `${count} ${format === 'video_script' ? 'video script(s)' : 'post(s)'}`} for ${platform}.

TOPIC: ${topicGuide[topic] || topic}
TONE: ${toneGuide[tone] || tone}
FORMAT: ${formatGuide[format] || format}
PLATFORM: ${platformGuide[platform]}

${storeContext}

RULES:
- Write in English
- Use the store data naturally — tell a story, don't just list numbers
- The hook must stop the scroll immediately
- No corporate language — write like a founder talking to founders
- For image_prompt: be VERY specific and directly related to the topic "${topic.replace(/-/g, ' ')}". Example: instead of "a dashboard" write "dark-mode analytics dashboard showing ROAS chart with indigo accent colors, revenue line trending up, clean SaaS UI". Mention: composition, colors (indigo #4f46e5 brand), mood, exactly what is visible.
- For carousel slide visual_hints: each slide needs a UNIQUE specific visual — not generic, directly tied to that slide's content.

Return ONLY valid JSON array. No markdown, no explanation:
${jsonSchema}`;

    const response = await anthropic.messages.create({
      model:      'claude-sonnet-4-20250514',
      max_tokens: 3000,
      messages:   [{ role: 'user', content: prompt }],
    });

    const text  = response.content[0].type === 'text' ? response.content[0].text : '[]';
    const clean = text.replace(/```json|```/g, '').trim();

    let posts: any[];
    try {
      posts = JSON.parse(clean);
      if (!Array.isArray(posts)) posts = [posts];
    } catch { posts = []; }

    // ── Nano Banana beeldgeneratie ────────────────────────────
    if (generateImage && posts.length > 0 && process.env.GEMINI_API_KEY) {

      const generateSingleImage = async (imagePrompt: string): Promise<string | null> => {
        try {
          const geminiRes = await fetch(
            `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-image-preview:generateContent?key=${process.env.GEMINI_API_KEY}`,
            {
              method:  'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                contents: [{ parts: [{ text: imagePrompt }] }],
                generationConfig: { responseModalities: ['TEXT', 'IMAGE'] },
              }),
            }
          );
          if (!geminiRes.ok) return null;
          const imgData   = await geminiRes.json() as any;
          const imagePart = imgData.candidates?.[0]?.content?.parts?.find((p: any) => p.inlineData?.data);
          if (!imagePart) return null;
          return `data:${imagePart.inlineData.mimeType};base64,${imagePart.inlineData.data}`;
        } catch { return null; }
      };

      posts = await Promise.all(posts.map(async (post: any) => {
        if (!post.image_prompt) return post;

        if (format === 'carousel' && post.slides?.length > 0) {
          // Genereer een beeld PER slide
          const slideImages: (string | null)[] = [];
          for (let i = 0; i < post.slides.length; i++) {
            const slide = post.slides[i];
            const slidePrompt = buildSlideImagePrompt({
              slideHeadline: slide.headline,
              slideBody:     slide.body,
              visualHint:    slide.visual_hint,
              basePrompt:    post.image_prompt,
              slideIndex:    i + 1,
              totalSlides:   post.slides.length,
              platform,
              topic,
              tone,
              storeData,
            });
            const img = await generateSingleImage(slidePrompt);
            slideImages.push(img);
            // Kleine pauze tussen API calls
            if (i < post.slides.length - 1) await new Promise(r => setTimeout(r, 700));
          }
          return { ...post, slideImages };
        } else {
          // Single of video_script: 1 verrijkt beeld
          const enrichedPrompt = buildEnrichedImagePrompt({
            basePrompt: post.image_prompt,
            platform,
            topic,
            tone,
            format,
            storeData,
          });
          const generatedImage = await generateSingleImage(enrichedPrompt);
          return { ...post, generatedImage };
        }
      }));
    }

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

    logger.info('ai.social-content.generated', { tenantId, platform, tone, topic, format, count });
    res.json({ posts, format });
  } catch (err) { next(err); }
});

// ── POST /api/ai/generate-creative ───────────────────────────
router.post('/generate-creative', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { tenantId, planSlug } = getTenantContext();

    if (planSlug === 'starter') {
      res.status(403).json({ error: 'AI Creative Generator is available on Growth and Scale plans.' });
      return;
    }

    const {
      productTitle,
      productDescription,
      productPrice,
      productPlatform = 'shopify',
      productImageUrl,
      format   = 'single',
      platform = 'instagram',
      style    = 'minimal',
      slideCount = 3,
    } = req.body as {
      productTitle:        string;
      productDescription?: string;
      productPrice?:       number;
      productPlatform?:    string;
      productImageUrl?:    string;
      format?:             'single' | 'carousel' | 'story' | 'banner';
      platform?:           'instagram' | 'tiktok' | 'google' | 'meta';
      style?:              'minimal' | 'bold' | 'lifestyle' | 'product-focus';
      slideCount?:         number;
    };

    if (!productTitle) { res.status(400).json({ error: 'productTitle is required' }); return; }

    const salesResult = await db.query(
      `SELECT SUM(oli.total_price) AS revenue, SUM(oli.quantity)::int AS sold
       FROM order_line_items oli
       JOIN orders o ON o.id = oli.order_id
       WHERE oli.tenant_id = $1
         AND LOWER(oli.title) LIKE LOWER($2)
         AND o.ordered_at >= NOW() - INTERVAL '30 days'
         AND o.status NOT IN ('cancelled','refunded')`,
      [tenantId, `%${productTitle}%`], { allowNoTenant: true }
    );

    const adsResult = await db.query(
      `SELECT AVG(roas) AS avg_roas FROM ad_campaigns
       WHERE tenant_id = $1 AND LOWER(name) LIKE LOWER($2) AND updated_at >= NOW() - INTERVAL '30 days'`,
      [tenantId, `%${productTitle.split(' ')[0]}%`], { allowNoTenant: true }
    );

    const sales = salesResult.rows[0];
    const ads   = adsResult.rows[0];

    const productContext = {
      title:       productTitle,
      description: productDescription,
      price:       productPrice,
      platform:    productPlatform,
      revenue30d:  parseFloat(sales?.revenue ?? '0'),
      sold30d:     sales?.sold ?? 0,
      roas:        parseFloat(ads?.avg_roas ?? '0'),
      imageUrl:    productImageUrl,
    };

    let result;
    if (format === 'carousel') {
      const slides = await generateCarouselSlides(
        { product: productContext, format, platform, style },
        Math.min(slideCount, 5)
      );
      result = { type: 'carousel', slides };
    } else {
      const creative = await generateAdCreative({ product: productContext, format, platform, style });
      result = { type: 'single', creative };
    }

    try {
      await db.query(
        `INSERT INTO feature_usage (tenant_id, feature_id, period_start, period_end, usage_count)
         SELECT $1, f.id, date_trunc('month', now()),
                (date_trunc('month', now()) + interval '1 month - 1 day')::date, $2
         FROM features f WHERE f.slug = 'ai-recommendations'
         ON CONFLICT (tenant_id, feature_id, period_start)
         DO UPDATE SET usage_count = feature_usage.usage_count + $2, updated_at = now()`,
        [tenantId, format === 'carousel' ? slideCount : 1], { allowNoTenant: true }
      );
    } catch {}

    logger.info('ai.creative.generated', { tenantId, productTitle, format, platform });
    res.json(result);
  } catch (err) { next(err); }
});

// ── POST /api/ai/video-script (intern MarketGrow tool) ────────
router.post('/video-script', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { userId } = getTenantContext();

    const userResult = await db.query(
      `SELECT role FROM users WHERE id = $1`, [userId], { allowNoTenant: true }
    );
    if (userResult.rows[0]?.role !== 'owner') {
      res.status(403).json({ error: 'Not authorized' }); return;
    }

    const { scenario, format, angle, index = 0, total = 1 } = req.body as {
      scenario:  { store: string; revenue: string; adSpend: string; realRoas: string; metaRoas: string; googleRoas: string; bolRoas: string; insight: string; campaigns: number; topProduct: string; margin: string };
      format:    { label: string; words: number };
      angle:     { id: string; label: string };
      index?:    number;
      total?:    number;
    };

    const angleGuide: Record<string, string> = {
      'problem-reveal': 'Open with the painful problem every ecommerce seller faces, build tension, then reveal how MarketGrow solves it.',
      'data-story':     'Lead with ONE surprising specific number. Let the number do the work. Unpack the story behind it.',
      'before-after':   'Paint the before picture (chaos, blind decisions, wasted spend) then the after (clarity, smart decisions, growth).',
      'tip-listicle':   'Give exactly 3 specific, actionable tips. Each backed by a number. Fast paced. Numbered out loud.',
      'founder-story':  'First-person voice. Tell the story of discovering this insight. Authentic, relatable, real.',
    };

    const prompt = `You are a viral video script writer for MarketGrow — an AI analytics platform for ecommerce entrepreneurs.

Write ${total > 1 ? `script ${index + 1} of ${total} — make it COMPLETELY different from the others. ` : 'a '}${format.label} video script (${format.words} spoken words ±10%) using the "${angle.label}" angle.

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
