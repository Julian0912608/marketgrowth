// ============================================================
// src/modules/integrations/connectors/meta-ads.connector.ts
//
// Meta (Facebook + Instagram) Marketing API connector.
//
// Authentication: OAuth 2.0 with long-lived tokens (60 days).
// Token refresh: short-lived → long-lived exchange via fb_exchange_token.
//
// Note: Meta is an advertising platform, not a store, so the
// fetchOrders/Products/Customers methods are intentional no-ops.
// All real Meta data lives in the meta_* tables and is synced
// through dedicated workers (see PR 2: meta-sync.worker.ts).
//
// Marketing API version: v21.0
//
// FIX: scope `pages_manage_ads` and `instagram_basic` removed —
// not valid for Marketing API in v21.0. Ad management on Pages
// is covered by `ads_management` + `business_management`. Instagram
// ads are managed via the ad account, no separate scope needed.
// ============================================================

import {
  IPlatformConnector,
  IntegrationCredentials,
  FetchOptions,
  PaginatedResult,
  NormalizedOrder,
  NormalizedProduct,
  NormalizedCustomer,
  ConnectionTestResult,
  TokenRefreshResult,
} from '../types/integration.types';

const META_API_VERSION = 'v21.0';
const META_GRAPH_BASE  = `https://graph.facebook.com/${META_API_VERSION}`;

export class MetaAdsConnector implements IPlatformConnector {
  readonly platform = 'meta_ads' as const;

  // ── Verbinding testen ─────────────────────────────────────
  async testConnection(creds: IntegrationCredentials): Promise<ConnectionTestResult> {
    if (!creds.accessToken) {
      return { success: false, error: 'Geen access token' };
    }

    try {
      const meRes = await fetch(
        `${META_GRAPH_BASE}/me?fields=id,name&access_token=${encodeURIComponent(creds.accessToken)}`
      );

      if (!meRes.ok) {
        const body = await meRes.text();
        return {
          success: false,
          error:   `Meta /me call failed (${meRes.status}): ${body.slice(0, 200)}`,
        };
      }

      const me = await meRes.json() as { id: string; name: string };

      const bizRes = await fetch(
        `${META_GRAPH_BASE}/me/businesses?fields=id,name&access_token=${encodeURIComponent(creds.accessToken)}`
      );

      let businessName = me.name;
      if (bizRes.ok) {
        const bizData = await bizRes.json() as { data?: Array<{ id: string; name: string }> };
        if (bizData.data && bizData.data.length > 0) {
          businessName = bizData.data[0].name;
        }
      }

      return {
        success:      true,
        shopName:     businessName,
        shopCurrency: undefined,
        shopCountry:  undefined,
      };
    } catch (err) {
      return {
        success: false,
        error:   err instanceof Error ? err.message : 'Verbindingstest mislukt',
      };
    }
  }

