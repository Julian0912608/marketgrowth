// saas-platform/src/modules/integrations/connectors/bolcom-advertising.connector.ts
//
// Conform:
//   - Bol.com Sponsored Products Campaign Management API v11.0.0
//   - Bol.com Sponsored Products Reporting API v11.0.0
//
// Campaign Management base: https://api.bol.com/advertiser/sponsored-products/campaign-management
// Reporting base:            https://api.bol.com/advertiser/sponsored-products/reporting
// Auth: JWT (Bearer token via client_credentials — apart van retailer token)

import { db }     from '../../../infrastructure/database/connection';
import { logger } from '../../../shared/logging/logger';
import { IntegrationCredentials } from '../types/integration.types';

const MGMT_BASE   = 'https://api.bol.com/advertiser/sponsored-products/campaign-management';
const REPORT_BASE = 'https://api.bol.com/advertiser/sponsored-products/reporting';
const ADV_ACCEPT  = 'application/vnd.advertiser.v11+json';
const BATCH_SIZE  = 100; // max entity-ids per reporting request conform spec

// ── Types conform OpenAPI spec ────────────────────────────────

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

interface PerformanceMetrics {
  impressions:         number;
  clicks:              number;
  ctr?:                number;
  conversions14d:      number;
  directConversions14d?:   number;
  indirectConversions14d?: number;
  conversionRate14d?:  number;
  averageCpc?:         number;
  sales14d:            number;  // = revenue
  cost:                number;  // = spend
  acos14d?:            number;
  roas14d?:            number;
}

interface PerformanceMetricsWithIds extends PerformanceMetrics {
  entityType:  string;
  entityId:    string;
  campaignId:  string;
  adGroupId?:  string;
}

interface PerformanceResponse {
  total?:     PerformanceMetrics;
  subTotals?: PerformanceMetricsWithIds[];
}

export interface SyncResult {
  hasAccess:     boolean;
  campaignCount: number;
}

// ── Helper: datum formatteren als YYYY-MM-DD ──────────────────
function formatDate(date: Date): string {
  return date.toISOString().split('T')[0];
}

