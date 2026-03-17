// ============================================================
// saas-platform/src/modules/integrations/connectors/bolcom-advertising.connector.ts
//
// Bol.com Advertising API v11 — gebaseerd op de officiële OpenAPI YAML spec
//
// Base URL (uit campaign-management.yml servers sectie):
//   https://api.bol.com/advertiser/sponsored-products/campaign-management
//
// Correcte endpoints (uit YAML paths sectie):
//   POST /campaigns/list  → campagnes ophalen (getCampaigns)
//   POST /campaigns       → campagne aanmaken
//   PUT  /campaigns       → campagne updaten
//
// Auth: Client Credentials via https://login.bol.com/token?grant_type=client_credentials
//   Zelfde flow als Retailer API maar met Advertising credentials
//   Token scope = "advertiser"
// ============================================================

import { cache }  from '../../../infrastructure/cache/redis';
import { db }     from '../../../infrastructure/database/connection';
import { logger } from '../../../shared/logging/logger';

// !! Correcte base URL uit de OpenAPI YAML spec — geen versienummer in het pad
const CAMPAIGN_BASE    = 'https://api.bol.com/advertiser/sponsored-products/campaign-management';
const TOKEN_URL        = 'https://login.bol.com/token?grant_type=client_credentials';
const TOKEN_CACHE_KEY  = 'bolcom:adv:token:';
const ADV_CONTENT_TYPE = 'application/vnd.advertiser.v11+json';

export interface BolAdCampaign {
  campaignId:    string;
  name:          string;
  state:         string;
  dailyBudget?:  { amount: number; currency: string };
  totalBudget?:  { amount: number; currency: string };
  startDate?:    string;
  endDate?:      string;
  campaignType?: string;
}

export interface BolAdPerformance {
  campaignId:   string;
  campaignName: string;
  status:       string;
  spend:        number;
  impressions:  number;
  clicks:       number;
  conversions:  number;
  revenue:      number;
  roas:         number | null;
  ctr:          number | null;
  cpc:          number | null;
  acos:         number | null;
}

export class BolcomAdvertisingConnector {

