// ============================================================
// src/modules/analytics/api/analytics.routes.ts
//
// FIX: parsePeriod voor '24h' (Today) gebruikt nu Amsterdam
// middernacht als startpunt zodat vandaag = de huidige kalenderdag
// in Amsterdam-tijd, niet de laatste 24 uur in UTC.
// ============================================================

import { Router, Request, Response, NextFunction } from 'express';
import { db }               from '../../../infrastructure/database/connection';
import { getTenantContext } from '../../../shared/middleware/tenant-context';
import { tenantMiddleware } from '../../../shared/middleware/tenant.middleware';

export const analyticsRouter = Router();
analyticsRouter.use(tenantMiddleware());

// ── Periode helper ────────────────────────────────────────────
// Voor '24h' (Today): bepaal Amsterdam middernacht via Intl API.
// Amsterdam = UTC+1 (winter) of UTC+2 (zomer).
// Strategie: format de datum als 'YYYY-MM-DD' in Amsterdam timezone,
// dan bereken het UTC tijdstip van middernacht op die dag.
function getAmsterdamMidnightUTC(): Date {
  const now = new Date();
  // Haal de datum op als 'YYYY-MM-DD' in Amsterdam timezone
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Amsterdam',
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(now);

  const y = parts.find(p => p.type === 'year')?.value  ?? '2026';
  const m = parts.find(p => p.type === 'month')?.value ?? '01';
  const d = parts.find(p => p.type === 'day')?.value   ?? '01';

  // Maak een Date object voor middernacht in Amsterdam timezone
  // door 'YYYY-MM-DDT00:00:00' te interpreteren als Amsterdam local time
  // We doen dit door de offset te berekenen:
  // 1. Maak een UTC Date voor middernacht van deze dag
  const midnightUTCGuess = new Date(`${y}-${m}-${d}T00:00:00Z`);
  // 2. Bepaal wat de Amsterdam tijd is op dat UTC moment
  const amsterdamHour = parseInt(
    new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Europe/Amsterdam', hour: 'numeric', hour12: false,
    }).format(midnightUTCGuess),
    10
  );
  // 3. Schuif de UTC tijd terug zodat Amsterdam tijd = 00:00 is
  const offsetMs = amsterdamHour * 3600000;
  return new Date(midnightUTCGuess.getTime() - offsetMs);
}

function parsePeriod(period: string, from?: string, to?: string): { since: Date; until: Date; days: number } {
  if (from && to) {
    const since = new Date(from + 'T00:00:00.000Z');
    const until = new Date(to   + 'T23:59:59.999Z');
    const days  = Math.ceil((until.getTime() - since.getTime()) / 86400000);
    return { since, until, days };
  }

  const now = new Date();

  if (period === '24h') {
    return { since: getAmsterdamMidnightUTC(), until: now, days: 1 };
  }

  switch (period) {
    case '7d':  return { since: new Date(now.getTime() - 7  * 86400000), until: now, days: 7  };
    case '90d': return { since: new Date(now.getTime() - 90 * 86400000), until: now, days: 90 };
    default:    return { since: new Date(now.getTime() - 30 * 86400000), until: now, days: 30 };
  }
}

