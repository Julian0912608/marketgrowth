// ============================================================
// src/modules/notifications/weekly.report.service.ts
//
// Stuurt elke maandag om 08:00 een uitgebreid weekrapport
// FIX: Revenue labels tonen nu expliciet "excl. BTW/VAT"
// ============================================================

import { db }     from '../../infrastructure/database/connection';
import { logger } from '../../shared/logging/logger';

const RESEND_API_KEY  = process.env.RESEND_API_KEY || '';
const RESEND_ENDPOINT = 'https://api.resend.com/emails';
const FROM_EMAIL      = 'MarketGrow <briefing@marketgrow.ai>';
const APP_URL         = process.env.APP_URL || 'https://marketgrow.ai';

async function sendEmail(to: string, subject: string, html: string): Promise<void> {
  if (!RESEND_API_KEY) return;
  const res = await fetch(RESEND_ENDPOINT, {
    method:  'POST',
    headers: { 'Authorization': `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body:    JSON.stringify({ from: FROM_EMAIL, to: [to], subject, html }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Resend error (${res.status}): ${body.slice(0, 200)}`);
  }
}

function formatEur(val: number): string {
  return new Intl.NumberFormat('nl-NL', { style: 'currency', currency: 'EUR', minimumFractionDigits: 0 }).format(val);
}

export async function sendWeeklyReports(): Promise<void> {
  logger.info('weekly.report.start');

  const tenants = await db.query<{
    tenant_id:  string;
    email:      string;
    first_name: string;
    plan_slug:  string;
  }>(
    `SELECT DISTINCT
       t.id AS tenant_id, u.email, u.first_name, p.slug AS plan_slug
     FROM tenants t
     JOIN users u ON u.tenant_id = t.id AND u.role = 'owner'
     JOIN tenant_subscriptions ts ON ts.tenant_id = t.id AND ts.status IN ('active', 'trialing')
     JOIN plans p ON p.id = ts.plan_id
     WHERE t.id IN (
       SELECT DISTINCT tenant_id FROM tenant_integrations WHERE status = 'active'
     )
     ORDER BY t.id`,
    [], { allowNoTenant: true }
  );

  logger.info('weekly.report.tenants', { count: tenants.rows.length });

  for (const tenant of tenants.rows) {
    try {
      const [statsResult, prevStatsResult, topProductsResult, byPlatformResult] = await Promise.all([

        // Deze week — total_amount - tax_amount = excl. BTW
        db.query<{ revenue: string; orders: string; avg_order: string; customers: string }>(
          `SELECT
             COALESCE(SUM(total_amount - tax_amount), 0) AS revenue,
             COUNT(*)::int                               AS orders,
             COALESCE(AVG(total_amount - tax_amount), 0) AS avg_order,
             COUNT(DISTINCT customer_email_hash)::int    AS customers
           FROM orders
           WHERE tenant_id = $1
             AND ordered_at >= NOW() - INTERVAL '7 days'
             AND status NOT IN ('cancelled', 'refunded')`,
          [tenant.tenant_id], { allowNoTenant: true }
        ),

        // Vorige week
        db.query<{ revenue: string; orders: string }>(
          `SELECT
             COALESCE(SUM(total_amount - tax_amount), 0) AS revenue,
             COUNT(*)::int AS orders
           FROM orders
           WHERE tenant_id = $1
             AND ordered_at >= NOW() - INTERVAL '14 days'
             AND ordered_at < NOW() - INTERVAL '7 days'
             AND status NOT IN ('cancelled', 'refunded')`,
          [tenant.tenant_id], { allowNoTenant: true }
        ),

        // Top 3 producten
        db.query<{ title: string; revenue: string; orders: string }>(
          `SELECT oli.title,
                  COALESCE(SUM(oli.total_price), 0) AS revenue,
                  COUNT(*)::int                      AS orders
           FROM order_line_items oli
           JOIN orders o ON o.id = oli.order_id
           WHERE oli.tenant_id = $1
             AND o.ordered_at >= NOW() - INTERVAL '7 days'
             AND o.status NOT IN ('cancelled', 'refunded')
             AND oli.total_price > 0
           GROUP BY oli.title
           ORDER BY revenue DESC
           LIMIT 3`,
          [tenant.tenant_id], { allowNoTenant: true }
        ),

        // Per platform
        db.query<{ platform: string; revenue: string; orders: string }>(
          `SELECT platform,
                  COALESCE(SUM(total_amount - tax_amount), 0) AS revenue,
                  COUNT(*)::int                               AS orders
           FROM orders
           WHERE tenant_id = $1
             AND ordered_at >= NOW() - INTERVAL '7 days'
             AND status NOT IN ('cancelled', 'refunded')
           GROUP BY platform
           ORDER BY revenue DESC`,
          [tenant.tenant_id], { allowNoTenant: true }
        ),
      ]);

      const stats    = statsResult.rows[0];
      const prev     = prevStatsResult.rows[0];
      const products = topProductsResult.rows;
      const platforms = byPlatformResult.rows;

      const revenue     = parseFloat(stats.revenue || '0');
      const orders      = parseInt(stats.orders || '0');
      const prevRevenue = parseFloat(prev.revenue || '0');
      const prevOrders  = parseInt(prev.orders || '0');

      const revenueChange = prevRevenue > 0
        ? Math.round(((revenue - prevRevenue) / prevRevenue) * 100)
        : 0;
      const ordersChange = prevOrders > 0
        ? Math.round(((orders - prevOrders) / prevOrders) * 100)
        : 0;

      const weekStr = new Date().toLocaleDateString('nl-NL', {
        day: 'numeric', month: 'long', year: 'numeric',
      });

      const PLATFORM_NAMES: Record<string, string> = {
        bolcom: 'Bol.com', shopify: 'Shopify', amazon: 'Amazon',
        etsy: 'Etsy', woocommerce: 'WooCommerce',
      };

      const html = `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#f8fafc;font-family:'Helvetica Neue',Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="padding:40px 20px;">
    <tr><td align="center">
      <table width="580" cellpadding="0" cellspacing="0" style="max-width:580px;width:100%;">

        <!-- Header -->
        <tr>
          <td style="background:#0f172a;border-radius:16px 16px 0 0;padding:28px 36px;">
            <span style="color:#fff;font-size:18px;font-weight:800;">⚡ MarketGrow</span>
            <span style="color:#475569;font-size:13px;margin-left:12px;">Weekrapport</span>
            <p style="color:#475569;font-size:12px;margin:6px 0 0;">Week van ${weekStr}</p>
          </td>
        </tr>

        <!-- Body -->
        <tr>
          <td style="background:#1e293b;padding:32px 36px;">

            <h1 style="color:#fff;font-size:20px;margin:0 0 24px;">
              Goedemorgen ${tenant.first_name || 'daar'} 👋
            </h1>

            <!-- KPI's -->
            <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:28px;">
              <tr>
                <td width="48%" style="background:#0f172a;border:1px solid #334155;border-radius:12px;padding:16px;text-align:center;">
                  <div style="color:#64748b;font-size:11px;text-transform:uppercase;letter-spacing:0.05em;">Omzet excl. BTW (7d)</div>
                  <div style="color:#10b981;font-size:26px;font-weight:800;margin:6px 0 2px;">${formatEur(revenue)}</div>
                  <div style="color:#475569;font-size:10px;margin-bottom:4px;">excl. BTW</div>
                  <div style="color:${revenueChange >= 0 ? '#10b981' : '#ef4444'};font-size:12px;">
                    ${revenueChange >= 0 ? '↑' : '↓'} ${Math.abs(revenueChange)}% vs vorige week
                  </div>
                </td>
                <td width="4%"></td>
                <td width="48%" style="background:#0f172a;border:1px solid #334155;border-radius:12px;padding:16px;text-align:center;">
                  <div style="color:#64748b;font-size:11px;text-transform:uppercase;letter-spacing:0.05em;">Orders (7d)</div>
                  <div style="color:#3b82f6;font-size:26px;font-weight:800;margin:6px 0 6px;">${orders}</div>
                  <div style="color:${ordersChange >= 0 ? '#10b981' : '#ef4444'};font-size:12px;">
                    ${ordersChange >= 0 ? '↑' : '↓'} ${Math.abs(ordersChange)}% vs vorige week
                  </div>
                </td>
              </tr>
            </table>

            ${products.length > 0 ? `
            <!-- Top producten -->
            <div style="background:#0f172a;border:1px solid #334155;border-radius:12px;overflow:hidden;margin-bottom:20px;">
              <div style="padding:12px 16px;border-bottom:1px solid #1e293b;">
                <span style="color:#94a3b8;font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:0.05em;">Top producten deze week</span>
              </div>
              ${products.map((p, i) => `
                <div style="${i > 0 ? 'border-top:1px solid #1e293b;' : ''}">
                  <table width="100%" cellpadding="0" cellspacing="0">
                    <tr>
                      <td style="padding:12px 16px;color:#fff;font-size:13px;">${p.title}</td>
                      <td style="padding:12px 16px;text-align:right;">
                        <span style="color:#10b981;font-size:13px;font-weight:600;">${formatEur(parseFloat(p.revenue))}</span>
                        <span style="color:#475569;font-size:11px;margin-left:6px;">${p.orders} orders</span>
                      </td>
                    </tr>
                  </table>
                </div>`).join('')}
            </div>` : ''}

            ${platforms.length > 1 ? `
            <!-- Per platform -->
            <div style="background:#0f172a;border:1px solid #334155;border-radius:12px;overflow:hidden;margin-bottom:20px;">
              <div style="padding:12px 16px;border-bottom:1px solid #1e293b;">
                <span style="color:#94a3b8;font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:0.05em;">Omzet excl. BTW per platform</span>
              </div>
              ${platforms.map((p, i) => `
                <div style="${i > 0 ? 'border-top:1px solid #1e293b;' : ''}">
                  <table width="100%" cellpadding="0" cellspacing="0">
                    <tr>
                      <td style="padding:12px 16px;color:#fff;font-size:13px;">${PLATFORM_NAMES[p.platform] ?? p.platform}</td>
                      <td style="padding:12px 16px;text-align:right;">
                        <span style="color:#10b981;font-size:13px;font-weight:600;">${formatEur(parseFloat(p.revenue))}</span>
                        <span style="color:#475569;font-size:11px;margin-left:6px;">${p.orders} orders</span>
                      </td>
                    </tr>
                  </table>
                </div>`).join('')}
            </div>` : ''}

            <!-- CTA -->
            <div style="text-align:center;padding-top:8px;">
              <a href="${APP_URL}/dashboard/ai-insights"
                 style="display:inline-block;background:#4f46e5;color:#fff;font-weight:700;font-size:14px;padding:14px 32px;border-radius:10px;text-decoration:none;">
                Bekijk je AI acties voor deze week
              </a>
            </div>

          </td>
        </tr>

        <!-- Footer -->
        <tr>
          <td style="background:#0f172a;border-radius:0 0 16px 16px;padding:16px 36px;text-align:center;">
            <p style="color:#475569;font-size:11px;margin:0;">
              © ${new Date().getFullYear()} MarketGrow ·
              <a href="${APP_URL}/settings" style="color:#4f46e5;">Notificaties beheren</a>
            </p>
          </td>
        </tr>

      </table>
    </td></tr>
  </table>
</body>
</html>`;

      await sendEmail(
        tenant.email,
        `Weekrapport: ${formatEur(revenue)} omzet excl. BTW, ${orders} orders`,
        html
      );

      logger.info('weekly.report.sent', { tenantId: tenant.tenant_id });
      await new Promise(r => setTimeout(r, 200));

    } catch (err) {
      logger.error('weekly.report.failed', {
        tenantId: tenant.tenant_id,
        error:    (err as Error).message,
      });
    }
  }

  logger.info('weekly.report.complete', { count: tenants.rows.length });
}
