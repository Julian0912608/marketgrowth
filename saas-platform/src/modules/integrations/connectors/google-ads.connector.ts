// ============================================================
// src/modules/integrations/connectors/google-ads.connector.ts
//
// Google Ads API connector
// Authenticatie: OAuth2 via Google (access token + refresh token)
// API: Google Ads API v23
// Rate limits: Explorer Access = 2.880 ops/dag, Basic = 15.000/dag
//
// Setup vereist (eenmalig):
//   1. Google Cloud Console → nieuw project aanmaken
//   2. Google Ads API inschakelen
//   3. OAuth2 credentials aanmaken (Web application)
//   4. Redirect URI toevoegen: https://marketgrowth-production.up.railway.app/api/integrations/callback/google-ads
//   5. Google Ads Manager account → API Center → developer token aanvragen
//
// Railway env vars nodig:
//   GOOGLE_ADS_CLIENT_ID=...
//   GOOGLE_ADS_CLIENT_SECRET=...
//   GOOGLE_ADS_DEVELOPER_TOKEN=...
// ============================================================

import { db }     from '../../../infrastructure/database/connection';
import { logger } from '../../../shared/logging/logger';

const API_BASE        = 'https://googleads.googleapis.com/v23';
const TOKEN_URL       = 'https://oauth2.googleapis.com/token';
const AUTH_URL        = 'https://accounts.google.com/o/oauth2/v2/auth';

const CLIENT_ID       = () => process.env.GOOGLE_ADS_CLIENT_ID       ?? '';
const CLIENT_SECRET   = () => process.env.GOOGLE_ADS_CLIENT_SECRET   ?? '';
const DEVELOPER_TOKEN = () => process.env.GOOGLE_ADS_DEVELOPER_TOKEN ?? '';
const REDIRECT_URI    = () => `${process.env.APP_URL || 'https://marketgrow.ai'}/api/integrations/callback/google-ads`;

// ── Types ─────────────────────────────────────────────────────

interface GoogleAdsCampaign {
  campaign: {
    id:     string;
    name:   string;
    status: string;
  };
  metrics: {
    impressions:           string;
    clicks:                string;
    costMicros:            string;
    conversions:           string;
    conversionsValue:      string;
    averageCpc:            string;
  };
}

export interface GoogleAdsSyncResult {
  campaignCount: number;
  hasAccess:     boolean;
}

// ── OAuth helpers ─────────────────────────────────────────────

export function buildGoogleAuthUrl(state: string): string {
  const params = new URLSearchParams({
    client_id:     CLIENT_ID(),
    redirect_uri:  REDIRECT_URI(),
    response_type: 'code',
    scope:         'https://www.googleapis.com/auth/adwords',
    access_type:   'offline',
    prompt:        'consent', // forceert refresh token
    state,
  });
  return `${AUTH_URL}?${params}`;
}

export async function exchangeGoogleCode(code: string): Promise<{
  accessToken:  string;
  refreshToken: string;
  expiresAt:    Date;
}> {
  const res = await fetch(TOKEN_URL, {
    method:  'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body:    new URLSearchParams({
      code,
      client_id:     CLIENT_ID(),
      client_secret: CLIENT_SECRET(),
      redirect_uri:  REDIRECT_URI(),
      grant_type:    'authorization_code',
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Google OAuth exchange mislukt (${res.status}): ${body.slice(0, 200)}`);
  }

  const data = await res.json() as {
    access_token:  string;
    refresh_token: string;
    expires_in:    number;
  };

  return {
    accessToken:  data.access_token,
    refreshToken: data.refresh_token,
    expiresAt:    new Date(Date.now() + data.expires_in * 1000),
  };
}

export async function refreshGoogleToken(refreshToken: string): Promise<{
  accessToken: string;
  expiresAt:   Date;
}> {
  const res = await fetch(TOKEN_URL, {
    method:  'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body:    new URLSearchParams({
      refresh_token: refreshToken,
      client_id:     CLIENT_ID(),
      client_secret: CLIENT_SECRET(),
      grant_type:    'refresh_token',
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Google token refresh mislukt (${res.status}): ${body.slice(0, 200)}`);
  }

  const data = await res.json() as { access_token: string; expires_in: number };
  return {
    accessToken: data.access_token,
    expiresAt:   new Date(Date.now() + data.expires_in * 1000),
  };
}

// ── Haal customer IDs op (ad accounts) ───────────────────────

