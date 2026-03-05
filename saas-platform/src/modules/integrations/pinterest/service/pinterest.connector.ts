// ============================================================
// src/modules/integrations/pinterest/service/pinterest.connector.ts
//
// Pinterest API v5
// Primair advertentieplatform — geen directe sales
// Ondersteunt: ad campaigns, pin analytics, audience insights
// ============================================================

import axios, { AxiosInstance } from 'axios';
import {
  PlatformConnector,
  NormalizedOrder,
  NormalizedProduct,
  NormalizedAdCampaign,
} from '../../base/platform-connector';
import { logger } from '../../../../shared/logging/logger';

export class PinterestConnector extends PlatformConnector {
  readonly platform = 'pinterest';
  private client: AxiosInstance;

  constructor(
    private readonly adAccountId: string,
    private readonly accessToken: string
  ) {
    super();
    this.client = axios.create({
      baseURL: 'https://api.pinterest.com/v5',
      headers: {
        Authorization:  `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      timeout: 30_000,
    });
  }

  async testConnection(): Promise<{ ok: boolean; shopName?: string; error?: string }> {
    try {
      const res = await this.client.get('/user_account');
      return { ok: true, shopName: `Pinterest: ${res.data.username}` };
    } catch (err: any) {
      return { ok: false, error: err.message };
    }
  }

  // Pinterest heeft geen directe orders — stubs voor interface compliance
  async fetchOrders(): Promise<{ orders: NormalizedOrder[] }> {
    return { orders: [] };
  }

  async fetchProducts(): Promise<NormalizedProduct[]> {
    return [];
  }

  // ── Ad Campaigns ──────────────────────────────────────────
  async fetchAdCampaigns(opts: { since?: Date; until?: Date }): Promise<NormalizedAdCampaign[]> {
    const allCampaigns: NormalizedAdCampaign[] = [];

    // Haal campaigns op
    const campaignsRes = await this.client.get(
      `/ad_accounts/${this.adAccountId}/campaigns`,
      { params: { page_size: 100 } }
    );

    const campaigns = campaignsRes.data?.items ?? [];

    for (const campaign of campaigns) {
      // Haal analytics op per campaign
      try {
        const analyticsRes = await this.client.post(
          `/ad_accounts/${this.adAccountId}/campaigns/analytics`,
          {
            start_date:   this.formatDate(opts.since ?? new Date(Date.now() - 30 * 86400000)),
            end_date:     this.formatDate(opts.until ?? new Date()),
            campaign_ids: [campaign.id],
            columns:      ['SPEND_IN_MICRO_DOLLAR', 'IMPRESSION_1', 'CLICK_1', 'TOTAL_CONVERSIONS', 'TOTAL_ENGAGEMENT_CHECKOUT_VALUE_IN_MICRO_DOLLAR'],
            granularity:  'TOTAL',
          }
        );

        const analytics = analyticsRes.data?.[0]?.daily_metrics?.[0] ?? {};

        allCampaigns.push({
          externalId:  campaign.id,
          name:        campaign.name,
          status:      campaign.status,
          budget:      (campaign.daily_spend_cap ?? 0) / 1_000_000,
          spend:       (analytics.SPEND_IN_MICRO_DOLLAR ?? 0) / 1_000_000,
          impressions: analytics.IMPRESSION_1 ?? 0,
          clicks:      analytics.CLICK_1 ?? 0,
          conversions: analytics.TOTAL_CONVERSIONS ?? 0,
          revenue:     (analytics.TOTAL_ENGAGEMENT_CHECKOUT_VALUE_IN_MICRO_DOLLAR ?? 0) / 1_000_000,
          roas:        analytics.SPEND_IN_MICRO_DOLLAR > 0
            ? (analytics.TOTAL_ENGAGEMENT_CHECKOUT_VALUE_IN_MICRO_DOLLAR / analytics.SPEND_IN_MICRO_DOLLAR)
            : undefined,
          periodStart: opts.since,
          periodEnd:   opts.until,
          rawData:     { campaign, analytics },
        });
      } catch (err: any) {
        logger.warn('pinterest.campaign.analytics.failed', {
          campaignId: campaign.id,
          error: err.message,
        });
      }

      await new Promise(r => setTimeout(r, 200));
    }

    logger.info('pinterest.campaigns.fetched', { count: allCampaigns.length });
    return allCampaigns;
  }

  private formatDate(date: Date): string {
    return date.toISOString().split('T')[0];
  }
}
