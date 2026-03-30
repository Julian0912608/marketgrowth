// ============================================================
// src/modules/notifications/admin.notifications.service.ts
//
// FIX: Verwijder JOIN op plans tabel voor MRR berekening.
//   Gebruikt nu COALESCE(t.plan_slug, 'starter') direct
//   en berekent MRR via hardcoded PLAN_MRR_CENTS map.
//   Dit voorkomt dat de dagelijkse email faalt als de
//   plans tabel nog geen monthly_price_cents kolom heeft.
//
// Emails naar hello@marketgrow.ai:
// 1. Direct bij nieuwe signup
// 2. Dagelijkse update om 18:00
// ============================================================

import { db }     from '../../infrastructure/database/connection';
import { logger } from '../../shared/logging/logger';

const RESEND_API_KEY  = process.env.RESEND_API_KEY || '';
const RESEND_ENDPOINT = 'https://api.resend.com/emails';
const ADMIN_EMAIL     = 'hello@marketgrow.ai';
const FROM_EMAIL      = 'MarketGrow Notificaties <noreply@marketgrow.ai>';

// MRR per plan in cents
const PLAN_MRR_CENTS: Record<string, number> = {
  starter: 2000,
  growth:  4900,
  scale:   15000,
};

// ── Helper: email versturen via Resend ────────────────────────
async function sendEmail(to: string, subject: string, html: string): Promise<void> {
  if (!RESEND_API_KEY) {
    logger.warn('admin.email.resend_key_missing');
    return;
  }

  const res = await fetch(RESEND_ENDPOINT, {
    method:  'POST',
    headers: {
      'Authorization': 'Bearer ' + RESEND_API_KEY,
      'Content-Type':  'application/json',
    },
    body: JSON.stringify({ from: FROM_EMAIL, to: [to], subject, html }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error('Resend API fout (' + res.status + '): ' + body.slice(0, 200));
  }
}

// ============================================================
// 1. NIEUWE SIGNUP NOTIFICATIE
// ============================================================
export async function sendNewSignupNotification(
  tenantId: string,
  planSlug: string
): Promise<void> {
  try {
    const result = await db.query<{
      name: string;
      email: string;
      created_at: Date;
    }>(
      `SELECT t.name, t.email, t.created_at
       FROM tenants t
       WHERE t.id = $1`,
      [tenantId],
      { allowNoTenant: true }
    );

    const tenant = result.rows[0];
    if (!tenant) return;

    // Totaal klanten + MRR zonder plans JOIN
    const statsResult = await db.query<{
      total_tenants: string;
      starter_count: string;
      growth_count:  string;
      scale_count:   string;
    }>(
      `SELECT
         COUNT(DISTINCT ts.tenant_id) AS total_tenants,
         COUNT(CASE WHEN COALESCE(t2.plan_slug, 'starter') = 'starter' THEN 1 END) AS starter_count,
         COUNT(CASE WHEN COALESCE(t2.plan_slug, 'starter') = 'growth'  THEN 1 END) AS growth_count,
         COUNT(CASE WHEN COALESCE(t2.plan_slug, 'starter') = 'scale'   THEN 1 END) AS scale_count
       FROM tenant_subscriptions ts
       JOIN tenants t2 ON t2.id = ts.tenant_id
       WHERE ts.status IN ('active', 'trialing')`,
      [],
      { allowNoTenant: true }
    );

    const stats = statsResult.rows[0];
    const totalMRR = (
      parseInt(stats.starter_count || '0') * PLAN_MRR_CENTS.starter +
      parseInt(stats.growth_count  || '0') * PLAN_MRR_CENTS.growth +
      parseInt(stats.scale_count   || '0') * PLAN_MRR_CENTS.scale
    ) / 100;

    const planEmoji  = planSlug === 'scale' ? '🚀' : planSlug === 'growth' ? '📈' : '🌱';
    const planPrices: Record<string, string> = {
      starter: '€20/maand',
      growth:  '€49/maand',
      scale:   '€150/maand',
    };

    const html = `
<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#f8fafc;font-family:'Helvetica Neue',Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="padding:40px 20px;">
    <tr><td align="center">
      <table width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;">
        <tr>
          <td style="background:#0f172a;border-radius:16px 16px 0 0;padding:28px 36px;">
            <span style="color:#fff;font-size:18px;font-weight:800;">⚡ MarketGrow</span>
            <span style="color:#64748b;font-size:13px;margin-left:12px;">Nieuwe aanmelding</span>
          </td>
        </tr>
        <tr>
          <td style="background:#1e293b;padding:32px 36px;">
            <h1 style="color:#10b981;font-size:24px;margin:0 0 8px;">
              ${planEmoji} Nieuwe klant!
            </h1>
            <p style="color:#94a3b8;font-size:14px;margin:0 0 28px;">
              ${new Date().toLocaleDateString('nl-NL', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' })}
            </p>
            <table width="100%" cellpadding="0" cellspacing="0" style="background:#0f172a;border:1px solid #334155;border-radius:12px;padding:20px;margin-bottom:20px;">
              <tr>
                <td style="padding:6px 0;">
                  <span style="color:#64748b;font-size:12px;display:block;">Bedrijf</span>
                  <span style="color:#fff;font-size:15px;font-weight:600;">${tenant.name}</span>
                </td>
              </tr>
              <tr>
                <td style="padding:6px 0;border-top:1px solid #1e293b;">
                  <span style="color:#64748b;font-size:12px;display:block;">Email</span>
                  <span style="color:#38bdf8;font-size:14px;">${tenant.email}</span>
                </td>
              </tr>
              <tr>
                <td style="padding:6px 0;border-top:1px solid #1e293b;">
                  <span style="color:#64748b;font-size:12px;display:block;">Plan</span>
                  <span style="color:#fff;font-size:14px;font-weight:600;">${planSlug.charAt(0).toUpperCase() + planSlug.slice(1)} — ${planPrices[planSlug] || ''}</span>
                </td>
              </tr>
            </table>
            <table width="100%" cellpadding="0" cellspacing="0">
              <tr>
                <td width="48%" style="background:#0f172a;border:1px solid #334155;border-radius:12px;padding:16px;text-align:center;">
                  <div style="color:#64748b;font-size:11px;text-transform:uppercase;letter-spacing:0.05em;">Totaal klanten</div>
                  <div style="color:#fff;font-size:28px;font-weight:800;margin-top:4px;">${stats.total_tenants}</div>
                </td>
                <td width="4%"></td>
                <td width="48%" style="background:#0f172a;border:1px solid #334155;border-radius:12px;padding:16px;text-align:center;">
                  <div style="color:#64748b;font-size:11px;text-transform:uppercase;letter-spacing:0.05em;">Totaal MRR</div>
                  <div style="color:#10b981;font-size:28px;font-weight:800;margin-top:4px;">€${totalMRR.toFixed(0)}</div>
                </td>
              </tr>
            </table>
          </td>
        </tr>
        <tr>
          <td style="background:#0f172a;border-radius:0 0 16px 16px;padding:16px 36px;text-align:center;">
            <a href="https://marketgrow.ai/admin" style="color:#4f46e5;font-size:13px;text-decoration:none;">
              Bekijk in admin dashboard →
            </a>
          </td>
        </tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;

    await sendEmail(
      ADMIN_EMAIL,
      `${planEmoji} Nieuwe ${planSlug} klant: ${tenant.name}`,
      html
    );

    logger.info('admin.email.signup_notification.sent', { tenantId, planSlug });
  } catch (err) {
    logger.error('admin.email.signup_notification.failed', {
      tenantId,
      error: (err as Error).message,
    });
  }
}

// ============================================================
// 2. DAGELIJKSE ADMIN UPDATE — elke dag om 18:00
// ============================================================
export async function sendDailyAdminUpdate(): Promise<void> {
  try {
    const [overviewResult, newTodayResult, churnTodayResult, planBreakdownResult] = await Promise.all([

      // Totaal overzicht — geen plans JOIN nodig
      db.query<{
        total_active:   string;
        total_trialing: string;
        total_past_due: string;
        starter_active: string;
        growth_active:  string;
        scale_active:   string;
      }>(
        `SELECT
           COUNT(CASE WHEN ts.status = 'active'   THEN 1 END) AS total_active,
           COUNT(CASE WHEN ts.status = 'trialing' THEN 1 END) AS total_trialing,
           COUNT(CASE WHEN ts.status = 'past_due' THEN 1 END) AS total_past_due,
           COUNT(CASE WHEN ts.status IN ('active','trialing') AND COALESCE(t.plan_slug,'starter') = 'starter' THEN 1 END) AS starter_active,
           COUNT(CASE WHEN ts.status IN ('active','trialing') AND COALESCE(t.plan_slug,'starter') = 'growth'  THEN 1 END) AS growth_active,
           COUNT(CASE WHEN ts.status IN ('active','trialing') AND COALESCE(t.plan_slug,'starter') = 'scale'   THEN 1 END) AS scale_active
         FROM tenant_subscriptions ts
         JOIN tenants t ON t.id = ts.tenant_id`,
        [], { allowNoTenant: true }
      ),

      // Nieuwe klanten vandaag
      db.query<{ name: string; email: string; plan_slug: string }>(
        `SELECT t.name, t.email, COALESCE(t.plan_slug, 'starter') AS plan_slug
         FROM tenants t
         WHERE t.created_at >= CURRENT_DATE
         ORDER BY t.created_at DESC`,
        [], { allowNoTenant: true }
      ),

      // Opgezegd vandaag
      db.query<{ name: string; email: string }>(
        `SELECT t.name, t.email
         FROM tenants t
         JOIN tenant_subscriptions ts ON ts.tenant_id = t.id
         WHERE ts.status = 'cancelled'
           AND ts.updated_at >= CURRENT_DATE`,
        [], { allowNoTenant: true }
      ),

      // Klanten per plan
      db.query<{ plan_slug: string; count: string }>(
        `SELECT COALESCE(t.plan_slug, 'starter') AS plan_slug, COUNT(*) AS count
         FROM tenant_subscriptions ts
         JOIN tenants t ON t.id = ts.tenant_id
         WHERE ts.status IN ('active', 'trialing')
         GROUP BY t.plan_slug`,
        [], { allowNoTenant: true }
      ),
    ]);

    const overview      = overviewResult.rows[0];
    const newToday      = newTodayResult.rows;
    const churnToday    = churnTodayResult.rows;
    const planBreakdown = planBreakdownResult.rows;

    // Bereken MRR zonder plans tabel
    const totalMRR = (
      parseInt(overview.starter_active || '0') * PLAN_MRR_CENTS.starter +
      parseInt(overview.growth_active  || '0') * PLAN_MRR_CENTS.growth +
      parseInt(overview.scale_active   || '0') * PLAN_MRR_CENTS.scale
    ) / 100;

    const planCounts: Record<string, string> = {};
    for (const row of planBreakdown) {
      planCounts[row.plan_slug] = row.count;
    }

    const newTodayRows = newToday.length > 0
      ? newToday.map(t => `
          <tr>
            <td style="padding:8px 0;border-bottom:1px solid #1e293b;">
              <span style="color:#fff;font-size:13px;">${t.name}</span>
              <span style="color:#64748b;font-size:12px;margin-left:8px;">${t.email}</span>
            </td>
            <td style="padding:8px 0;border-bottom:1px solid #1e293b;text-align:right;">
              <span style="background:#1e3a5f;color:#38bdf8;font-size:11px;padding:2px 8px;border-radius:20px;">${t.plan_slug}</span>
            </td>
          </tr>`).join('')
      : `<tr><td colspan="2" style="color:#64748b;font-size:13px;padding:12px 0;">Geen nieuwe klanten vandaag</td></tr>`;

    const churnTodayRows = churnToday.length > 0
      ? churnToday.map(t => `
          <tr>
            <td style="padding:8px 0;border-bottom:1px solid #1e293b;">
              <span style="color:#f87171;font-size:13px;">${t.name}</span>
              <span style="color:#64748b;font-size:12px;margin-left:8px;">${t.email}</span>
            </td>
          </tr>`).join('')
      : `<tr><td style="color:#64748b;font-size:13px;padding:12px 0;">Geen opgezegde klanten vandaag</td></tr>`;

    const html = `
<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#f8fafc;font-family:'Helvetica Neue',Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="padding:40px 20px;">
    <tr><td align="center">
      <table width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;">
        <tr>
          <td style="background:#0f172a;border-radius:16px 16px 0 0;padding:28px 36px;">
            <span style="color:#fff;font-size:18px;font-weight:800;">⚡ MarketGrow</span>
            <span style="color:#64748b;font-size:13px;margin-left:12px;">Dagelijkse update</span>
            <p style="color:#475569;font-size:12px;margin:8px 0 0;">
              ${new Date().toLocaleDateString('nl-NL', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}
            </p>
          </td>
        </tr>
        <tr>
          <td style="background:#1e293b;padding:32px 36px;">

            <!-- KPI's -->
            <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:28px;">
              <tr>
                <td width="23%" style="background:#0f172a;border:1px solid #334155;border-radius:10px;padding:14px;text-align:center;">
                  <div style="color:#64748b;font-size:10px;text-transform:uppercase;letter-spacing:0.05em;">MRR</div>
                  <div style="color:#10b981;font-size:22px;font-weight:800;margin-top:4px;">€${totalMRR.toFixed(0)}</div>
                </td>
                <td width="2%"></td>
                <td width="23%" style="background:#0f172a;border:1px solid #334155;border-radius:10px;padding:14px;text-align:center;">
                  <div style="color:#64748b;font-size:10px;text-transform:uppercase;letter-spacing:0.05em;">Actief</div>
                  <div style="color:#fff;font-size:22px;font-weight:800;margin-top:4px;">${overview.total_active || 0}</div>
                </td>
                <td width="2%"></td>
                <td width="23%" style="background:#0f172a;border:1px solid #334155;border-radius:10px;padding:14px;text-align:center;">
                  <div style="color:#64748b;font-size:10px;text-transform:uppercase;letter-spacing:0.05em;">Trial</div>
                  <div style="color:#f59e0b;font-size:22px;font-weight:800;margin-top:4px;">${overview.total_trialing || 0}</div>
                </td>
                <td width="2%"></td>
                <td width="23%" style="background:#0f172a;border:1px solid #334155;border-radius:10px;padding:14px;text-align:center;">
                  <div style="color:#64748b;font-size:10px;text-transform:uppercase;letter-spacing:0.05em;">Nieuw</div>
                  <div style="color:#818cf8;font-size:22px;font-weight:800;margin-top:4px;">${newToday.length}</div>
                </td>
              </tr>
            </table>

            <!-- Plan verdeling -->
            <div style="margin-bottom:24px;">
              <p style="color:#94a3b8;font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:0.05em;margin:0 0 12px;">
                Plan verdeling
              </p>
              <table width="100%" cellpadding="0" cellspacing="0" style="background:#0f172a;border:1px solid #334155;border-radius:10px;padding:4px 16px;">
                ${['starter','growth','scale'].map(slug => `
                  <tr>
                    <td style="padding:8px 0;border-bottom:1px solid #1e293b;">
                      <span style="color:#fff;font-size:13px;text-transform:capitalize;">${slug}</span>
                    </td>
                    <td style="padding:8px 0;border-bottom:1px solid #1e293b;text-align:right;">
                      <span style="color:#94a3b8;font-size:13px;">${planCounts[slug] || 0} klanten</span>
                    </td>
                  </tr>`).join('')}
              </table>
            </div>

            <!-- Nieuwe klanten vandaag -->
            <div style="margin-bottom:24px;">
              <p style="color:#94a3b8;font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:0.05em;margin:0 0 12px;">
                Nieuwe klanten vandaag (${newToday.length})
              </p>
              <table width="100%" cellpadding="0" cellspacing="0" style="background:#0f172a;border:1px solid #334155;border-radius:10px;padding:4px 16px;">
                ${newTodayRows}
              </table>
            </div>

            <!-- Opgezegd vandaag -->
            <div>
              <p style="color:#94a3b8;font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:0.05em;margin:0 0 12px;">
                Opgezegd vandaag (${churnToday.length})
              </p>
              <table width="100%" cellpadding="0" cellspacing="0" style="background:#0f172a;border:1px solid #334155;border-radius:10px;padding:4px 16px;">
                ${churnTodayRows}
              </table>
            </div>
          </td>
        </tr>
        <tr>
          <td style="background:#0f172a;border-radius:0 0 16px 16px;padding:16px 36px;text-align:center;">
            <a href="https://marketgrow.ai/admin" style="color:#4f46e5;font-size:13px;text-decoration:none;">
              Bekijk volledig admin dashboard →
            </a>
          </td>
        </tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;

    await sendEmail(
      ADMIN_EMAIL,
      `📊 Dagelijkse update — €${totalMRR.toFixed(0)} MRR · ${parseInt(overview.total_active || '0') + parseInt(overview.total_trialing || '0')} klanten`,
      html
    );

    logger.info('admin.email.daily_update.sent');
  } catch (err) {
    logger.error('admin.email.daily_update.failed', {
      error: (err as Error).message,
    });
  }
}
