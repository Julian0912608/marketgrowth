// ============================================================
// saas-platform/src/modules/notifications/email.service.ts
//
// Dagelijkse AI briefing emails via Resend API
// Wordt getriggerd via een BullMQ scheduled job elke dag om 7:00
// ============================================================

import { db }     from '../../infrastructure/database/connection';
import { logger } from '../../shared/logging/logger';

const RESEND_API_KEY  = process.env.RESEND_API_KEY || '';
const FROM_EMAIL      = 'MarketGrow <briefing@marketgrow.ai>';
const RESEND_ENDPOINT = 'https://api.resend.com/emails';

interface TenantBriefingData {
  tenantId:    string;
  email:       string;
  firstName:   string;
  planSlug:    string;
  revenue7d:   number;
  orders7d:    number;
  topProduct:  string | null;
  aiInsight:   string | null;
}

// ── HTML email template ────────────────────────────────────────
function buildEmailHtml(data: TenantBriefingData): string {
  const revenueFormatted = new Intl.NumberFormat('nl-NL', {
    style: 'currency', currency: 'EUR', minimumFractionDigits: 2,
  }).format(data.revenue7d);

  return `<!DOCTYPE html>
<html lang="nl">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Jouw dagelijkse MarketGrow briefing</title>
</head>
<body style="margin:0;padding:0;background:#f8fafc;font-family:'Helvetica Neue',Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f8fafc;padding:40px 20px;">
    <tr>
      <td align="center">
        <table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;">

          <!-- Header -->
          <tr>
            <td style="background:#0f172a;border-radius:16px 16px 0 0;padding:32px 40px;text-align:center;">
              <table cellpadding="0" cellspacing="0" style="margin:0 auto;">
                <tr>
                  <td style="background:#0284c7;border-radius:10px;width:36px;height:36px;text-align:center;vertical-align:middle;">
                    <span style="color:#fff;font-size:18px;font-weight:900;">⚡</span>
                  </td>
                  <td style="padding-left:10px;">
                    <span style="color:#fff;font-size:20px;font-weight:800;font-family:Georgia,serif;">MarketGrow</span>
                  </td>
                </tr>
              </table>
              <p style="color:#94a3b8;font-size:13px;margin:12px 0 0;">Dagelijkse briefing · ${new Date().toLocaleDateString('nl-NL', { weekday: 'long', day: 'numeric', month: 'long' })}</p>
            </td>
          </tr>

          <!-- Greeting -->
          <tr>
            <td style="background:#1e293b;padding:32px 40px 24px;">
              <h1 style="color:#fff;font-size:22px;font-weight:800;margin:0 0 8px;font-family:Georgia,serif;">
                Goedemorgen, ${data.firstName} 👋
              </h1>
              <p style="color:#94a3b8;font-size:14px;margin:0;line-height:1.6;">
                Hier is je overzicht van de afgelopen 7 dagen.
              </p>
            </td>
          </tr>

          <!-- KPI Stats -->
          <tr>
            <td style="background:#1e293b;padding:0 40px 32px;">
              <table width="100%" cellpadding="0" cellspacing="0">
                <tr>
                  <td width="48%" style="background:#0f172a;border:1px solid #334155;border-radius:12px;padding:20px;text-align:center;">
                    <div style="color:#94a3b8;font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:0.05em;margin-bottom:8px;">Omzet (7d)</div>
                    <div style="color:#10b981;font-size:28px;font-weight:800;font-family:Georgia,serif;">${revenueFormatted}</div>
                    <div style="color:#64748b;font-size:11px;margin-top:4px;">excl. BTW</div>
                  </td>
                  <td width="4%"></td>
                  <td width="48%" style="background:#0f172a;border:1px solid #334155;border-radius:12px;padding:20px;text-align:center;">
                    <div style="color:#94a3b8;font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:0.05em;margin-bottom:8px;">Orders (7d)</div>
                    <div style="color:#3b82f6;font-size:28px;font-weight:800;font-family:Georgia,serif;">${data.orders7d}</div>
                    <div style="color:#64748b;font-size:11px;margin-top:4px;">afgelopen week</div>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          ${data.topProduct ? `
          <!-- Top product -->
          <tr>
            <td style="background:#1e293b;padding:0 40px 32px;">
              <table width="100%" cellpadding="0" cellspacing="0" style="background:#0f172a;border:1px solid #334155;border-radius:12px;padding:0;">
                <tr>
                  <td style="padding:16px 20px;border-bottom:1px solid #1e293b;">
                    <span style="color:#94a3b8;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.05em;">🏆 Top product deze week</span>
                  </td>
                </tr>
                <tr>
                  <td style="padding:16px 20px;">
                    <span style="color:#fff;font-size:14px;font-weight:600;">${data.topProduct}</span>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          ` : ''}

          ${data.aiInsight ? `
          <!-- AI Insight -->
          <tr>
            <td style="background:#1e293b;padding:0 40px 32px;">
              <table width="100%" cellpadding="0" cellspacing="0" style="background:#082f49;border:1px solid #0369a1;border-radius:12px;">
                <tr>
                  <td style="padding:16px 20px;border-bottom:1px solid #0369a1;">
                    <span style="color:#38bdf8;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.05em;">✨ AI Inzicht van vandaag</span>
                  </td>
                </tr>
                <tr>
                  <td style="padding:16px 20px;">
                    <p style="color:#bae6fd;font-size:14px;line-height:1.7;margin:0;">${data.aiInsight}</p>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          ` : ''}

          <!-- CTA -->
          <tr>
            <td style="background:#1e293b;padding:0 40px 40px;text-align:center;">
              <a href="https://marketgrow.ai/dashboard" style="display:inline-block;background:#0284c7;color:#fff;text-decoration:none;font-size:14px;font-weight:700;padding:14px 32px;border-radius:10px;">
                Open dashboard →
              </a>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="background:#0f172a;border-radius:0 0 16px 16px;padding:24px 40px;text-align:center;">
              <p style="color:#475569;font-size:12px;margin:0;line-height:1.6;">
                Je ontvangt deze email omdat je een MarketGrow account hebt.<br>
                <a href="https://marketgrow.ai/settings" style="color:#0284c7;text-decoration:none;">Notificaties beheren</a>
                &nbsp;·&nbsp;
                <a href="https://marketgrow.ai/settings" style="color:#0284c7;text-decoration:none;">Uitschrijven</a>
              </p>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

// ── Stuur één briefing email ───────────────────────────────────
async function sendBriefingEmail(data: TenantBriefingData): Promise<void> {
  if (!RESEND_API_KEY) {
    logger.warn('email.resend_key_missing', { tenantId: data.tenantId });
    return;
  }

  const html = buildEmailHtml(data);

  const res = await fetch(RESEND_ENDPOINT, {
    method:  'POST',
    headers: {
      'Authorization': 'Bearer ' + RESEND_API_KEY,
      'Content-Type':  'application/json',
    },
    body: JSON.stringify({
      from:    FROM_EMAIL,
      to:      [data.email],
      subject: '📊 Jouw MarketGrow briefing — ' + new Date().toLocaleDateString('nl-NL', { day: 'numeric', month: 'long' }),
      html,
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error('Resend API fout (' + res.status + '): ' + body.slice(0, 200));
  }

  logger.info('email.briefing.sent', { tenantId: data.tenantId, email: data.email });
}

// ── Dagelijkse briefing voor alle actieve tenants ──────────────
export async function sendDailyBriefings(): Promise<void> {
  logger.info('email.daily_briefing.start');

  // Haal alle actieve tenants op met email
  const tenantsResult = await db.query(
    `SELECT DISTINCT
       t.id AS tenant_id,
       u.email,
       u.first_name,
       p.slug AS plan_slug
     FROM tenants t
     JOIN users u ON u.tenant_id = t.id AND u.role = 'owner'
     JOIN tenant_subscriptions ts ON ts.tenant_id = t.id AND ts.status IN ('active', 'trialing')
     JOIN plans p ON p.id = ts.plan_id
     WHERE t.id IN (
       SELECT DISTINCT tenant_id FROM tenant_integrations WHERE status = 'active'
     )
     ORDER BY t.id`,
    [],
    { allowNoTenant: true }
  );

  logger.info('email.daily_briefing.tenants', { count: tenantsResult.rows.length });

  for (const tenant of tenantsResult.rows) {
    try {
      // Haal verkoopdata op
      const [statsResult, topProductResult, aiResult] = await Promise.all([
        db.query(
          `SELECT
             COALESCE(SUM(total_amount - tax_amount), 0) AS revenue,
             COUNT(*)::int AS orders
           FROM orders
           WHERE tenant_id = $1
             AND ordered_at >= NOW() - INTERVAL '7 days'
             AND status NOT IN ('cancelled', 'refunded')`,
          [tenant.tenant_id],
          { allowNoTenant: true }
        ),
        db.query(
          `SELECT oli.title
           FROM order_line_items oli
           JOIN orders o ON o.id = oli.order_id
           WHERE oli.tenant_id = $1
             AND o.ordered_at >= NOW() - INTERVAL '7 days'
             AND o.status NOT IN ('cancelled', 'refunded')
             AND oli.total_price > 0
           GROUP BY oli.title
           ORDER BY SUM(oli.total_price) DESC
           LIMIT 1`,
          [tenant.tenant_id],
          { allowNoTenant: true }
        ),
        db.query(
          `SELECT value FROM tenant_settings WHERE tenant_id = $1 AND key = 'ai_last_briefing'`,
          [tenant.tenant_id],
          { allowNoTenant: true }
        ).catch(() => ({ rows: [] })),
      ]);

      const stats      = statsResult.rows[0];
      const topProduct = topProductResult.rows[0]?.title || null;
      const aiInsight  = aiResult.rows[0]?.value || null;

      await sendBriefingEmail({
        tenantId:   tenant.tenant_id,
        email:      tenant.email,
        firstName:  tenant.first_name || 'daar',
        planSlug:   tenant.plan_slug,
        revenue7d:  parseFloat(stats.revenue || '0'),
        orders7d:   parseInt(stats.orders || '0'),
        topProduct,
        aiInsight,
      });

      // Wacht 200ms tussen emails — respecteer Resend rate limits
      await new Promise(r => setTimeout(r, 200));
    } catch (err) {
      logger.error('email.briefing.failed', {
        tenantId: tenant.tenant_id,
        error:    (err as Error).message,
      });
    }
  }

  logger.info('email.daily_briefing.complete', { count: tenantsResult.rows.length });
}
