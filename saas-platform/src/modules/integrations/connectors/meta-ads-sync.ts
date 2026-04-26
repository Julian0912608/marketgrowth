// ============================================================
// src/modules/integrations/connectors/meta-ads-sync.ts
//
// Meta Ads sync functie. Wordt aangeroepen vanuit:
//   1. POST /api/integrations/advertising/meta/:integrationId/sync (handmatig)
//   2. sync.scheduler.ts → scheduleMetaSync() (elk uur automatisch)
//
// Wat het doet per integratie:
//   1. Decrypt access token uit DB
//   2. Voor elk ad account in meta_ad_accounts:
//      a. Haal campaigns op via Graph API
//      b. Haal adsets op
//      c. Haal ads op
//      d. Haal insights van afgelopen 30 dagen (per campaign)
//   3. Schrijf naar meta_* tabellen (bron van waarheid voor PR 3)
//   4. Schrijf samenvatting naar ad_campaigns (voor /dashboard/ads)
//
// Marketing API version: v21.0
// ============================================================

import { db }            from '../../../infrastructure/database/connection';
import { logger }        from '../../../shared/logging/logger';
import { decryptToken }  from '../../../shared/crypto/token-encryption';

const META_API_VERSION = 'v21.0';
const META_GRAPH_BASE  = `https://graph.facebook.com/${META_API_VERSION}`;

// ── Types voor Graph API responses ────────────────────────────

interface MetaCampaignRaw {
  id:                string;
  name:              string;
  status:            string;
  objective?:        string;
  daily_budget?:     string;
  lifetime_budget?:  string;
  start_time?:       string;
  stop_time?:        string;
}

interface MetaAdsetRaw {
  id:                string;
  name:              string;
  campaign_id:       string;
  status:            string;
  daily_budget?:     string;
  lifetime_budget?:  string;
  optimization_goal?: string;
  billing_event?:    string;
  bid_strategy?:     string;
  targeting?:        Record<string, unknown>;
  start_time?:       string;
  end_time?:         string;
}

interface MetaAdRaw {
  id:               string;
  name:             string;
  adset_id:         string;
  status:           string;
  preview_shareable_link?: string;
}

interface MetaInsightRaw {
  date_start:        string;
  date_stop:         string;
  campaign_id:       string;
  impressions?:      string;
  clicks?:           string;
  spend?:            string;
  reach?:            string;
  frequency?:        string;
  ctr?:              string;
  cpc?:              string;
  cpm?:              string;
  actions?:          Array<{ action_type: string; value: string }>;
  action_values?:    Array<{ action_type: string; value: string }>;
}

interface MetaApiPage<T> {
  data?:    T[];
  paging?: {
    cursors?: { before?: string; after?: string };
    next?:    string;
  };
}

export interface MetaSyncResult {
  hasAccess:       boolean;
  adAccountsCount: number;
  campaignsCount:  number;
  adsetsCount:     number;
  adsCount:        number;
  insightsCount:   number;
  totalSpend:      number;
  errorMessage?:   string;
}

