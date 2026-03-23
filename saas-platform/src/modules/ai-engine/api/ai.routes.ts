import { Router, Request, Response, NextFunction } from 'express';
import Anthropic from '@anthropic-ai/sdk';
import { db } from '../../../infrastructure/database/connection';
import { cache } from '../../../infrastructure/cache/redis';
import { getTenantContext } from '../../../shared/middleware/tenant-context';
import { tenantMiddleware } from '../../../shared/middleware/tenant.middleware';
import { generateAdCreative, generateCarouselSlides } from '../services/nano-banana.service';
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

    if (!force) {
      const cached = await cache.get(cacheKey);
      if (cached) {
        return res.json({ ...JSON.parse(cached), fromCache: true });
      }
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
        `SELECT
           oli.title,
           ti.platform_slug,
           SUM(oli.quantity)::int AS sold,
           SUM(oli.total_price)   AS revenue
         FROM order_line_items oli
         JOIN orders o ON o.id = oli.order_id
         JOIN tenant_integrations ti ON ti.tenant_id = oli.tenant_id
         WHERE oli.tenant_id = $1
           AND o.ordered_at >= NOW() - INTERVAL '30 days'
           AND o.status NOT IN ('cancelled', 'refunded')
           AND oli.total_price > 0
         GROUP BY oli.title, ti.platform_slug
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
        briefing: 'Koppel je eerste winkel om AI-acties te ontvangen. Ga naar Integraties om Bol.com, Shopify of een ander platform te verbinden.',
        actions:  [{ priority: 'high', title: 'Koppel je winkel', description: 'Ga naar de Integraties pagina om je eerste verkoopkanaal te verbinden.', channel: 'algemeen' }],
        alerts:   [],
        fromCache: false,
      });
    }

    const platformNames = integrations.map((i: any) => i.platform_slug).join(', ');
    const hasOrders     = parseInt(stats.total_orders) > 0;

    const prompt = hasOrders
      ? `Je bent de AI engine van MarketGrow — een ecommerce action platform.
Je taak is NIET om te analyseren wat er is gebeurd. Je taak is om de ondernemer te vertellen wat hij vandaag moet doen, op welk kanaal, met welk product.

Verkoopdata van de afgelopen 30 dagen:
- Totaal orders: ${stats.total_orders}
- Omzet (excl. BTW): €${parseFloat(stats.revenue).toFixed(2)}
- Gemiddelde orderwaarde: €${parseFloat(stats.avg_order_value).toFixed(2)}
- Gekoppelde platforms: ${platformNames}
- Top producten: ${topProducts.map((p: any) => p.title + ' (' + p.sold + 'x verkocht, €' + parseFloat(p.revenue).toFixed(2) + ' omzet, platform: ' + (p.platform_slug || 'onbekend') + ')').join(' | ')}

REGELS voor je output:
1. Elke actie moet SPECIFIEK zijn: noem het product, het platform én het concrete getal
2. Acties zijn altijd uitvoerbaar vandaag — geen vage adviezen
3. Onderscheid per kanaal: als een product op Bol.com beter loopt dan Shopify, zeg dat expliciet
4. High priority = doe dit vandaag. Medium = deze week. Low = overweeg dit
5. Alerts zijn echte waarschuwingen: dalende trend, product dat stopt, ongewone dip

Voorbeelden van GOEDE acties:
- "Verhoog je dagbudget voor [product] op Bol.com met €30 — dit product converteert 4x beter dan je Shopify variant"
- "Stop de advertenties voor [product] — ROAS is onder break-even gezakt"
- "Zet [product] ook live op Bol.com — vergelijkbare producten doen het daar 60% beter"

Geef een JSON response met exact deze structuur (geen markdown, alleen JSON):
{"briefing":"2-3 zinnen met de meest opvallende beweging — specifiek, met cijfers","actions":[{"priority":"high","title":"Korte actietitel met platform/product","description":"Concrete uitleg: wat, op welk platform, waarom en met welk getal","channel":"bolcom"},{"priority":"medium","title":"...","description":"...","channel":"shopify"},{"priority":"low","title":"...","description":"...","channel":"algemeen"}],"alerts":["Concrete waarschuwing met cijfer of lege array"]}`
      : `Je bent de AI engine van MarketGrow. De gebruiker heeft ${integrations.length} winkel(s) gekoppeld (${platformNames}) maar nog geen orders de afgelopen 30 dagen.

Geef een motiverende maar concrete briefing als JSON (geen markdown, alleen JSON):
{"briefing":"Geef aan dat de setup goed staat en wat ze kunnen verwachten zodra orders binnenkomen","actions":[{"priority":"high","title":"Wacht op eerste orders","description":"Je winkel is gekoppeld. Zodra de eerste orders binnenkomen analyseert MarketGrow je data en krijg je direct je eerste acties per kanaal.","channel":"algemeen"},{"priority":"medium","title":"Controleer sync status","description":"Ga naar Integraties en check of de laatste sync succesvol was — zo weet je zeker dat orders direct zichtbaar zijn.","channel":"algemeen"}],"alerts":[]}`;

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

    await cache.set(cacheKey, JSON.stringify(parsed), CACHE_TTL[planSlug] || 3600);

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

// ── GET /api/ai/credits ──────────────────────────────────────
router.get('/credits', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { tenantId, planSlug } = getTenantContext();

    const [usageResult, limitResult] = await Promise.all([
      db.query(
        `SELECT COALESCE(usage_count, 0) AS used
         FROM feature_usage fu
         JOIN features f ON f.id = fu.feature_id
         WHERE fu.tenant_id = $1
           AND f.slug = 'ai-recommendations'
           AND fu.period_start <= now()
           AND fu.period_end   >= now()
         LIMIT 1`,
        [tenantId], { allowNoTenant: true }
      ),
      db.query(
        `SELECT ul.limit_value
         FROM usage_limits ul
         JOIN plans p ON p.id = ul.plan_id
         JOIN features f ON f.id = ul.feature_id
         WHERE p.slug = $1
           AND f.slug = 'ai-recommendations'
           AND ul.limit_type = 'monthly'
         LIMIT 1`,
        [planSlug], { allowNoTenant: true }
      ),
    ]);

    const used      = parseInt(usageResult.rows[0]?.used ?? '0');
    const limit     = limitResult.rows[0]?.limit_value ?? null;
    const unlimited = limit === null;

    res.json({
      used,
      limit,
      remaining:  unlimited ? null : Math.max(0, limit - used),
      unlimited,
    });
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
      system:     'Je bent een ecommerce AI adviseur voor MarketGrow — een action platform dat ecommerce ondernemers vertelt wat ze vandaag moeten doen per kanaal en product. De gebruiker heeft ' + stats.orders + ' orders en €' + parseFloat(stats.revenue).toFixed(2) + ' omzet de afgelopen 30 dagen. Antwoord altijd in het Nederlands. Geef concrete, uitvoerbare adviezen — noem altijd het platform en het product als dat relevant is.',
      messages:   [{ role: 'user', content: message }],
    });

    const text = response.content[0].type === 'text' ? response.content[0].text : '';
    res.json({ response: text });
  } catch (err) { next(err); }
});

// ── POST /api/ai/social-content ──────────────────────────────
router.post('/social-content', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { tenantId } = getTenantContext();

    const { platform, tone, topic, customContext, count = 3 } = req.body as {
      platform:      'instagram' | 'tiktok';
      tone:          'educational' | 'inspirational' | 'data-driven' | 'behind-the-scenes';
      topic:         string;
      customContext?: string;
      count?:        number;
    };

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
    try {
      parsed = JSON.parse(clean);
    } catch {
      const match = clean.match(/\{[\s\S]*\}/);
      parsed = match ? JSON.parse(match[0]) : { hook: '', script: text, visualNotes: [], hashtags: [] };
    }

    res.json(parsed);
  } catch (err) { next(err); }
});

export { router as aiRouter };
