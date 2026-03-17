// ============================================================
// saas-platform/src/modules/integrations/connectors/bolcom-advertising.connector.ts
//
// Bol.com Advertising API v11
// Auth: zelfde Client Credentials flow als Retailer API
//       maar met APARTE advertising credentials
// Base URL: https://api.bol.com/advertiser/sponsored-products/v11
// ============================================================

import { cache } from '../../../infrastructure/cache/redis';
import { db }    from '../../../infrastructure/database/connection';
import { logger } from '../../../shared/logging/logger';

export interface BolAdCampaign {
  campaignId:   string;
  name:         string;
  status:       string;
  dailyBudget?: number;
  startDate?:   string;
}

export interface BolAdPerformance {
  campaignId:    string;
  campaignName:  string;
  status:        string;
  spend:         number;
  impressions:   number;
  clicks:        number;
  conversions:   number;
  revenue:       number;
  roas:          number | null;
  ctr:           number | null;
  cpc:           number | null;
  acos:          number | null;
}

const ADV_BASE = 'https://api.bol.com/advertiser/sponsored-products/v11';
const TOKEN_CACHE_PREFIX = 'bolcom:adv:token:';

export class BolcomAdvertisingConnector {

  // ── Token ophalen (gecached 240 sec) ─────────────────────
  async getToken(clientId: string, clientSecret: string, cacheKey: string): Promise<string> {
    const memKey = TOKEN_CACHE_PREFIX + cacheKey;

    try {
      const cached = await cache.get(memKey);
      if (cached) return cached;
    } catch {}

    const encoded = Buffer.from(clientId + ':' + clientSecret).toString('base64');
    const res = await fetch('https://login.bol.com/token?grant_type=client_credentials', {
      method:  'POST',
      headers: {
        'Authorization': 'Basic ' + encoded,
        'Accept':        'application/json',
        'Content-Type':  'application/x-www-form-urlencoded',
      },
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error('Bol.com Advertising auth mislukt (' + res.status + '): ' + body.slice(0, 200));
    }

    const d = await res.json() as { access_token: string; expires_in?: number };
    const ttl = Math.max(((d.expires_in || 299) - 60), 30);

    try {
      await cache.set(memKey, d.access_token, ttl);
    } catch {}

    return d.access_token;
  }

  // ── Verbinding testen ─────────────────────────────────────
  async testConnection(clientId: string, clientSecret: string): Promise<{ success: boolean; error?: string }> {
    try {
      const token = await this.getToken(clientId, clientSecret, clientId);
      const res = await fetch(ADV_BASE + '/campaigns', {
        method:  'POST',
        headers: {
          'Authorization': 'Bearer ' + token,
          'Accept':        'application/vnd.retailer.v11+json',
          'Content-Type':  'application/vnd.retailer.v11+json',
        },
        body: JSON.stringify({ page: 1, pageSize: 1 }),
      });
      if (!res.ok && res.status !== 404) {
        throw new Error('API fout ' + res.status);
      }
      return { success: true };
    } catch (err: unknown) {
      return { success: false, error: err instanceof Error ? err.message : 'Verbinding mislukt' };
    }
  }

  // ── Campagnes ophalen ─────────────────────────────────────
  async fetchCampaigns(token: string): Promise<BolAdCampaign[]> {
    const res = await fetch(ADV_BASE + '/campaigns', {
      method:  'POST',
      headers: {
        'Authorization': 'Bearer ' + token,
        'Accept':        'application/vnd.retailer.v11+json',
        'Content-Type':  'application/vnd.retailer.v11+json',
      },
      body: JSON.stringify({ page: 1, pageSize: 100 }),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error('Campaigns ophalen mislukt (' + res.status + '): ' + body.slice(0, 200));
    }

    const data = await res.json() as { campaigns?: BolAdCampaign[] };
    return data.campaigns || [];
  }

  // ── Performance data ophalen ──────────────────────────────
  async fetchPerformance(
    token: string,
    campaignIds: string[],
    startDate: string,
    endDate: string
  ): Promise<Record<string, { spend: number; impressions: number; clicks: number; conversions: number; revenue: number }>> {
    if (campaignIds.length === 0) return {};

    const res = await fetch(ADV_BASE + '/reporting/performance/campaigns', {
      method:  'POST',
      headers: {
        'Authorization': 'Bearer ' + token,
        'Accept':        'application/vnd.retailer.v11+json',
        'Content-Type':  'application/vnd.retailer.v11+json',
      },
      body: JSON.stringify({
        campaignIds,
        startDate,
        endDate,
        groupBy: ['CAMPAIGN'],
      }),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      logger.warn('bolcom.adv.performance.failed', { status: res.status, body: body.slice(0, 200) });
      return {};
    }

    const data = await res.json() as { reports?: Array<{
      campaignId: string;
      spend?: number;
      impressions?: number;
      clicks?: number;
      conversions14d?: number;
      sales14d?: number;
    }> };

    const result: Record<string, { spend: number; impressions: number; clicks: number; conversions: number; revenue: number }> = {};

    for (const r of (data.reports || [])) {
      result[r.campaignId] = {
        spend:       parseFloat(String(r.spend || 0)),
        impressions: parseInt(String(r.impressions || 0)),
        clicks:      parseInt(String(r.clicks || 0)),
        conversions: parseFloat(String(r.conversions14d || 0)),
        revenue:     parseFloat(String(r.sales14d || 0)),
      };
    }

    return result;
  }

  // ── Volledige sync: campagnes + performance ────────────────
  async syncAdvertisingData(
    tenantId: string,
    integrationId: string,
    clientId: string,
    clientSecret: string
  ): Promise<BolAdPerformance[]> {
    const token = await this.getToken(clientId, clientSecret, integrationId);

    // Campagnes ophalen
    const campaigns = await this.fetchCampaigns(token);
    if (campaigns.length === 0) return [];

    // Performance data voor afgelopen 30 dagen
    const endDate   = new Date().toISOString().split('T')[0];
    const startDate = new Date(Date.now() - 30 * 86400000).toISOString().split('T')[0];

    const campaignIds = campaigns.map(c => c.campaignId);
    const performance = await this.fetchPerformance(token, campaignIds, startDate, endDate);

    // Combineer campagnes met performance data
    const result: BolAdPerformance[] = campaigns.map(c => {
      const p = performance[c.campaignId] || { spend: 0, impressions: 0, clicks: 0, conversions: 0, revenue: 0 };
      const roas  = p.spend > 0 ? Math.round((p.revenue / p.spend) * 100) / 100 : null;
      const ctr   = p.impressions > 0 ? Math.round((p.clicks / p.impressions) * 10000) / 100 : null;
      const cpc   = p.clicks > 0 ? Math.round((p.spend / p.clicks) * 100) / 100 : null;
      const acos  = p.revenue > 0 ? Math.round((p.spend / p.revenue) * 10000) / 100 : null;

      return {
        campaignId:   c.campaignId,
        campaignName: c.name,
        status:       c.status?.toLowerCase() || 'unknown',
        spend:        p.spend,
        impressions:  p.impressions,
        clicks:       p.clicks,
        conversions:  p.conversions,
        revenue:      p.revenue,
        roas,
        ctr,
        cpc,
        acos,
      };
    });

    // Sla op in ad_campaigns tabel
    for (const camp of result) {
      await db.query(
        `INSERT INTO ad_campaigns
           (id, tenant_id, integration_id, platform, name, status,
            spend, impressions, clicks, conversions, revenue, roas, updated_at)
         VALUES (gen_random_uuid(), $1, $2, 'bolcom', $3, $4, $5, $6, $7, $8, $9, $10, now())
         ON CONFLICT (tenant_id, platform, name)
         DO UPDATE SET
           status = EXCLUDED.status,
           spend = EXCLUDED.spend,
           impressions = EXCLUDED.impressions,
           clicks = EXCLUDED.clicks,
           conversions = EXCLUDED.conversions,
           revenue = EXCLUDED.revenue,
           roas = EXCLUDED.roas,
           updated_at = now()`,
        [
          tenantId,
          integrationId,
          camp.campaignName,
          camp.status,
          camp.spend,
          camp.impressions,
          camp.clicks,
          camp.conversions,
          camp.revenue,
          camp.roas,
        ],
        { allowNoTenant: true }
      );
    }

    logger.info('bolcom.adv.sync.complete', {
      tenantId,
      campaigns: result.length,
      totalSpend: result.reduce((s, c) => s + c.spend, 0),
    });

    return result;
  }
}

export const bolcomAdvertisingConnector = new BolcomAdvertisingConnector();