  // ── Token ophalen ─────────────────────────────────────────
  private async getToken(clientId: string, clientSecret: string): Promise<string> {
    const cacheKey = TOKEN_CACHE_KEY + clientId;
    try {
      const cached = await cache.get(cacheKey);
      if (cached) return cached;
    } catch {}

    const encoded = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
    const res = await fetch(TOKEN_URL, {
      method:  'POST',
      headers: {
        'Authorization': `Basic ${encoded}`,
        'Accept':        'application/json',
        'Content-Type':  'application/x-www-form-urlencoded',
      },
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Token mislukt (${res.status}): ${body.slice(0, 200)}`);
    }

    const data = await res.json() as { access_token: string; expires_in?: number };
    const ttl  = Math.max((data.expires_in || 299) - 60, 30);
    try { await cache.set(cacheKey, data.access_token, ttl); } catch {}
    return data.access_token;
  }

  // ── Verbinding testen ─────────────────────────────────────
  async testConnection(clientId: string, clientSecret: string): Promise<{ success: boolean; error?: string }> {
    // Stap 1: token ophalen
    let token: string;
    try {
      token = await this.getToken(clientId, clientSecret);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return { success: false, error: `Auth mislukt: ${msg}` };
    }

    // Stap 2: POST /campaigns/list (correct endpoint uit YAML spec)
    const res = await fetch(`${CAMPAIGN_BASE}/campaigns/list`, {
      method:  'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Accept':        ADV_CONTENT_TYPE,
        'Content-Type':  ADV_CONTENT_TYPE,
      },
      body: JSON.stringify({ page: 1, pageSize: 1 }),
    });

    const text = await res.text().catch(() => '');
    let data: any = {};
    try { data = JSON.parse(text); } catch {}

    if (res.status === 401) return { success: false, error: 'Token ongeldig.' };
    if (res.status === 403) return { success: false, error: `403 van Bol.com: ${data?.detail || text.slice(0, 200)}` };
    if (!res.ok && res.status !== 404) return { success: false, error: `API fout ${res.status}: ${text.slice(0, 200)}` };

    return { success: true };
  }

  // ── Campagnes ophalen via POST /campaigns/list ────────────
  async fetchCampaigns(token: string): Promise<BolAdCampaign[]> {
    const all: BolAdCampaign[] = [];
    let page = 1;

    while (true) {
      const res = await fetch(`${CAMPAIGN_BASE}/campaigns/list`, {
        method:  'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Accept':        ADV_CONTENT_TYPE,
          'Content-Type':  ADV_CONTENT_TYPE,
        },
        body: JSON.stringify({ page, pageSize: 50 }),
      });

      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`Campagnes ophalen mislukt (${res.status}): ${body.slice(0, 200)}`);
      }

      const data = await res.json() as { campaigns?: BolAdCampaign[] };
      const campaigns = data.campaigns || [];
      all.push(...campaigns);

      if (campaigns.length < 50) break;
      page++;
      if (page > 20) break;
    }

    return all;
  }

  // ── Performance data ophalen ──────────────────────────────
  // Reporting heeft een aparte base URL — zie reporting.yml
  async fetchPerformance(
    token:       string,
    campaignIds: string[],
    startDate:   string,
    endDate:     string
  ): Promise<Record<string, { spend: number; impressions: number; clicks: number; conversions: number; revenue: number }>> {
    if (campaignIds.length === 0) return {};

    // Reporting API base URL (apart van campaign-management)
    const reportingBase = 'https://api.bol.com/advertiser/sponsored-products/reporting';

    const res = await fetch(`${reportingBase}/performance/campaigns`, {
      method:  'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Accept':        ADV_CONTENT_TYPE,
        'Content-Type':  ADV_CONTENT_TYPE,
      },
      body: JSON.stringify({ campaignIds, startDate, endDate }),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      logger.warn('bolcom.adv.performance.failed', { status: res.status, body: body.slice(0, 200) });
      return {};
    }

    const data = await res.json() as { campaignReports?: any[]; reports?: any[] };
    const out: Record<string, any> = {};

    for (const r of (data.campaignReports || data.reports || [])) {
      out[r.campaignId] = {
        spend:       parseFloat(r.spend || r.cost || 0),
        impressions: parseInt(r.impressions || 0),
        clicks:      parseInt(r.clicks || 0),
        conversions: parseFloat(r.conversions14d || r.conversions || 0),
        revenue:     parseFloat(r.sales14d || r.revenue || 0),
      };
    }

    return out;
  }

  // ── Volledige sync ────────────────────────────────────────
  async syncAdvertisingData(
    tenantId:      string,
    integrationId: string,
    clientId:      string,
    clientSecret:  string
  ): Promise<BolAdPerformance[]> {
    const token = await this.getToken(clientId, clientSecret);

    const campaigns = await this.fetchCampaigns(token);
    if (campaigns.length === 0) {
      logger.info('bolcom.adv.sync.no_campaigns', { tenantId });
      return [];
    }

    const endDate   = new Date().toISOString().split('T')[0];
    const startDate = new Date(Date.now() - 30 * 86400000).toISOString().split('T')[0];
    const performance = await this.fetchPerformance(token, campaigns.map(c => c.campaignId), startDate, endDate);

    const result: BolAdPerformance[] = campaigns.map(c => {
      const p    = performance[c.campaignId] || { spend: 0, impressions: 0, clicks: 0, conversions: 0, revenue: 0 };
      const roas = p.spend > 0 ? Math.round((p.revenue / p.spend) * 100) / 100 : null;
      const ctr  = p.impressions > 0 ? Math.round((p.clicks / p.impressions) * 10000) / 100 : null;
      const cpc  = p.clicks > 0 ? Math.round((p.spend / p.clicks) * 100) / 100 : null;
      const acos = p.revenue > 0 ? Math.round((p.spend / p.revenue) * 10000) / 100 : null;

      return {
        campaignId:   c.campaignId,
        campaignName: c.name,
        status:       (c.state || 'unknown').toLowerCase(),
        spend: p.spend, impressions: p.impressions, clicks: p.clicks,
        conversions: p.conversions, revenue: p.revenue,
        roas, ctr, cpc, acos,
      };
    });

    for (const camp of result) {
      await db.query(
        `INSERT INTO ad_campaigns
           (id, tenant_id, integration_id, platform, name, status,
            spend, impressions, clicks, conversions, revenue, roas, updated_at)
         VALUES (gen_random_uuid(), $1, $2, 'bolcom', $3, $4, $5, $6, $7, $8, $9, $10, now())
         ON CONFLICT (tenant_id, platform, name)
         DO UPDATE SET
           status = EXCLUDED.status, spend = EXCLUDED.spend,
           impressions = EXCLUDED.impressions, clicks = EXCLUDED.clicks,
           conversions = EXCLUDED.conversions, revenue = EXCLUDED.revenue,
           roas = EXCLUDED.roas, updated_at = now()`,
        [tenantId, integrationId, camp.campaignName, camp.status,
         camp.spend, camp.impressions, camp.clicks, camp.conversions, camp.revenue, camp.roas],
        { allowNoTenant: true }
      );
    }

    logger.info('bolcom.adv.sync.complete', {
      tenantId, campaigns: result.length,
      totalSpend: result.reduce((s, c) => s + c.spend, 0),
    });

    return result;
  }
}

export const bolcomAdvertisingConnector = new BolcomAdvertisingConnector();