// ── GET /api/analytics/overview ──────────────────────────────
analyticsRouter.get('/overview', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { tenantId } = getTenantContext();
    const { period = '30d', platform, from, to } = req.query as {
      period?: string; platform?: string; from?: string; to?: string;
    };

    const { since, until, days } = parsePeriod(period, from, to);
    const params: any[] = [tenantId, since, until];
    const platformFilter = platform ? ` AND platform = $${params.push(platform)}` : '';

    const current = await db.query(
      `SELECT
         COUNT(*)::int                       AS orders_count,
         COALESCE(SUM(total), 0)             AS revenue,
         COALESCE(AVG(total), 0)             AS avg_order_value,
         COUNT(DISTINCT customer_email)::int AS unique_customers
       FROM unified_orders
       WHERE tenant_id = $1
         AND ordered_at >= $2 AND ordered_at <= $3
         AND status NOT IN ('cancelled', 'refunded')
         ${platformFilter}`,
      params
    );

    const prevSince = new Date(since.getTime() - days * 86400000);
    const prevUntil = since;
    const prevParams: any[] = [tenantId, prevSince, prevUntil];
    if (platform) prevParams.push(platform);

    const previous = await db.query(
      `SELECT COALESCE(SUM(total), 0) AS revenue, COUNT(*)::int AS orders_count
       FROM unified_orders
       WHERE tenant_id = $1 AND ordered_at >= $2 AND ordered_at < $3
         AND status NOT IN ('cancelled', 'refunded')
         ${platform ? ` AND platform = $4` : ''}`,
      prevParams
    );

    const curr = current.rows[0];
    const prev = previous.rows[0];

    const revenueChange = prev.revenue > 0
      ? ((curr.revenue - prev.revenue) / prev.revenue) * 100 : 0;
    const ordersChange = prev.orders_count > 0
      ? ((curr.orders_count - prev.orders_count) / prev.orders_count) * 100 : 0;

    res.json({
      period,
      from: since.toISOString(),
      to:   until.toISOString(),
      current:  curr,
      previous: prev,
      changes: {
        revenue:      Math.round(revenueChange * 10) / 10,
        orders_count: Math.round(ordersChange  * 10) / 10,
      },
    });
  } catch (err) { next(err); }
});

// ── GET /api/analytics/daily ─────────────────────────────────
analyticsRouter.get('/daily', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { tenantId } = getTenantContext();
    const { period = '30d', platform, from, to } = req.query as {
      period?: string; platform?: string; from?: string; to?: string;
    };

    const { since, until } = parsePeriod(period, from, to);
    const params: any[] = [tenantId, since, until];
    const platformFilter = platform ? ` AND platform = $${params.push(platform)}` : '';

    const is24h = period === '24h' && !from;
    const groupBy = is24h
      ? `DATE_TRUNC('hour', ordered_at AT TIME ZONE 'Europe/Amsterdam')`
      : `DATE(ordered_at AT TIME ZONE 'Europe/Amsterdam')`;

    const result = await db.query(
      `SELECT
         ${groupBy}             AS date,
         platform,
         COUNT(*)::int          AS orders_count,
         COALESCE(SUM(total),0) AS revenue,
         COALESCE(AVG(total),0) AS avg_order_value
       FROM unified_orders
       WHERE tenant_id = $1
         AND ordered_at >= $2 AND ordered_at <= $3
         AND status NOT IN ('cancelled','refunded')
         ${platformFilter}
       GROUP BY ${groupBy}, platform
       ORDER BY date ASC`,
      params
    );

    res.json({ data: result.rows, period, from: since.toISOString(), to: until.toISOString() });
  } catch (err) { next(err); }
});

// ── GET /api/analytics/by-platform ───────────────────────────
analyticsRouter.get('/by-platform', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { tenantId } = getTenantContext();
    const { period = '30d', from, to } = req.query as { period?: string; from?: string; to?: string };
    const { since, until } = parsePeriod(period, from, to);

    const result = await db.query(
      `SELECT
         platform,
         COUNT(*)::int                AS orders_count,
         COALESCE(SUM(total),0)       AS revenue,
         COALESCE(AVG(total),0)       AS avg_order_value,
         ROUND(SUM(total)*100.0 / NULLIF(SUM(SUM(total)) OVER(), 0), 1) AS revenue_share
       FROM unified_orders
       WHERE tenant_id = $1
         AND ordered_at >= $2 AND ordered_at <= $3
         AND status NOT IN ('cancelled','refunded')
       GROUP BY platform
       ORDER BY revenue DESC`,
      [tenantId, since, until]
    );

    res.json({ platforms: result.rows, period });
  } catch (err) { next(err); }
});

