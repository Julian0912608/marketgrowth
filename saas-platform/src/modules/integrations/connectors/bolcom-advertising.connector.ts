// saas-platform/src/modules/integrations/connectors/bolcom-advertising.connector.ts
//
// FIX 1: Correct endpoint /retailer/advertiser/campaigns (niet /sponsored)
// FIX 2: connection_id = integrationId altijd meegeven bij INSERT ad_campaigns
// FIX 3: 404 op advertiser endpoint = graceful skip (niet alle accounts hebben ads)

import { db }    from '../../../infrastructure/database/connection';
import { logger } from '../../../shared/logging/logger';
import { IntegrationCredentials } from '../types/integration.types';

interface BolCampaign {
  campaignId:   string | number;
  campaignName: string;
  status:       string;
  budget?:      number;
  spend?:       number;
  impressions?: number;
  clicks?:      number;
  conversions?: number;
  revenue?:     number;
}

export async function syncBolcomAdvertisingData(
  creds: IntegrationCredentials,
  tenantId: string,
  token: string,
): Promise<void> {
  const integrationId = creds.integrationId; // ← DIT was het probleem: werd niet gebruikt

  // ── Stap 1: Haal campagnes op ─────────────────────────────
  let campaigns: BolCampaign[] = [];

  try {
    const res = await fetch('https://api.bol.com/retailer/advertiser/campaigns', {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Accept':        'application/vnd.retailer.v10+json',
      },
    });

    // Niet alle accounts hebben advertising toegang — graceful skip
    if (res.status === 404 || res.status === 403) {
      logger.warn('bolcom.adv.not_available', {
        tenantId,
        integrationId,
        status: res.status,
        message: 'Account heeft geen Bol.com adverteerder toegang — advertising sync overgeslagen',
      });
      return; // ← Stop hier, geen crash
    }

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      logger.warn('bolcom.adv.performance.failed', {
        tenantId, integrationId, status: res.status, body: body.slice(0, 300),
      });
      return;
    }

    const data = await res.json() as { campaigns?: BolCampaign[] };
    campaigns  = data.campaigns ?? [];

  } catch (err) {
    logger.warn('bolcom.adv.fetch.error', {
      tenantId, integrationId,
      error: err instanceof Error ? err.message : String(err),
    });
    return;
  }

  if (campaigns.length === 0) return;

  // ── Stap 2: Haal performance data op per campagne ─────────
  for (const campaign of campaigns) {
    try {
      const perfRes = await fetch(
        `https://api.bol.com/retailer/advertiser/campaigns/${campaign.campaignId}/performance`,
        {
          headers: {
            'Authorization': `Bearer ${token}`,
            'Accept':        'application/vnd.retailer.v10+json',
          },
        }
      );

      let spend       = 0;
      let impressions = 0;
      let clicks      = 0;
      let conversions = 0;
      let revenue     = 0;

      if (perfRes.ok) {
        const perf = await perfRes.json() as Record<string, number>;
        spend       = perf.cost          ?? perf.spend        ?? 0;
        impressions = perf.impressions   ?? 0;
        clicks      = perf.clicks        ?? 0;
        conversions = perf.conversions   ?? perf.orders       ?? 0;
        revenue     = perf.revenue       ?? perf.sales        ?? 0;
      }

      const roas = spend > 0 ? Math.round((revenue / spend) * 100) / 100 : null;

      // ── FIX: connection_id = integrationId altijd meegeven ─
      await db.query(
        `INSERT INTO ad_campaigns (
           id, tenant_id, connection_id, integration_id,
           platform, external_id, name, status,
           spend, impressions, clicks, conversions, revenue, roas,
           synced_at, updated_at
         ) VALUES (
           gen_random_uuid(), $1, $2, $2,
           'bolcom', $3, $4, $5,
           $6, $7, $8, $9, $10, $11,
           now(), now()
         )
         ON CONFLICT (tenant_id, integration_id, external_id)
         DO UPDATE SET
           name        = EXCLUDED.name,
           status      = EXCLUDED.status,
           spend       = EXCLUDED.spend,
           impressions = EXCLUDED.impressions,
           clicks      = EXCLUDED.clicks,
           conversions = EXCLUDED.conversions,
           revenue     = EXCLUDED.revenue,
           roas        = EXCLUDED.roas,
           synced_at   = now(),
           updated_at  = now()`,
        [
          tenantId,
          integrationId,           // $2 = connection_id én integration_id
          String(campaign.campaignId),
          campaign.campaignName ?? `Campaign ${campaign.campaignId}`,
          campaign.status ?? 'UNKNOWN',
          spend,
          impressions,
          clicks,
          conversions,
          revenue,
          roas,
        ],
        { allowNoTenant: true }
      );

    } catch (err) {
      // Één campagne die faalt stopt de rest NIET
      logger.warn('bolcom.adv.campaign.upsert.failed', {
        tenantId,
        integrationId,
        campaignId: campaign.campaignId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  logger.info('bolcom.adv.sync.complete', {
    tenantId, integrationId, count: campaigns.length,
  });
}