async function fetchCustomerIds(accessToken: string): Promise<string[]> {
  const res = await fetch(`${API_BASE}/customers:listAccessibleCustomers`, {
    headers: {
      'Authorization':     `Bearer ${accessToken}`,
      'developer-token':   DEVELOPER_TOKEN(),
      'Content-Type':      'application/json',
    },
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Google Ads customer list mislukt (${res.status}): ${body.slice(0, 200)}`);
  }

  const data = await res.json() as { resourceNames?: string[] };
  // resourceNames zijn in format "customers/1234567890"
  return (data.resourceNames ?? []).map(n => n.replace('customers/', ''));
}

// ── Haal campagne performance op via Google Ads Query Language ─

async function fetchCampaignInsights(
  accessToken: string,
  customerId:  string,
  startDate:   string,
  endDate:     string,
): Promise<GoogleAdsCampaign[]> {
  const query = `
    SELECT
      campaign.id,
      campaign.name,
      campaign.status,
      metrics.impressions,
      metrics.clicks,
      metrics.cost_micros,
      metrics.conversions,
      metrics.conversions_value,
      metrics.average_cpc
    FROM campaign
    WHERE segments.date BETWEEN '${startDate}' AND '${endDate}'
      AND campaign.status != 'REMOVED'
    ORDER BY metrics.cost_micros DESC
    LIMIT 100
  `;

  const res = await fetch(`${API_BASE}/customers/${customerId}/googleAds:searchStream`, {
    method:  'POST',
    headers: {
      'Authorization':     `Bearer ${accessToken}`,
      'developer-token':   DEVELOPER_TOKEN(),
      'Content-Type':      'application/json',
    },
    body: JSON.stringify({ query }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    logger.warn('google.ads.insights.failed', { customerId, status: res.status, body: body.slice(0, 300) });
    return [];
  }

  // searchStream returnt newline-delimited JSON
  const text   = await res.text();
  const rows   = text.trim().split('\n').filter(Boolean);
  const result: GoogleAdsCampaign[] = [];

  for (const row of rows) {
    try {
      const parsed = JSON.parse(row) as { results?: GoogleAdsCampaign[] };
      result.push(...(parsed.results ?? []));
    } catch {}
  }

  return result;
}

// ── Hoofd sync functie ────────────────────────────────────────

export async function syncGoogleAdsData(
  tenantId:      string,
  integrationId: string,
  accessToken:   string,
): Promise<GoogleAdsSyncResult> {

  // Haal klant IDs op
  let customerIds: string[] = [];
  try {
    customerIds = await fetchCustomerIds(accessToken);
  } catch (err: any) {
    logger.warn('google.ads.customers.failed', { tenantId, error: err.message });
    return { campaignCount: 0, hasAccess: false };
  }

  if (customerIds.length === 0) {
    logger.info('google.ads.no_customers', { tenantId });
    return { campaignCount: 0, hasAccess: true };
  }

  // Laatste 30 dagen
  const endDate   = new Date();
  const startDate = new Date(Date.now() - 30 * 86400000);
  const fmtDate   = (d: Date) => d.toISOString().split('T')[0];

  let totalSaved = 0;

  // Sync per customer (ad account)
  for (const customerId of customerIds.slice(0, 10)) { // max 10 accounts
    try {
      const campaigns = await fetchCampaignInsights(
        accessToken,
        customerId,
        fmtDate(startDate),
        fmtDate(endDate),
      );

      for (const row of campaigns) {
        const c = row.campaign;
        const m = row.metrics;

        const spend       = parseInt(m.costMicros    ?? '0') / 1_000_000;
        const revenue     = parseFloat(m.conversionsValue ?? '0');
        const clicks      = parseInt(m.clicks          ?? '0');
        const impressions = parseInt(m.impressions      ?? '0');
        const conversions = parseFloat(m.conversions    ?? '0');
        const roas        = spend > 0 ? revenue / spend : null;

        const status = c.status === 'ENABLED' ? 'active' : c.status === 'PAUSED' ? 'paused' : 'inactive';

        await db.query(
          `INSERT INTO ad_campaigns
             (tenant_id, integration_id, external_id, platform, name, status,
              spend, impressions, clicks, conversions, revenue, roas, updated_at)
           VALUES ($1, $2, $3, 'google', $4, $5, $6, $7, $8, $9, $10, $11, now())
           ON CONFLICT (tenant_id, external_id, platform)
           DO UPDATE SET
             name = EXCLUDED.name,
             status = EXCLUDED.status,
             spend = EXCLUDED.spend,
             impressions = EXCLUDED.impressions,
             clicks = EXCLUDED.clicks,
             conversions = EXCLUDED.conversions,
             revenue = EXCLUDED.revenue,
             roas = EXCLUDED.roas,
             updated_at = now()`,
          [
            tenantId, integrationId, `google_${customerId}_${c.id}`,
            c.name, status, spend, impressions, clicks, conversions, revenue, roas,
          ],
          { allowNoTenant: true }
        );

        totalSaved++;
      }

      // Respecteer rate limits
      await new Promise(r => setTimeout(r, 200));

    } catch (err: any) {
      logger.warn('google.ads.customer.sync.failed', { tenantId, customerId, error: err.message });
    }
  }

  logger.info('google.ads.sync.complete', { tenantId, integrationId, totalSaved });
  return { campaignCount: totalSaved, hasAccess: true };
}
