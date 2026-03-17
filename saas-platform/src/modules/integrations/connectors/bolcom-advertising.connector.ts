// saas-platform/src/modules/integrations/connectors/bolcom-advertising.connector.ts
//
// Conform Bol.com Sponsored Products Campaign Management API v11.0.0
// Base URL: https://api.bol.com/advertiser/sponsored-products/campaign-management
// Auth: JWT (apart adverteerder token — niet het retailer token)
// Campagnes ophalen: POST /campaigns/list
// Performance data: NIET beschikbaar in deze API — apart reporting API nodig

import { db }     from '../../../infrastructure/database/connection';
import { logger } from '../../../shared/logging/logger';
import { IntegrationCredentials } from '../types/integration.types';

const ADV_BASE = 'https://api.bol.com/advertiser/sponsored-products/campaign-management';

interface BolCampaign {
  campaignId:    string;
  name:          string;
  state:         'ENABLED' | 'PAUSED' | string;
  startDate?:    string;
  endDate?:      string;
  dailyBudget?:  { amount: number; currency: string };
  totalBudget?:  { amount: number; currency: string };
  campaignType?: string;
}

interface CampaignListResponse {
  campaigns: BolCampaign[];
}

export interface SyncResult {
  hasAccess:     boolean;
  campaignCount: number;
}

// ── Haal adverteerder JWT token op ───────────────────────────
// Dit is een APART token van het retailer token.
// De api_key/api_secret van bolcom_ads zijn de adverteerder client credentials.
async function getAdvertiserToken(apiKey: string, apiSecret: string): Promise<string> {
  const encoded = Buffer.from(`${apiKey}:${apiSecret}`).toString('base64');
  const res = await fetch('https://login.bol.com/token?grant_type=client_credentials', {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${encoded}`,
      'Content-Type':  'application/x-www-form-urlencoded',
    },
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Adverteerder token ophalen mislukt (${res.status}): ${body.slice(0, 200)}`);
  }

  const data = await res.json() as { access_token: string };
  return data.access_token;
}

// ── Campagnes ophalen via POST /campaigns/list ────────────────
async function fetchCampaigns(token: string): Promise<BolCampaign[]> {
  const res = await fetch(`${ADV_BASE}/campaigns/list`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type':  'application/json',
      'Accept':        'application/json',
    },
    // Lege body = alle campagnes ophalen (geen filter op campaignIds)
    body: JSON.stringify({}),
  });

  if (res.status === 403 || res.status === 401) {
    throw Object.assign(
      new Error(`Geen adverteerder toegang (${res.status})`),
      { noAccess: true }
    );
  }

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Campagnes ophalen mislukt (${res.status}): ${body.slice(0, 300)}`);
  }

  const data = await res.json() as CampaignListResponse;
  return data.campaigns ?? [];
}

// ── Hoofdfunctie ──────────────────────────────────────────────
export async function syncBolcomAdvertisingData(
  creds: IntegrationCredentials,
  tenantId: string,
  token: string,  // dit is al het token dat de route heeft opgehaald
): Promise<SyncResult> {
  const integrationId = creds.integrationId;

  // ── Campagnes ophalen ─────────────────────────────────────
  let campaigns: BolCampaign[] = [];

  try {
    campaigns = await fetchCampaigns(token);
  } catch (err: any) {
    if (err.noAccess) {
      logger.warn('bolcom.adv.not_available', {
        tenantId, integrationId,
        message: 'Account heeft geen Bol.com adverteerder toegang',
      });
      return { hasAccess: false, campaignCount: 0 };
    }
    logger.warn('bolcom.adv.fetch.error', {
      tenantId, integrationId,
      error: err instanceof Error ? err.message : String(err),
    });
    return { hasAccess: false, campaignCount: 0 };
  }

  if (campaigns.length === 0) {
    return { hasAccess: true, campaignCount: 0 };
  }

  // ── Campagnes opslaan in DB ───────────────────────────────
  // NB: spend/impressions/clicks/revenue zijn NIET beschikbaar
  // in de Campaign Management API. Deze API bevat alleen campagne
  // configuratie. Voor performance data is een aparte Reporting API nodig.
  // We slaan daarom 0 op voor metrics — dit is correct gedrag.
  let saved = 0;

  for (const campaign of campaigns) {
    try {
      const dailyBudget = campaign.dailyBudget?.amount ?? 0;
      const status      = campaign.state === 'ENABLED' ? 'active' : 'paused';

      await db.query(
        `INSERT INTO ad_campaigns (
           id, tenant_id, connection_id, integration_id,
           platform, external_id, name, status,
           spend, impressions, clicks, conversions, revenue, roas,
           synced_at, updated_at
         ) VALUES (
           gen_random_uuid(), $1, $2, $2,
           'bolcom', $3, $4, $5,
           0, 0, 0, 0, 0, NULL,
           now(), now()
         )
         ON CONFLICT (tenant_id, integration_id, external_id)
         DO UPDATE SET
           name      = EXCLUDED.name,
           status    = EXCLUDED.status,
           synced_at = now(),
           updated_at = now()`,
        [
          tenantId,
          integrationId,
          campaign.campaignId,
          campaign.name ?? `Campaign ${campaign.campaignId}`,
          status,
        ],
        { allowNoTenant: true }
      );

      saved++;

    } catch (err) {
      logger.warn('bolcom.adv.campaign.upsert.failed', {
        tenantId, integrationId, campaignId: campaign.campaignId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  logger.info('bolcom.adv.sync.complete', { tenantId, integrationId, saved, total: campaigns.length });
  return { hasAccess: true, campaignCount: saved };
}