// ── Helper: Graph API GET met paging ──────────────────────────
async function graphGet<T>(path: string, accessToken: string): Promise<T[]> {
  const allItems: T[] = [];
  let url: string | null = `${META_GRAPH_BASE}${path}${path.includes('?') ? '&' : '?'}access_token=${encodeURIComponent(accessToken)}&limit=100`;

  // Max 10 pages om geen runaway loops te krijgen (1000 items max per object type)
  for (let page = 0; page < 10 && url; page++) {
    const res = await fetch(url);
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Meta Graph API error (${res.status}): ${body.slice(0, 200)}`);
    }
    const json = await res.json() as MetaApiPage<T>;
    if (json.data && json.data.length > 0) {
      allItems.push(...json.data);
    }
    url = json.paging?.next ?? null;
  }

  return allItems;
}

// ── Helper: parse insight actions naar conversions + revenue ─
function extractConversions(actions?: Array<{ action_type: string; value: string }>): number {
  if (!actions) return 0;
  // Telt alle 'purchase'-achtige acties
  const purchaseTypes = ['purchase', 'omni_purchase', 'offsite_conversion.fb_pixel_purchase'];
  return actions
    .filter(a => purchaseTypes.includes(a.action_type))
    .reduce((sum, a) => sum + (parseFloat(a.value) || 0), 0);
}

function extractConversionValue(actionValues?: Array<{ action_type: string; value: string }>): number {
  if (!actionValues) return 0;
  const purchaseTypes = ['purchase', 'omni_purchase', 'offsite_conversion.fb_pixel_purchase'];
  return actionValues
    .filter(a => purchaseTypes.includes(a.action_type))
    .reduce((sum, a) => sum + (parseFloat(a.value) || 0), 0);
}

// ── Hoofdfunctie ──────────────────────────────────────────────
export async function syncMetaAdsData(
  integrationId: string,
  tenantId:      string
): Promise<MetaSyncResult> {

  logger.info('meta.adv.sync.start', { tenantId, integrationId });

  // 1. Haal access token op
  const credRow = await db.query<{ access_token: string; token_expires_at: Date | null }>(
    `SELECT access_token, token_expires_at
     FROM integration_credentials
     WHERE integration_id = $1`,
    [integrationId],
    { allowNoTenant: true }
  );

  if (!credRow.rows[0]?.access_token) {
    logger.warn('meta.adv.sync.no_credentials', { tenantId, integrationId });
    return { hasAccess: false, adAccountsCount: 0, campaignsCount: 0, adsetsCount: 0, adsCount: 0, insightsCount: 0, totalSpend: 0, errorMessage: 'Geen credentials' };
  }

  const accessToken = decryptToken(credRow.rows[0].access_token);
  if (!accessToken) {
    return { hasAccess: false, adAccountsCount: 0, campaignsCount: 0, adsetsCount: 0, adsCount: 0, insightsCount: 0, totalSpend: 0, errorMessage: 'Token decryption mislukt' };
  }

  // Token expiry check — log warning maar probeer toch (kan nog kort werken)
  if (credRow.rows[0].token_expires_at && credRow.rows[0].token_expires_at < new Date()) {
    logger.warn('meta.adv.sync.token_expired', {
      tenantId,
      integrationId,
      expiredAt: credRow.rows[0].token_expires_at,
    });
  }

  // 2. Haal alle ad accounts voor deze integratie op
  const accountsResult = await db.query<{
    id:           string;
    external_id:  string;
    account_name: string | null;
    currency:     string | null;
  }>(
    `SELECT id, external_id, account_name, currency
     FROM meta_ad_accounts
     WHERE integration_id = $1`,
    [integrationId],
    { allowNoTenant: true }
  );

  if (accountsResult.rows.length === 0) {
    logger.warn('meta.adv.sync.no_ad_accounts', { tenantId, integrationId });
    return { hasAccess: false, adAccountsCount: 0, campaignsCount: 0, adsetsCount: 0, adsCount: 0, insightsCount: 0, totalSpend: 0, errorMessage: 'Geen ad accounts' };
  }

  let totalCampaigns = 0;
  let totalAdsets   = 0;
  let totalAds      = 0;
  let totalInsights = 0;
  let totalSpend    = 0;

  // 3. Voor elk ad account: sync alles
  for (const account of accountsResult.rows) {
    try {
      const result = await syncAdAccount({
        accessToken,
        tenantId,
        integrationId,
        adAccountDbId:  account.id,
        adAccountExtId: account.external_id,
      });
      totalCampaigns += result.campaigns;
      totalAdsets   += result.adsets;
      totalAds      += result.ads;
      totalInsights += result.insights;
      totalSpend    += result.spend;
    } catch (err) {
      logger.error('meta.adv.sync.account_error', {
        tenantId,
        integrationId,
        adAccount: account.external_id,
        error:     (err as Error).message,
      });
    }
  }

  // 4. Update last_sync_at op de integratie
  await db.query(
    `UPDATE tenant_integrations
     SET last_sync_at = now(),
         next_sync_at = now() + INTERVAL '1 hour',
         status       = 'active',
         error_message = null,
         updated_at   = now()
     WHERE id = $1`,
    [integrationId],
    { allowNoTenant: true }
  );

  logger.info('meta.adv.sync.complete', {
    tenantId,
    integrationId,
    adAccounts: accountsResult.rows.length,
    campaigns:  totalCampaigns,
    adsets:     totalAdsets,
    ads:        totalAds,
    insights:   totalInsights,
    totalSpend,
  });

  return {
    hasAccess:       true,
    adAccountsCount: accountsResult.rows.length,
    campaignsCount:  totalCampaigns,
    adsetsCount:     totalAdsets,
    adsCount:        totalAds,
    insightsCount:   totalInsights,
    totalSpend,
  };
}

// ── Per-account sync ──────────────────────────────────────────
async function syncAdAccount(args: {
  accessToken:    string;
  tenantId:       string;
  integrationId:  string;
  adAccountDbId:  string;
  adAccountExtId: string;
}): Promise<{ campaigns: number; adsets: number; ads: number; insights: number; spend: number }> {

  const { accessToken, tenantId, integrationId, adAccountDbId, adAccountExtId } = args;

  // ── 3a. Campaigns ────────────────────────────────────────
  const campaignFields = 'id,name,status,objective,daily_budget,lifetime_budget,start_time,stop_time';
  const campaigns = await graphGet<MetaCampaignRaw>(
    `/${adAccountExtId}/campaigns?fields=${campaignFields}`,
    accessToken
  );

  // Map external_id → DB UUID voor lookups bij adsets/ads
  const campaignDbIdMap = new Map<string, string>();

  for (const c of campaigns) {
    const upsert = await db.query<{ id: string }>(
      `INSERT INTO meta_campaigns
         (tenant_id, integration_id, ad_account_id, external_id, name, objective,
          status, daily_budget, lifetime_budget, start_time, stop_time, raw)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       ON CONFLICT (ad_account_id, external_id)
       DO UPDATE SET
         name            = EXCLUDED.name,
         objective       = EXCLUDED.objective,
         status          = EXCLUDED.status,
         daily_budget    = EXCLUDED.daily_budget,
         lifetime_budget = EXCLUDED.lifetime_budget,
         start_time      = EXCLUDED.start_time,
         stop_time       = EXCLUDED.stop_time,
         raw             = EXCLUDED.raw,
         updated_at      = now()
       RETURNING id`,
      [
        tenantId,
        integrationId,
        adAccountDbId,
        c.id,
        c.name,
        c.objective ?? null,
        c.status,
        c.daily_budget    ? parseFloat(c.daily_budget) / 100 : null,
        c.lifetime_budget ? parseFloat(c.lifetime_budget) / 100 : null,
        c.start_time ?? null,
        c.stop_time  ?? null,
        JSON.stringify(c),
      ],
      { allowNoTenant: true }
    );
    campaignDbIdMap.set(c.id, upsert.rows[0].id);
  }

  // ── 3b. Adsets ───────────────────────────────────────────
  const adsetFields = 'id,name,campaign_id,status,daily_budget,lifetime_budget,optimization_goal,billing_event,bid_strategy,targeting,start_time,end_time';
  const adsets = await graphGet<MetaAdsetRaw>(
    `/${adAccountExtId}/adsets?fields=${adsetFields}`,
    accessToken
  );

  const adsetDbIdMap = new Map<string, string>();

  for (const a of adsets) {
    const campaignDbId = campaignDbIdMap.get(a.campaign_id);
    if (!campaignDbId) continue;  // adset zonder bekende campaign — skip

    const upsert = await db.query<{ id: string }>(
      `INSERT INTO meta_adsets
         (tenant_id, integration_id, campaign_id, external_id, name, status,
          daily_budget, lifetime_budget, optimization_goal, billing_event,
          bid_strategy, targeting, start_time, end_time, raw)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
       ON CONFLICT (campaign_id, external_id)
       DO UPDATE SET
         name              = EXCLUDED.name,
         status            = EXCLUDED.status,
         daily_budget      = EXCLUDED.daily_budget,
         lifetime_budget   = EXCLUDED.lifetime_budget,
         optimization_goal = EXCLUDED.optimization_goal,
         billing_event     = EXCLUDED.billing_event,
         bid_strategy      = EXCLUDED.bid_strategy,
         targeting         = EXCLUDED.targeting,
         start_time        = EXCLUDED.start_time,
         end_time          = EXCLUDED.end_time,
         raw               = EXCLUDED.raw,
         updated_at        = now()
       RETURNING id`,
      [
        tenantId,
        integrationId,
        campaignDbId,
        a.id,
        a.name,
        a.status,
        a.daily_budget    ? parseFloat(a.daily_budget) / 100 : null,
        a.lifetime_budget ? parseFloat(a.lifetime_budget) / 100 : null,
        a.optimization_goal ?? null,
        a.billing_event ?? null,
        a.bid_strategy ?? null,
        a.targeting ? JSON.stringify(a.targeting) : null,
        a.start_time ?? null,
        a.end_time   ?? null,
        JSON.stringify(a),
      ],
      { allowNoTenant: true }
    );
    adsetDbIdMap.set(a.id, upsert.rows[0].id);
  }

  // ── 3c. Ads ──────────────────────────────────────────────
  const adFields = 'id,name,adset_id,status,preview_shareable_link';
  const ads = await graphGet<MetaAdRaw>(
    `/${adAccountExtId}/ads?fields=${adFields}`,
    accessToken
  );

  for (const ad of ads) {
    const adsetDbId = adsetDbIdMap.get(ad.adset_id);
    if (!adsetDbId) continue;

    await db.query(
      `INSERT INTO meta_ads
         (tenant_id, integration_id, adset_id, external_id, name, status,
          preview_url, raw)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (adset_id, external_id)
       DO UPDATE SET
         name        = EXCLUDED.name,
         status      = EXCLUDED.status,
         preview_url = EXCLUDED.preview_url,
         raw         = EXCLUDED.raw,
         updated_at  = now()`,
      [
        tenantId,
        integrationId,
        adsetDbId,
        ad.id,
        ad.name,
        ad.status,
        ad.preview_shareable_link ?? null,
        JSON.stringify(ad),
      ],
      { allowNoTenant: true }
    );
  }

  // ── 3d. Insights laatste 30 dagen, per campaign per dag ──
  const insightsFields = 'campaign_id,date_start,date_stop,impressions,clicks,spend,reach,frequency,ctr,cpc,cpm,actions,action_values';
  const today = new Date();
  const thirtyDaysAgo = new Date(today.getTime() - 30 * 24 * 60 * 60 * 1000);
  const since = thirtyDaysAgo.toISOString().slice(0, 10);
  const until = today.toISOString().slice(0, 10);

  const insightsPath = `/${adAccountExtId}/insights?fields=${insightsFields}` +
    `&level=campaign&time_increment=1` +
    `&time_range=${encodeURIComponent(JSON.stringify({ since, until }))}`;

  let insights: MetaInsightRaw[] = [];
  try {
    insights = await graphGet<MetaInsightRaw>(insightsPath, accessToken);
  } catch (err) {
    logger.warn('meta.adv.sync.insights_failed', {
      tenantId,
      integrationId,
      adAccount: adAccountExtId,
      error:     (err as Error).message,
    });
  }

  let totalAccountSpend = 0;

  for (const insight of insights) {
    const campaignDbId = campaignDbIdMap.get(insight.campaign_id);
    if (!campaignDbId) continue;

    const impressions      = parseInt(insight.impressions || '0', 10);
    const clicks           = parseInt(insight.clicks      || '0', 10);
    const spend            = parseFloat(insight.spend     || '0');
    const reach            = parseInt(insight.reach       || '0', 10);
    const frequency        = parseFloat(insight.frequency || '0');
    const ctr              = parseFloat(insight.ctr       || '0');
    const cpc              = parseFloat(insight.cpc       || '0');
    const cpm              = parseFloat(insight.cpm       || '0');
    const conversions      = extractConversions(insight.actions);
    const conversionValue  = extractConversionValue(insight.action_values);
    const roas             = spend > 0 ? conversionValue / spend : 0;

    totalAccountSpend += spend;

    await db.query(
      `INSERT INTO meta_campaign_insights
         (tenant_id, integration_id, campaign_id, date,
          impressions, clicks, spend, reach, frequency, ctr, cpc, cpm,
          conversions, conversion_value, roas, raw)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
       ON CONFLICT (campaign_id, date)
       DO UPDATE SET
         impressions      = EXCLUDED.impressions,
         clicks           = EXCLUDED.clicks,
         spend            = EXCLUDED.spend,
         reach            = EXCLUDED.reach,
         frequency        = EXCLUDED.frequency,
         ctr              = EXCLUDED.ctr,
         cpc              = EXCLUDED.cpc,
         cpm              = EXCLUDED.cpm,
         conversions      = EXCLUDED.conversions,
         conversion_value = EXCLUDED.conversion_value,
         roas             = EXCLUDED.roas,
         raw              = EXCLUDED.raw`,
      [
        tenantId,
        integrationId,
        campaignDbId,
        insight.date_start,
        impressions,
        clicks,
        spend,
        reach,
        frequency || null,
        ctr || null,
        cpc || null,
        cpm || null,
        conversions,
        conversionValue,
        roas || null,
        JSON.stringify(insight),
      ],
      { allowNoTenant: true }
    );
  }

  // ── 3e. Schrijf samenvatting per campaign naar ad_campaigns ─
  // Aggregeer over alle dagen voor elke campaign zodat /dashboard/ads
  // direct met Meta-data werkt zonder schemawijzigingen.
  for (const c of campaigns) {
    const campaignDbId = campaignDbIdMap.get(c.id);
    if (!campaignDbId) continue;

    const aggResult = await db.query<{
      impressions:      string;
      clicks:           string;
      spend:            string;
      conversions:      string;
      conversion_value: string;
    }>(
      `SELECT
         COALESCE(SUM(impressions), 0)       AS impressions,
         COALESCE(SUM(clicks), 0)            AS clicks,
         COALESCE(SUM(spend), 0)             AS spend,
         COALESCE(SUM(conversions), 0)       AS conversions,
         COALESCE(SUM(conversion_value), 0)  AS conversion_value
       FROM meta_campaign_insights
       WHERE campaign_id = $1`,
      [campaignDbId],
      { allowNoTenant: true }
    );

    const agg = aggResult.rows[0];
    const aggImpressions = parseInt(agg.impressions || '0', 10);
    const aggClicks      = parseInt(agg.clicks      || '0', 10);
    const aggSpend       = parseFloat(agg.spend     || '0');
    const aggConversions = parseInt(agg.conversions || '0', 10);
    const aggRevenue     = parseFloat(agg.conversion_value || '0');
    const aggRoas        = aggSpend > 0 ? aggRevenue / aggSpend : 0;

    await db.query(
      `INSERT INTO ad_campaigns
         (tenant_id, integration_id, platform, campaign_id, name, status,
          spend, impressions, clicks, conversions, revenue, roas, updated_at)
       VALUES ($1, $2, 'meta_ads', $3, $4, $5, $6, $7, $8, $9, $10, $11, now())
       ON CONFLICT (tenant_id, platform, campaign_id)
       DO UPDATE SET
         name        = EXCLUDED.name,
         status      = EXCLUDED.status,
         spend       = EXCLUDED.spend,
         impressions = EXCLUDED.impressions,
         clicks      = EXCLUDED.clicks,
         conversions = EXCLUDED.conversions,
         revenue     = EXCLUDED.revenue,
         roas        = EXCLUDED.roas,
         updated_at  = now()`,
      [
        tenantId,
        integrationId,
        c.id,
        c.name,
        c.status,
        aggSpend,
        aggImpressions,
        aggClicks,
        aggConversions,
        aggRevenue,
        aggRoas,
      ],
      { allowNoTenant: true }
    );
  }

  return {
    campaigns: campaigns.length,
    adsets:    adsets.length,
    ads:       ads.length,
    insights:  insights.length,
    spend:     totalAccountSpend,
  };
}
