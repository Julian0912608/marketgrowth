// ============================================================
// src/modules/analytics/api/analytics.routes.ts
// ============================================================

import { Router, Request, Response, NextFunction } from 'express';
import { db }               from '../../../infrastructure/database/connection';
import { getTenantContext } from '../../../shared/middleware/tenant-context';
import { tenantMiddleware } from '../../../shared/middleware/tenant.middleware';
import { featureGate }      from '../../../shared/middleware/feature-gate.middleware';

export const analyticsRouter = Router();

analyticsRouter.use(tenantMiddleware());

// ── GET /api/analytics/overview ────────────────────────────────
analyticsRouter.get('/overview', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { tenantId } = getTenantContext();
    const { period = '30d', platform } = req.query as { period?: string; platform?: string };

    const days   = period === '7d' ? 7 : period === '90d' ? 90 : 30;
    const since  = new Date(Date.now() - days * 86400000);
    const params: any[] = [tenantId, since];
    const platformFilter = platform ? ` AND platform = $${params.push(platform)}` : '';

    const current = await db.query(
      `SELECT
         COUNT(*)::int                       AS orders_count,
         COALESCE(SUM(total), 0)             AS revenue,
         COALESCE(AVG(total), 0)             AS avg_order_value,
         COUNT(DISTINCT customer_email)::int AS unique_customers
       FROM unified_orders
       WHERE tenant_id = $1
         AND ordered_at >= $2
         AND status NOT IN ('cancelled', 'refunded')
         ${platformFilter}`,
      params
    );

    const prevSince = new Date(since.getTime() - days * 86400000);
    const prevParams: any[] = [tenantId, prevSince, since];
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
      current:  curr,
      previous: prev,
      changes: {
        revenue:      Math.round(revenueChange * 10) / 10,
        orders_count: Math.round(ordersChange * 10) / 10,
      },
    });
  } catch (err) { next(err); }
});

// ── GET /api/analytics/daily ────────────────────────────────────
analyticsRouter.get('/daily', async (req: Request, res: Response, next: NextFunction) => {
  try {
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
  } catch (err) { next(err); }
});

// ── GET /api/analytics/by-platform ─────────────────────────────
analyticsRouter.get('/by-platform', async (req: Request, res: Response, next: NextFunction) => {
  try {
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
  } catch (err) { next(err); }
});

// ── GET /api/analytics/top-products ────────────────────────────
analyticsRouter.get('/top-products', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { tenantId } = getTenantContext();
    const { limit = '10', platform, period = '30d' } = req.query as {
      limit?: string; platform?: string; period?: string;
    };

    const days  = period === '7d' ? 7 : period === '90d' ? 90 : 30;
    const since = new Date(Date.now() - days * 86400000);

    const params: any[] = [tenantId, since, parseInt(limit, 10)];
    const platformFilter = platform ? ` AND o.platform_slug = $${params.push(platform)}` : '';

    const result = await db.query(
      `SELECT
         oli.title,
         oli.sku,
         o.platform_slug                  AS platform,
         SUM(oli.quantity)::int           AS total_sold,
         SUM(oli.total_price)             AS total_revenue,
         AVG(oli.unit_price)              AS avg_price
       FROM order_line_items oli
       JOIN orders o ON o.id = oli.order_id
       WHERE oli.tenant_id = $1
         AND o.ordered_at >= $2
         AND o.status NOT IN ('cancelled', 'refunded')
         ${platformFilter}
       GROUP BY oli.title, oli.sku, o.platform_slug
       ORDER BY total_revenue DESC
       LIMIT $3`,
      params
    );

    res.json({ products: result.rows, period });
  } catch (err) { next(err); }
});

// ── GET /api/analytics/ads ──────────────────────────────────────
analyticsRouter.get('/ads', async (req: Request, res: Response, next: NextFunction) => {
  try {
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
  } catch (err) { next(err); }
});

