// ============================================================
// saas-platform/src/modules/integrations/connectors/bolcom-advertising.connector.ts
//
// Bol.com Advertising API v11
//
// Auth:     Zelfde token endpoint als Retailer API
//           https://login.bol.com/token?grant_type=client_credentials
//           Maar MET aparte Advertising credentials (Client ID + Secret)
//
// Base URL: https://api.bol.com/advertiser/sponsored-products/v11
//
// Belangrijk verschil v11 vs v9/v10:
//   - Alle "GET" lijsten zijn PUT filter endpoints geworden
//   - Accept/Content-Type: application/vnd.advertiser.v11+json
//     (NIET vnd.retailer!)
//
// Endpoints:
//   PUT  /campaigns                           → lijst campagnes ophalen
//   PUT  /reporting/performance/campaigns     → performance data
// ============================================================

import { cache }  from '../../../infrastructure/cache/redis';
import { db }     from '../../../infrastructure/database/connection';
import { logger } from '../../../shared/logging/logger';

const ADV_BASE         = 'https://api.bol.com/advertiser/sponsored-products/v11';
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

  // ── Token ophalen (gecached) ───────────────────────────────
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
      throw new Error(`Token ophalen mislukt (${res.status}): ${body.slice(0, 200)}`);
    }

    const data = await res.json() as { access_token: string; expires_in?: number };
    const ttl  = Math.max((data.expires_in || 299) - 60, 30);

    try { await cache.set(cacheKey, data.access_token, ttl); } catch {}

    return data.access_token;
  }

  // ── Helperfunctie voor advertiser API calls ────────────────
  // v11 gebruikt PUT voor alle filter/list endpoints
  private async advFetch(
    token: string,
    path:  string,
    body:  object
  ): Promise<{ ok: boolean; status: number; data: any }> {
    const res = await fetch(`${ADV_BASE}${path}`, {
      method:  'PUT',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Accept':        ADV_CONTENT_TYPE,
        'Content-Type':  ADV_CONTENT_TYPE,
      },
      body: JSON.stringify(body),
    });

    const text = await res.text().catch(() => '');
    let data: any = {};
    try { data = JSON.parse(text); } catch {}

    return { ok: res.ok, status: res.status, data };
  }

  // ── Verbinding testen ─────────────────────────────────────
  async testConnection(
    clientId:     string,
    clientSecret: string
  ): Promise<{ success: boolean; error?: string }> {
    // Stap 1: Token ophalen
    let token: string;
    try {
      token = await this.getToken(clientId, clientSecret);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('401') || msg.includes('400')) {
        return {
          success: false,
          error:   'Ongeldige Client ID of Client Secret. Controleer je Advertising credentials in het Bol.com retailer dashboard.',
        };
      }
      return { success: false, error: `Auth mislukt: ${msg}` };
    }

    // Stap 2: Test campagnes endpoint — PUT met pageSize=1
    const result = await this.advFetch(token, '/campaigns', { page: 1, pageSize: 1 });

    if (result.status === 401) {
      return { success: false, error: 'Token ongeldig. Controleer je Advertising API credentials.' };
    }
    if (result.status === 403) {
      return {
        success: false,
        error:   'Geen toegang tot de Advertising API. Controleer of je Advertising API credentials aangemaakt hebt via retailer.bol.com → Instellingen → API-toegang → Advertising.',
      };
    }
    if (!result.ok && result.status !== 404) {
      return {
        success: false,
        error:   `API fout ${result.status}: ${JSON.stringify(result.data).slice(0, 200)}`,
      };
    }

    return { success: true };
  }

  // ── Campagnes ophalen ─────────────────────────────────────
  // v11: PUT /campaigns (geen GET!)
  async fetchCampaigns(token: string): Promise<BolAdCampaign[]> {
    const allCampaigns: BolAdCampaign[] = [];
    let page = 1;

    while (true) {
      const result = await this.advFetch(token, '/campaigns', { page, pageSize: 50 });

      if (!result.ok) {
        throw new Error(
          `Campagnes ophalen mislukt (${result.status}): ${JSON.stringify(result.data).slice(0, 200)}`
        );
      }

      const campaigns: BolAdCampaign[] = result.data.campaigns || [];
      allCampaigns.push(...campaigns);

      if (campaigns.length < 50) break;
      page++;
      if (page > 20) break; // veiligheidsgrens: max 1000 campagnes
    }

    return allCampaigns;
  }

  // ── Performance data ophalen ──────────────────────────────
  // v11: PUT /reporting/performance/campaigns
  async fetchPerformance(
    token:       string,
    campaignIds: string[],
    startDate:   string,
    endDate:     string
  ): Promise<Record<string, {
    spend: number; impressions: number; clicks: number;
    conversions: number; revenue: number;
  }>> {
    if (campaignIds.length === 0) return {};

    const result = await this.advFetch(token, '/reporting/performance/campaigns', {
      campaignIds,
      startDate,
      endDate,
    });

    if (!result.ok) {
      logger.warn('bolcom.adv.performance.failed', {
        status: result.status,
        body:   JSON.stringify(result.data).slice(0, 200),
      });
      return {};
    }

    const out: Record<string, {
      spend: number; impressions: number; clicks: number;
      conversions: number; revenue: number;
    }> = {};

    // v11 response: campaignReports array
    const reports = result.data.campaignReports || result.data.reports || [];
    for (const r of reports) {
      out[r.campaignId] = {
        spend:       parseFloat(r.spend        || r.cost    || 0),
        impressions: parseInt(r.impressions                || 0),
        clicks:      parseInt(r.clicks                     || 0),
        conversions: parseFloat(r.conversions14d || r.conversions || 0),
        revenue:     parseFloat(r.sales14d      || r.revenue || 0),
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

    const performance = await this.fetchPerformance(
      token,
      campaigns.map(c => c.campaignId),
      startDate,
      endDate
    );

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
        spend:        p.spend,
        impressions:  p.impressions,
        clicks:       p.clicks,
        conversions:  p.conversions,
        revenue:      p.revenue,
        roas, ctr, cpc, acos,
      };
    });

    // Opslaan in ad_campaigns tabel
    for (const camp of result) {
      await db.query(
        `INSERT INTO ad_campaigns
           (id, tenant_id, integration_id, platform, name, status,
            spend, impressions, clicks, conversions, revenue, roas, updated_at)
         VALUES (gen_random_uuid(), $1, $2, 'bolcom', $3, $4, $5, $6, $7, $8, $9, $10, now())
         ON CONFLICT (tenant_id, platform, name)
         DO UPDATE SET
           status      = EXCLUDED.status,
           spend       = EXCLUDED.spend,
           impressions = EXCLUDED.impressions,
           clicks      = EXCLUDED.clicks,
           conversions = EXCLUDED.conversions,
           revenue     = EXCLUDED.revenue,
           roas        = EXCLUDED.roas,
           updated_at  = now()`,
        [
          tenantId, integrationId,
          camp.campaignName, camp.status,
          camp.spend, camp.impressions, camp.clicks,
          camp.conversions, camp.revenue, camp.roas,
        ],
        { allowNoTenant: true }
      );
    }

    logger.info('bolcom.adv.sync.complete', {
      tenantId,
      campaigns:  result.length,
      totalSpend: result.reduce((s, c) => s + c.spend, 0),
    });

    return result;
  }
}

export const bolcomAdvertisingConnector = new BolcomAdvertisingConnector();