  // ── Long-lived token exchange ────────────────────────────
  async refreshAccessToken(creds: IntegrationCredentials): Promise<TokenRefreshResult> {
    if (!creds.accessToken) {
      throw new Error('Geen access token om te refreshen');
    }

    const appId     = process.env.META_APP_ID;
    const appSecret = process.env.META_APP_SECRET;

    if (!appId || !appSecret) {
      throw new Error('META_APP_ID of META_APP_SECRET ontbreekt in env vars');
    }

    const url = `${META_GRAPH_BASE}/oauth/access_token?` +
      new URLSearchParams({
        grant_type:        'fb_exchange_token',
        client_id:         appId,
        client_secret:     appSecret,
        fb_exchange_token: creds.accessToken,
      }).toString();

    const res = await fetch(url);
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Meta long-lived token exchange mislukt (${res.status}): ${body.slice(0, 200)}`);
    }

    const data = await res.json() as {
      access_token: string;
      token_type:   string;
      expires_in?:  number;
    };

    const expiresInSeconds = data.expires_in ?? 60 * 24 * 60 * 60;
    const expiresAt        = new Date(Date.now() + expiresInSeconds * 1000);

    return {
      accessToken: data.access_token,
      expiresAt,
    };
  }

  // ── No-op fetchers (Meta heeft geen orders/products/customers) ─

  async fetchOrders(_creds: IntegrationCredentials, _options: FetchOptions): Promise<PaginatedResult<NormalizedOrder>> {
    return { items: [], hasNextPage: false };
  }

  async fetchProducts(_creds: IntegrationCredentials, _options: FetchOptions): Promise<PaginatedResult<NormalizedProduct>> {
    return { items: [], hasNextPage: false };
  }

  async fetchCustomers(_creds: IntegrationCredentials, _options: FetchOptions): Promise<PaginatedResult<NormalizedCustomer>> {
    return { items: [], hasNextPage: false };
  }

  // ── OAuth helpers ─────────────────────────────────────────

  /**
   * Bouwt de Facebook OAuth authorization URL.
   *
   * Geldige Marketing API scopes (v21.0):
   *  - ads_management:        beheren van ads/campaigns/adsets
   *  - ads_read:              lezen van Ads Insights
   *  - business_management:   beheren van business assets (incl. Pages voor ads)
   *  - pages_show_list:       lijst van Pages waar de gebruiker toegang heeft
   *  - pages_read_engagement: page-metadata lezen
   *
   * Ads namens Instagram-accounts en Pages werken via deze 5 scopes.
   * Geen aparte instagram_basic of pages_manage_ads scope nodig
   * (die laatste bestaat sinds v17 niet meer als zelfstandige scope).
   *
   * Voor productie-toegang door externe gebruikers vereist Meta
   * App Review op deze scopes. In ontwikkelmodus werkt het direct
   * voor de app-eigenaar (jij) en geadde testers.
   */
  static buildAuthUrl(redirectUri: string, state: string): string {
    const appId = process.env.META_APP_ID;
    if (!appId) {
      throw new Error('META_APP_ID ontbreekt in env vars');
    }

    const scopes = [
      'ads_management',
      'ads_read',
      'business_management',
      'pages_show_list',
      'pages_read_engagement',
    ].join(',');

    return `https://www.facebook.com/${META_API_VERSION}/dialog/oauth?` +
      new URLSearchParams({
        client_id:    appId,
        redirect_uri: redirectUri,
        state,
        scope:        scopes,
        response_type: 'code',
      }).toString();
  }

  /**
   * Wisselt de OAuth authorization code in voor een short-lived access token.
   */
  static async exchangeCode(
    code:        string,
    redirectUri: string
  ): Promise<{ accessToken: string; expiresIn: number }> {
    const appId     = process.env.META_APP_ID;
    const appSecret = process.env.META_APP_SECRET;

    if (!appId || !appSecret) {
      throw new Error('META_APP_ID of META_APP_SECRET ontbreekt in env vars');
    }

    const url = `${META_GRAPH_BASE}/oauth/access_token?` +
      new URLSearchParams({
        client_id:     appId,
        client_secret: appSecret,
        redirect_uri:  redirectUri,
        code,
      }).toString();

    const res = await fetch(url);
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Meta token exchange mislukt (${res.status}): ${body.slice(0, 200)}`);
    }

    const data = await res.json() as {
      access_token: string;
      token_type:   string;
      expires_in?:  number;
    };

    return {
      accessToken: data.access_token,
      expiresIn:   data.expires_in ?? 3600,
    };
  }

  /**
   * Haalt alle ad accounts op die deze gebruiker mag beheren.
   */
  static async fetchAdAccounts(accessToken: string): Promise<Array<{
    externalId:    string;
    name:          string;
    currency:      string;
    timezoneName:  string;
    businessId?:   string;
  }>> {
    const fields = 'id,name,currency,timezone_name,business';
    const url = `${META_GRAPH_BASE}/me/adaccounts?fields=${fields}&access_token=${encodeURIComponent(accessToken)}`;

    const res = await fetch(url);
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Meta /me/adaccounts mislukt (${res.status}): ${body.slice(0, 200)}`);
    }

    const data = await res.json() as {
      data?: Array<{
        id:             string;
        name:           string;
        currency:       string;
        timezone_name:  string;
        business?:      { id: string; name: string };
      }>;
    };

    return (data.data ?? []).map(a => ({
      externalId:   a.id,
      name:         a.name,
      currency:     a.currency,
      timezoneName: a.timezone_name,
      businessId:   a.business?.id,
    }));
  }
}
