// ============================================================
// src/modules/analytics/api/analytics.routes.ts
//
// Uniforme analytics API — één endpoint voor alle platforms.
// Voedt het dashboard met genormaliseerde data.
// ============================================================

import { Router, Request, Response } from 'express';
import { db } from '../../../infrastructure/database/connection';
import { getTenantContext } from '../../../shared/middleware/tenant-context';

export const analyticsRouter = Router();

// ── GET /api/analytics/overview ──────────────────────────────
// Hoofdoverzicht: revenue, orders, AOV — gefilterd op periode
analyticsRouter.get('/overview', async (req: Request, res: Response) => {
  const { tenantId } = getTenantContext();
  const { period = '30d', platform } = req.query as { period?: string; platform?: string };

  const days   = period === '7d' ? 7 : period === '90d' ? 90 : 30;
  const since  = new Date(Date.now() - days * 86400000);
  const params: any[] = [tenantId, since];
  const platformFilter = platform ? ` AND platform = $${params.push(platform)}` : '';

  // Huidige periode
  const current = await db.query(
    `SELECT
       COUNT(*)::int                      AS orders_count,
       COALESCE(SUM(total), 0)            AS revenue,
       COALESCE(AVG(total), 0)            AS avg_order_value,
       COUNT(DISTINCT customer_email)::int AS unique_customers
     FROM unified_orders
     WHERE tenant_id = $1
       AND ordered_at >= $2
       AND status NOT IN ('cancelled', 'refunded')
       ${platformFilter}`,
    params
  );

  // Vorige periode (voor % change)
  const prevSince = new Date(since.getTime() - days * 86400000);
  const previous = await db.query(
    `SELECT COALESCE(SUM(total), 0) AS revenue, COUNT(*)::int AS orders_count
     FROM unified_orders
     WHERE tenant_id = $1 AND ordered_at >= $2 AND ordered_at < $3
       AND status NOT IN ('cancelled', 'refunded')
       ${platformFilter}`,
    [tenantId, prevSince, since, ...(platform ? [platform] : [])]
  );

  const curr = current.rows[0];
  const prev = previous.rows[0];

  const revenueChange = prev.revenue > 0
    ? ((curr.revenue - prev.revenue) / prev.revenue) * 100 : 0;
  const ordersChange = prev.orders_count > 0
    ? ((curr.orders_count - prev.orders_count) / prev.orders_count) * 100 : 0;

  res.json({
    period,
    current:  curr,
    previous: prev,
    changes: {
      revenue:      Math.round(revenueChange * 10) / 10,
      orders_count: Math.round(ordersChange * 10) / 10,
    },
  });
});

// ── GET /api/analytics/daily ──────────────────────────────────
// Dagelijkse data voor grafieken
analyticsRouter.get('/daily', async (req: Request, res: Response) => {
  const { tenantId } = getTenantContext();
  const { period = '30d', platform } = req.query as { period?: string; platform?: string };
  const days  = period === '7d' ? 7 : period === '90d' ? 90 : 30;
  const since = new Date(Date.now() - days * 86400000);
  const params: any[] = [tenantId, since];
  const platformFilter = platform ? ` AND platform = $${params.push(platform)}` : '';

  const result = await db.query(
    `SELECT
       DATE(ordered_at)       AS date,
       platform,
       COUNT(*)::int          AS orders_count,
       COALESCE(SUM(total),0) AS revenue,
       COALESCE(AVG(total),0) AS avg_order_value
     FROM unified_orders
     WHERE tenant_id = $1 AND ordered_at >= $2
       AND status NOT IN ('cancelled','refunded')
       ${platformFilter}
     GROUP BY DATE(ordered_at), platform
     ORDER BY date ASC`,
    params
  );

  res.json({ data: result.rows });
});

// ── GET /api/analytics/by-platform ───────────────────────────
// Vergelijk platforms naast elkaar
analyticsRouter.get('/by-platform', async (req: Request, res: Response) => {
  const { tenantId } = getTenantContext();
  const { period = '30d' } = req.query as { period?: string };
  const days  = period === '7d' ? 7 : period === '90d' ? 90 : 30;
  const since = new Date(Date.now() - days * 86400000);

  const result = await db.query(
    `SELECT
       platform,
       COUNT(*)::int                AS orders_count,
       COALESCE(SUM(total),0)       AS revenue,
       COALESCE(AVG(total),0)       AS avg_order_value,
       ROUND(SUM(total)*100.0 / NULLIF(SUM(SUM(total)) OVER(), 0), 1) AS revenue_share
     FROM unified_orders
     WHERE tenant_id = $1 AND ordered_at >= $2
       AND status NOT IN ('cancelled','refunded')
     GROUP BY platform
     ORDER BY revenue DESC`,
    [tenantId, since]
  );

  res.json({ platforms: result.rows, period });
});

// ── GET /api/analytics/top-products ──────────────────────────
analyticsRouter.get('/top-products', async (req: Request, res: Response) => {
  const { tenantId } = getTenantContext();
  const { limit = '10', platform } = req.query as { limit?: string; platform?: string };
  const params: any[] = [tenantId, parseInt(limit, 10)];
  const platformFilter = platform ? ` AND platform = $${params.push(platform)}` : '';

  const result = await db.query(
    `SELECT
       title, sku, platform,
       SUM(quantity)::int        AS total_sold,
       SUM(total_price)          AS total_revenue,
       AVG(unit_price)           AS avg_price
     FROM order_line_items
     WHERE tenant_id = $1 ${platformFilter}
     GROUP BY title, sku, platform
     ORDER BY total_revenue DESC
     LIMIT $2`,
    params
  );

  res.json({ products: result.rows });
});

// ── GET /api/analytics/ads ────────────────────────────────────
analyticsRouter.get('/ads', async (req: Request, res: Response) => {
  const { tenantId } = getTenantContext();
  const { platform } = req.query as { platform?: string };
  const params: any[] = [tenantId];
  const platformFilter = platform ? ` AND platform = $${params.push(platform)}` : '';

  const result = await db.query(
    `SELECT
       platform, name, status,
       spend, impressions, clicks, conversions, revenue,
       COALESCE(roas, CASE WHEN spend > 0 THEN revenue/spend ELSE NULL END) AS roas,
       CASE WHEN impressions > 0 THEN ROUND(clicks*100.0/impressions, 2) ELSE 0 END AS ctr,
       CASE WHEN clicks > 0 THEN ROUND(spend/clicks, 2) ELSE NULL END AS cpc
     FROM ad_campaigns
     WHERE tenant_id = $1 ${platformFilter}
     ORDER BY spend DESC`,
    params
  );

  res.json({ campaigns: result.rows });
});