// ── GET /api/analytics/top-products ──────────────────────────
analyticsRouter.get('/top-products', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { tenantId } = getTenantContext();
    const { limit = '10', platform, period = '30d', from, to } = req.query as {
      limit?: string; platform?: string; period?: string; from?: string; to?: string;
    };

    const { since, until } = parsePeriod(period, from, to);
    const params: any[] = [tenantId, since, until, parseInt(limit, 10)];
    const platformFilter = platform ? ` AND o.platform_slug = $${params.push(platform)}` : '';

    const result = await db.query(
      `SELECT
         oli.title,
         oli.sku,
         o.platform_slug                  AS platform,
         SUM(oli.quantity)::int           AS total_sold,
         SUM(oli.total_price)             AS total_revenue,
         AVG(oli.unit_price)              AS avg_price,
         MAX(p.external_id)               AS offer_id,
         MAX(p.ean)                       AS ean
       FROM order_line_items oli
       JOIN orders o ON o.id = oli.order_id
       LEFT JOIN products p
         ON p.tenant_id = $1
         AND p.ean IS NOT NULL
         AND p.ean = oli.sku
       WHERE oli.tenant_id = $1
         AND o.ordered_at >= $2 AND o.ordered_at <= $3
         AND o.status NOT IN ('cancelled', 'refunded')
         ${platformFilter}
       GROUP BY oli.title, oli.sku, o.platform_slug
       ORDER BY total_revenue DESC
       LIMIT $4`,
      params
    );

    res.json({ products: result.rows, period });
  } catch (err) { next(err); }
});

// ── GET /api/analytics/ads ────────────────────────────────────
analyticsRouter.get('/ads', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { tenantId } = getTenantContext();
    const { platform, period = '30d', from, to } = req.query as {
      platform?: string; period?: string; from?: string; to?: string;
    };
    const { since, until } = parsePeriod(period, from, to);
    const params: any[] = [tenantId, since, until];
    const platformFilter = platform ? ` AND platform = $${params.push(platform)}` : '';

    const result = await db.query(
      `SELECT id, name, platform, status, spend, impressions, clicks, conversions, revenue, roas, updated_at
       FROM ad_campaigns
       WHERE tenant_id = $1
         AND updated_at >= $2 AND updated_at <= $3
         ${platformFilter}
       ORDER BY spend DESC NULLS LAST`,
      params
    );

    res.json({ campaigns: result.rows });
  } catch (err) { next(err); }
});

// ── GET /api/analytics/export ─────────────────────────────────
analyticsRouter.get('/export', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { tenantId, planSlug } = getTenantContext();
    if (planSlug === 'starter') {
      res.status(403).json({ error: 'Export is available on Growth and Scale plans.' });
      return;
    }

    const { type = 'orders', format = 'csv', period = '30d', from, to } = req.query as {
      type?: string; format?: string; period?: string; from?: string; to?: string;
    };
    const { since, until } = parsePeriod(period, from, to);

    let rows: any[] = [];

    if (type === 'orders') {
      const result = await db.query(
        `SELECT external_id, platform, status, total_amount, ordered_at
         FROM orders WHERE tenant_id = $1 AND ordered_at >= $2 AND ordered_at <= $3
         ORDER BY ordered_at DESC LIMIT 10000`,
        [tenantId, since, until], { allowNoTenant: true }
      );
      rows = result.rows;
    } else if (type === 'products') {
      const result = await db.query(
        `SELECT title, sku, platform_slug, SUM(quantity) AS sold, SUM(total_price) AS revenue
         FROM order_line_items oli
         JOIN orders o ON o.id = oli.order_id
         WHERE oli.tenant_id = $1 AND o.ordered_at >= $2 AND o.ordered_at <= $3
         GROUP BY title, sku, platform_slug ORDER BY revenue DESC LIMIT 1000`,
        [tenantId, since, until], { allowNoTenant: true }
      );
      rows = result.rows;
    }

    if (format === 'json') {
      res.json({ data: rows });
      return;
    }

    if (rows.length === 0) { res.json({ data: [] }); return; }
    const headers = Object.keys(rows[0]).join(',');
    const csv = [headers, ...rows.map(r => Object.values(r).map(v => `"${v}"`).join(','))].join('\n');
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="marketgrow-${type}-export.csv"`);
    res.send(csv);
  } catch (err) { next(err); }
});