// ── GET /api/analytics/export ───────────────────────────────────
// Alleen beschikbaar voor Growth+ (report-export feature)
analyticsRouter.get('/export',
  featureGate('report-export'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { tenantId } = getTenantContext();
      const {
        format   = 'csv',
        period   = '30d',
        platform,
        type     = 'orders',
      } = req.query as {
        format?:   string;
        period?:   string;
        platform?: string;
        type?:     string;
      };

      const days  = period === '7d' ? 7 : period === '90d' ? 90 : period === '1y' ? 365 : 30;
      const since = new Date(Date.now() - days * 86400000);
      const params: any[] = [tenantId, since];
      const platformFilter = platform ? ` AND o.platform_slug = $${params.push(platform)}` : '';

      let rows: any[] = [];
      let filename    = '';
      let headers: string[] = [];

      if (type === 'orders') {
        const result = await db.query(
          `SELECT
             o.external_number  AS order_number,
             o.platform_slug    AS platform,
             o.ordered_at       AS date,
             o.status,
             o.financial_status,
             o.total_amount     AS total,
             o.subtotal_amount  AS subtotal,
             o.tax_amount       AS tax,
             o.shipping_amount  AS shipping,
             o.discount_amount  AS discount,
             o.currency
           FROM orders o
           WHERE o.tenant_id = $1
             AND o.ordered_at >= $2
             AND o.status NOT IN ('cancelled', 'refunded')
             ${platformFilter}
           ORDER BY o.ordered_at DESC
           LIMIT 10000`,
          params, { allowNoTenant: true }
        );
        rows     = result.rows;
        filename = `orders-${period}-${new Date().toISOString().split('T')[0]}`;
        headers  = ['order_number', 'platform', 'date', 'status', 'financial_status',
                    'total', 'subtotal', 'tax', 'shipping', 'discount', 'currency'];

      } else if (type === 'products') {
        const result = await db.query(
          `SELECT
             oli.title                                AS product,
             oli.sku,
             o.platform_slug                          AS platform,
             SUM(oli.quantity)::int                   AS total_sold,
             ROUND(SUM(oli.total_price)::numeric, 2)  AS total_revenue,
             ROUND(AVG(oli.unit_price)::numeric, 2)   AS avg_price
           FROM order_line_items oli
           JOIN orders o ON o.id = oli.order_id
           WHERE oli.tenant_id = $1
             AND o.ordered_at >= $2
             AND o.status NOT IN ('cancelled', 'refunded')
             ${platformFilter}
           GROUP BY oli.title, oli.sku, o.platform_slug
           ORDER BY total_revenue DESC
           LIMIT 5000`,
          params, { allowNoTenant: true }
        );
        rows     = result.rows;
        filename = `products-${period}-${new Date().toISOString().split('T')[0]}`;
        headers  = ['product', 'sku', 'platform', 'total_sold', 'total_revenue', 'avg_price'];

      } else if (type === 'ads') {
        const result = await db.query(
          `SELECT
             platform, name AS campaign, status,
             ROUND(spend::numeric, 2)    AS spend,
             impressions, clicks, conversions,
             ROUND(revenue::numeric, 2)  AS revenue,
             ROUND(roas::numeric, 2)     AS roas
           FROM ad_campaigns
           WHERE tenant_id = $1
           ORDER BY spend DESC
           LIMIT 1000`,
          [tenantId], { allowNoTenant: true }
        );
        rows     = result.rows;
        filename = `ads-${new Date().toISOString().split('T')[0]}`;
        headers  = ['platform', 'campaign', 'status', 'spend', 'impressions',
                    'clicks', 'conversions', 'revenue', 'roas'];
      }

      if (format === 'json') {
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Content-Disposition', `attachment; filename="${filename}.json"`);
        res.json({ exported_at: new Date().toISOString(), period, rows });
        return;
      }

      // CSV output
      const escape = (val: any): string => {
        if (val === null || val === undefined) return '';
        const str = String(val);
        if (str.includes(',') || str.includes('"') || str.includes('\n')) {
          return '"' + str.replace(/"/g, '""') + '"';
        }
        return str;
      };

      const csvLines = [
        headers.join(','),
        ...rows.map(row => headers.map(h => escape(row[h])).join(',')),
      ];

      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}.csv"`);
      res.send('\uFEFF' + csvLines.join('\n'));
    } catch (err) { next(err); }
  }
);
