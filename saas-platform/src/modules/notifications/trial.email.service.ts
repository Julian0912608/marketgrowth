// ============================================================
// src/modules/notifications/trial.email.service.ts
//
// Stuurt automatisch emails op dag 10 en dag 13 van de trial
// om gebruikers te herinneren dat hun trial bijna afloopt
// Wordt getriggerd via BullMQ scheduler (dagelijks om 09:00)
// ============================================================

import { db }     from '../../infrastructure/database/connection';
import { logger } from '../../shared/logging/logger';

const RESEND_API_KEY  = process.env.RESEND_API_KEY || '';
const RESEND_ENDPOINT = 'https://api.resend.com/emails';
const FROM_EMAIL      = 'MarketGrow <hello@marketgrow.ai>';
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

// ── Dag 10 email: "4 dagen resterend" ────────────────────────
function buildDay10Html(firstName: string, planSlug: string, daysLeft: number): string {
  const planPrices: Record<string, string> = {
    starter: '€20/maand',
    growth:  '€49/maand',
    scale:   '€150/maand',
  };
  const planName  = planSlug.charAt(0).toUpperCase() + planSlug.slice(1);
  const planPrice = planPrices[planSlug] ?? '€49/maand';

  return `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#f8fafc;font-family:'Helvetica Neue',Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="padding:40px 20px;">
    <tr><td align="center">
      <table width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;">

        <tr>
          <td style="background:#0f172a;border-radius:16px 16px 0 0;padding:28px 36px;">
            <span style="color:#fff;font-size:18px;font-weight:800;">⚡ MarketGrow</span>
          </td>
        </tr>

        <tr>
          <td style="background:#1e293b;padding:32px 36px;">
            <div style="background:#f59e0b;border-radius:10px;padding:12px 16px;margin-bottom:24px;display:inline-block;">
              <span style="color:#fff;font-size:13px;font-weight:700;">⏰ ${daysLeft} dagen resterend in je trial</span>
            </div>

            <h1 style="color:#fff;font-size:22px;margin:0 0 12px;">
              Hoe bevalt MarketGrow tot nu toe, ${firstName}?
            </h1>
            <p style="color:#94a3b8;font-size:14px;line-height:1.7;margin:0 0 20px;">
              Je trial loopt over ${daysLeft} dagen af. Tot nu toe heb je toegang gehad tot alle
              AI-gestuurde inzichten, kanaalspecifieke acties en je dagelijkse briefing.
            </p>
            <p style="color:#94a3b8;font-size:14px;line-height:1.7;margin:0 0 28px;">
              Zet je ${planName} plan voort voor slechts <strong style="color:#fff;">${planPrice}</strong>
              en mis geen enkele dag zonder je AI-acties.
            </p>

            <a href="${APP_URL}/settings?tab=billing"
               style="display:inline-block;background:#4f46e5;color:#fff;font-weight:700;font-size:14px;padding:14px 32px;border-radius:10px;text-decoration:none;">
              Plan activeren →
            </a>

            <div style="margin-top:32px;padding-top:24px;border-top:1px solid #334155;">
              <p style="color:#64748b;font-size:13px;margin:0 0 12px;">Wat je behoudt na activatie:</p>
              <table cellpadding="0" cellspacing="0">
                ${[
                  'Dagelijkse AI acties per kanaal en product',
                  'Kanaalspecifieke aanbevelingen (Bol.com, Shopify…)',
                  'Advertentie analyse en ROAS inzichten',
                  'Automatische data sync elk uur',
                ].map(f => `<tr>
                  <td style="padding:4px 0;color:#10b981;font-size:16px;width:24px;">✓</td>
                  <td style="padding:4px 0;color:#94a3b8;font-size:13px;">${f}</td>
                </tr>`).join('')}
              </table>
            </div>
          </td>
        </tr>

        <tr>
          <td style="background:#0f172a;border-radius:0 0 16px 16px;padding:16px 36px;text-align:center;">
            <p style="color:#475569;font-size:11px;margin:0;">
              Geen kosten tot je trial afloopt · Opzeggen kan altijd
            </p>
          </td>
        </tr>

      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

// ── Dag 13 email: "morgen is het zover" ──────────────────────
function buildDay13Html(firstName: string, planSlug: string): string {
  const planPrices: Record<string, string> = {
    starter: '€20/maand',
    growth:  '€49/maand',
    scale:   '€150/maand',
  };
  const planName  = planSlug.charAt(0).toUpperCase() + planSlug.slice(1);
  const planPrice = planPrices[planSlug] ?? '€49/maand';

  return `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#f8fafc;font-family:'Helvetica Neue',Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="padding:40px 20px;">
    <tr><td align="center">
      <table width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;">

        <tr>
          <td style="background:#0f172a;border-radius:16px 16px 0 0;padding:28px 36px;">
            <span style="color:#fff;font-size:18px;font-weight:800;">⚡ MarketGrow</span>
          </td>
        </tr>

        <tr>
          <td style="background:#1e293b;padding:32px 36px;">
            <div style="background:#ef4444;border-radius:10px;padding:12px 16px;margin-bottom:24px;display:inline-block;">
              <span style="color:#fff;font-size:13px;font-weight:700;">🔔 Je trial verloopt morgen</span>
            </div>

            <h1 style="color:#fff;font-size:22px;margin:0 0 12px;">
              Morgen is je laatste dag, ${firstName}
            </h1>
            <p style="color:#94a3b8;font-size:14px;line-height:1.7;margin:0 0 20px;">
              Na morgen heb je geen toegang meer tot je AI-acties, dagelijkse briefing
              en advertentie-inzichten — tenzij je je ${planName} plan activeert.
            </p>
            <p style="color:#94a3b8;font-size:14px;line-height:1.7;margin:0 0 28px;">
              Activeer vandaag nog voor <strong style="color:#fff;">${planPrice}</strong>.
              Je wordt pas gefactureerd nadat de trial is afgelopen.
            </p>

            <a href="${APP_URL}/settings?tab=billing"
               style="display:inline-block;background:#4f46e5;color:#fff;font-weight:700;font-size:14px;padding:14px 32px;border-radius:10px;text-decoration:none;">
              Nu activeren — ${planPrice} →
            </a>

            <p style="color:#64748b;font-size:12px;margin:20px 0 0;">
              Liever niet doorgaan? Dan hoef je niets te doen — je account wordt automatisch
              teruggezet naar het gratis niveau na de trial.
            </p>
          </td>
        </tr>

        <tr>
          <td style="background:#0f172a;border-radius:0 0 16px 16px;padding:16px 36px;text-align:center;">
            <p style="color:#475569;font-size:11px;margin:0;">
              Vragen? Mail ons op <a href="mailto:hello@marketgrow.ai" style="color:#4f46e5;">hello@marketgrow.ai</a>
            </p>
          </td>
        </tr>

      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

// ── Hoofdfunctie: stuur trial emails voor vandaag ─────────────
export async function sendTrialEmails(): Promise<void> {
  logger.info('trial.emails.start');

  // Haal tenants op die dag 10 of dag 13 in hun trial zitten
  // current_period_end is de einddatum van de trial (14 dagen na start)
  const result = await db.query<{
    tenant_id:  string;
    email:      string;
    first_name: string;
    plan_slug:  string;
    trial_end:  Date;
    days_left:  number;
  }>(
    `SELECT
       t.id          AS tenant_id,
       u.email,
       u.first_name,
       p.slug        AS plan_slug,
       ts.current_period_end AS trial_end,
       EXTRACT(DAY FROM (ts.current_period_end - now()))::int AS days_left
     FROM tenant_subscriptions ts
     JOIN tenants t  ON t.id  = ts.tenant_id
     JOIN plans p    ON p.id  = ts.plan_id
     JOIN users u    ON u.tenant_id = t.id AND u.role = 'owner'
     WHERE ts.status = 'trialing'
       AND EXTRACT(DAY FROM (ts.current_period_end - now()))::int IN (4, 1)
     ORDER BY ts.current_period_end ASC`,
    [],
    { allowNoTenant: true }
  );

  logger.info('trial.emails.tenants', { count: result.rows.length });

  for (const tenant of result.rows) {
    try {
      const firstName = tenant.first_name || 'daar';
      const daysLeft  = tenant.days_left;
      const isDay10   = daysLeft === 4; // dag 10 = 4 dagen resterend
      const isDay13   = daysLeft === 1; // dag 13 = 1 dag resterend

      if (isDay10) {
        const html    = buildDay10Html(firstName, tenant.plan_slug, daysLeft);
        const subject = `⏰ Nog ${daysLeft} dagen in je MarketGrow trial`;
        await sendEmail(tenant.email, subject, html);
        logger.info('trial.email.day10.sent', { tenantId: tenant.tenant_id });
      } else if (isDay13) {
        const html    = buildDay13Html(firstName, tenant.plan_slug);
        const subject = '🔔 Je MarketGrow trial verloopt morgen';
        await sendEmail(tenant.email, subject, html);
        logger.info('trial.email.day13.sent', { tenantId: tenant.tenant_id });
      }

      // Wacht 200ms tussen emails — respecteer Resend rate limits
      await new Promise(r => setTimeout(r, 200));
    } catch (err) {
      logger.error('trial.email.failed', {
        tenantId: tenant.tenant_id,
        error:    (err as Error).message,
      });
    }
  }

  logger.info('trial.emails.complete', { count: result.rows.length });
}
