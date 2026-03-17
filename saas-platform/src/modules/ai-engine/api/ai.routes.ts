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

export { router as aiRouter };
