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
  // Roept /me en /me/businesses aan om te bevestigen dat het token werkt
  // en de gebruiker toegang heeft tot Business Manager.
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
  // Short-lived tokens (~1 uur) ruilen we direct in voor long-lived (~60 dagen).
  // Wordt aangeroepen direct na de OAuth callback in integration.routes.ts.
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

    // Long-lived tokens duren typisch 60 dagen. Als geen expires_in: 60 dagen aannemen.
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

  // ── OAuth helpers (statische methods, gebruikt door integration.routes.ts) ─

  /**
   * Bouwt de Facebook OAuth authorization URL.
   *
   * Scopes voor Marketing API:
   *  - ads_management:        beheren van ads/campaigns
   *  - ads_read:              lezen van Ads Insights
   *  - business_management:   beheren van business assets
   *  - pages_show_list:       lijst van Pages waar gebruiker toegang heeft
   *  - pages_read_engagement: page-data lezen
   *  - pages_manage_ads:      ads namens een Page maken
   *  - instagram_basic:       Instagram Business account info
   *
   * Opmerking: deze scopes vereisen App Review voor productie-toegang
   * door externe gebruikers. In ontwikkelmodus werkt het direct voor
   * jou als app-eigenaar en geadde testers.
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
      'pages_manage_ads',
      'instagram_basic',
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
   * Wordt direct gevolgd door refreshAccessToken() om hem long-lived te maken.
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
   * Wordt aangeroepen direct na een succesvolle connect om het
   * primaire ad account te bepalen.
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