// ── Stap 1: Campagnes ophalen via Campaign Management API ─────
// Conform spec: POST /campaigns/list
// Lege body = geen filter = alle campagnes teruggeven
async function fetchCampaigns(token: string): Promise<BolCampaign[]> {
  const res = await fetch(`${MGMT_BASE}/campaigns/list`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type':  ADV_ACCEPT,
      'Accept':        ADV_ACCEPT,
    },
    body: JSON.stringify({}),
  });

  if (res.status === 401 || res.status === 403) {
    const err: any = new Error(`Geen adverteerder toegang (${res.status})`);
    err.noAccess = true;
    throw err;
  }

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Campagnes ophalen mislukt (${res.status}): ${body.slice(0, 300)}`);
  }

  const data = await res.json() as { campaigns?: BolCampaign[] };
  return data.campaigns ?? [];
}

// ── Stap 2: Performance data ophalen via Reporting API ────────
// Conform spec: GET /performance
//   ?entity-type=CAMPAIGN
//   &entity-ids=...  (max 100, herhaalde query param)
//   &period-start-date=YYYY-MM-DD
//   &period-end-date=YYYY-MM-DD
// Datum mag max 30 dagen geleden zijn conform spec
async function fetchPerformance(
  token: string,
  campaignIds: string[],
  startDate: string,
  endDate: string,
): Promise<Map<string, PerformanceMetrics>> {
  const perfMap = new Map<string, PerformanceMetrics>();

  // Verwerk in batches van max 100 conform spec maxItems: 100
  for (let i = 0; i < campaignIds.length; i += BATCH_SIZE) {
    const batch = campaignIds.slice(i, i + BATCH_SIZE);

    const params = new URLSearchParams({
      'entity-type':       'CAMPAIGN',
      'period-start-date': startDate,
      'period-end-date':   endDate,
    });

    // entity-ids als herhaalde query param (array) conform spec
    batch.forEach(id => params.append('entity-ids', id));

    const res = await fetch(`${REPORT_BASE}/performance?${params}`, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Accept':        ADV_ACCEPT,
      },
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      logger.warn('bolcom.adv.reporting.failed', {
        status: res.status,
        body:   body.slice(0, 300),
      });
      continue; // batch overslaan, niet crashen
    }

    const data = await res.json() as PerformanceResponse;

    // subTotals bevat performance per entity — filter op CAMPAIGN
    for (const sub of data.subTotals ?? []) {
      if (sub.entityType === 'CAMPAIGN' && sub.campaignId) {
        perfMap.set(sub.campaignId, sub);
      }
    }
  }

  return perfMap;
}

// ── Hoofdfunctie ──────────────────────────────────────────────
export async function syncBolcomAdvertisingData(
  creds: IntegrationCredentials,
  tenantId: string,
  token: string,
): Promise<SyncResult> {
  const integrationId = creds.integrationId;

  // ── Stap 1: Campagnes ophalen ─────────────────────────────
  let campaigns: BolCampaign[] = [];

  try {
    campaigns = await fetchCampaigns(token);
  } catch (err: any) {
    if (err.noAccess) {
      logger.warn('bolcom.adv.not_available', {
        tenantId,
        integrationId,
        message: 'Account heeft geen Bol.com adverteerder toegang',
      });
      return { hasAccess: false, campaignCount: 0 };
    }
    logger.warn('bolcom.adv.fetch.error', {
      tenantId,
      integrationId,
      error: err instanceof Error ? err.message : String(err),
    });
    return { hasAccess: false, campaignCount: 0 };
  }

  if (campaigns.length === 0) {
    return { hasAccess: true, campaignCount: 0 };
  }

  // ── Stap 2: Performance ophalen (laatste 30 dagen) ────────
  // Spec: period mag max 30 dagen geleden zijn
  const endDate   = formatDate(new Date());
  const startDate = formatDate(new Date(Date.now() - 29 * 24 * 60 * 60 * 1000));

  const campaignIds = campaigns.map(c => c.campaignId);
  const perfMap     = await fetchPerformance(token, campaignIds, startDate, endDate);

  // ── Stap 3: Campagnes + performance opslaan in DB ─────────
  let saved = 0;

  for (const campaign of campaigns) {
    try {
      const perf   = perfMap.get(campaign.campaignId);
      const status = campaign.state === 'ENABLED' ? 'active' : 'paused';

      // Conform spec veldnamen:
      // cost        = spend (wat je betaalt)
      // sales14d    = revenue (omzet via ads, 14d attributievenster)
      // roas14d     = ROAS (return on ad spend, 14d)
      // conversions14d = conversies (14d attributievenster)
      const spend       = perf?.cost           ?? 0;
      const revenue     = perf?.sales14d       ?? 0;
      const impressions = perf?.impressions    ?? 0;
      const clicks      = perf?.clicks         ?? 0;
      const conversions = perf?.conversions14d ?? 0;
      const roas        = perf?.roas14d != null
        ? perf.roas14d
        : (spend > 0 ? Math.round((revenue / spend) * 100) / 100 : null);

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
          integrationId,
          campaign.campaignId,
          campaign.name ?? `Campaign ${campaign.campaignId}`,
          status,
          spend,
          impressions,
          clicks,
          conversions,
          revenue,
          roas,
        ],
        { allowNoTenant: true }
      );

      saved++;

    } catch (err) {
      logger.warn('bolcom.adv.campaign.upsert.failed', {
        tenantId,
        integrationId,
        campaignId: campaign.campaignId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  logger.info('bolcom.adv.sync.complete', {
    tenantId,
    integrationId,
    saved,
    total:     campaigns.length,
    withPerf:  perfMap.size,
    startDate,
    endDate,
  });

  return { hasAccess: true, campaignCount: saved };
}
