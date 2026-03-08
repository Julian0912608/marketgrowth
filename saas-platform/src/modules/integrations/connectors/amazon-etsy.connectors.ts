// ============================================================
// src/modules/integrations/connectors/amazon-etsy.connectors.ts
//
// Amazon SP-API connector (Selling Partner API)
// Etsy v3 API connector
// ============================================================

import crypto from 'crypto';
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
  NormalizedLineItem,
} from '../types/integration.types';

// ============================================================
// AMAZON SP-API
//
// Authenticatie: OAuth2 (Login with Amazon — LWA)
// API: Amazon Selling Partner API
// Rate limits: strict per operatie, wij limiteren op 1 req/sec
//
// Setup vereist:
//   - AWS IAM rol met SP-API permissies
//   - Amazon Developer account
//   - LWA Client ID + Secret
// ============================================================
export class AmazonConnector implements IPlatformConnector {
  readonly platform = 'amazon' as const;

  async testConnection(creds: IntegrationCredentials): Promise<ConnectionTestResult> {
    try {
      const token = await this.getLWAToken(creds);
      // Haal marketplace info op als verbindingstest
      const data = await this.apiGet(
        token,
        creds,
        '/sellers/v1/marketplaceParticipations'
      ) as Record<string, unknown>;

      const participations = (data.payload as Record<string, unknown>[] | undefined) ?? [];
      const first = participations[0] as Record<string, unknown> | undefined;
      const marketplace = first?.marketplace as Record<string, unknown> | undefined;

      return {
        success:      true,
        shopName:     `Amazon ${marketplace?.name ?? 'Seller'}`,
        shopCurrency: marketplace?.defaultCurrencyCode as string ?? 'EUR',
        shopCountry:  marketplace?.countryCode as string ?? 'NL',
      };
    } catch (err: unknown) {
      return { success: false, error: err instanceof Error ? err.message : 'Verbinding mislukt' };
    }
  }

  async fetchOrders(creds: IntegrationCredentials, options: FetchOptions): Promise<PaginatedResult<NormalizedOrder>> {
    const token = await this.getLWAToken(creds);

    const params = new URLSearchParams({
      MarketplaceIds: creds.storeUrl ?? 'A1PA6795UKMFR9', // Default: Amazon.de
      MaxResultsPerPage: String(Math.min(options.limit ?? 100, 100)),
    });

    if (options.updatedAfter) {
      params.set('LastUpdatedAfter', options.updatedAfter.toISOString());
    }
    if (options.cursor) {
      params.set('NextToken', options.cursor);
    }

    const data = await this.apiGet(
      token,
      creds,
      `/orders/v0/orders?${params}`
    ) as Record<string, unknown>;

    const payload    = data.payload as Record<string, unknown> | undefined;
    const orders     = (payload?.Orders as Record<string, unknown>[] | undefined) ?? [];
    const nextToken  = payload?.NextToken as string | undefined;
    const items      = orders.map(o => this.normalizeOrder(o));

    return { items, hasNextPage: !!nextToken, nextCursor: nextToken };
  }

  async fetchProducts(creds: IntegrationCredentials, options: FetchOptions): Promise<PaginatedResult<NormalizedProduct>> {
    const token = await this.getLWAToken(creds);

    const params = new URLSearchParams({
      marketplaceIds: creds.storeUrl ?? 'A1PA6795UKMFR9',
      pageSize:       String(Math.min(options.limit ?? 50, 50)),
    });
    if (options.cursor) params.set('pageToken', options.cursor);

    const data = await this.apiGet(
      token,
      creds,
      `/listings/2021-08-01/items/${creds.apiKey}?${params}`
    ) as Record<string, unknown>;

    const items     = ((data.items as Record<string, unknown>[] | undefined) ?? []).map(p => this.normalizeProduct(p));
    const nextToken = data.nextPageToken as string | undefined;

    return { items, hasNextPage: !!nextToken, nextCursor: nextToken };
  }

  async fetchCustomers(): Promise<PaginatedResult<NormalizedCustomer>> {
    // Amazon stelt geen klantgegevens beschikbaar (privacybescherming)
    return { items: [], hasNextPage: false };
  }

  async refreshAccessToken(creds: IntegrationCredentials): Promise<TokenRefreshResult> {
    const token = await this.getLWAToken(creds);
    return { accessToken: token, expiresAt: new Date(Date.now() + 3500_000) }; // ~1 uur
  }

  // ── Login with Amazon (LWA) token ophalen ─────────────────
  private async getLWAToken(creds: IntegrationCredentials): Promise<string> {
    const res = await fetch('https://api.amazon.com/auth/o2/token', {
      method:  'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type:    'refresh_token',
        refresh_token: creds.refreshToken!,
        client_id:     creds.apiKey!,
        client_secret: creds.apiSecret!,
      }),
    });

    if (!res.ok) throw new Error(`Amazon LWA token mislukt: ${res.status}`);
    const d = await res.json() as { access_token: string };
    return d.access_token;
  }

  // ── Normalisatie ──────────────────────────────────────────
  private normalizeOrder(o: Record<string, unknown>): NormalizedOrder {
    const orderTotal = o.OrderTotal as Record<string, string> | undefined;
    const amount     = parseFloat(orderTotal?.Amount ?? '0');

    return {
      externalId:        String(o.AmazonOrderId),
      externalNumber:    String(o.AmazonOrderId),
      totalAmount:       amount,
      subtotalAmount:    amount,
      taxAmount:         0,
      shippingAmount:    0,
      discountAmount:    0,
      currency:          orderTotal?.CurrencyCode ?? 'EUR',
      status:            this.mapStatus(String(o.OrderStatus ?? '')),
      financialStatus:   o.PaymentMethod as string | undefined,
      fulfillmentStatus: o.FulfillmentChannel as string | undefined,
      customerEmailHash: o.BuyerInfo
        ? crypto.createHash('sha256')
            .update(String((o.BuyerInfo as Record<string, string>).BuyerEmail ?? o.AmazonOrderId).toLowerCase())
            .digest('hex')
        : undefined,
      lineItems: [],  // Aparte SP-API call nodig voor order items
      source:    'amazon',
      orderedAt: new Date(String(o.PurchaseDate ?? new Date())),
      updatedAt: new Date(String(o.LastUpdateDate ?? o.PurchaseDate ?? new Date())),
    };
  }

  private normalizeProduct(p: Record<string, unknown>): NormalizedProduct {
    const summaries  = (p.summaries as Record<string, unknown>[] | undefined) ?? [];
    const first      = summaries[0] as Record<string, unknown> | undefined;
    const attributes = p.attributes as Record<string, unknown> | undefined;
    const itemName   = (attributes?.item_name as Record<string, unknown>[] | undefined)?.[0];

    return {
      externalId:   String(p.sku ?? p.asin),
      title:        String(itemName?.value ?? first?.itemName ?? ''),
      status:       first?.status as string ?? 'active',
      vendor:       'Amazon',
      updatedAt:    new Date(String(first?.lastUpdatedDate ?? new Date())),
    };
  }

  private mapStatus(amazonStatus: string): string {
    const map: Record<string, string> = {
      'Pending':           'pending',
      'Unshipped':         'processing',
      'PartiallyShipped':  'processing',
      'Shipped':           'completed',
      'Canceled':          'cancelled',
      'Unfulfillable':     'failed',
    };
    return map[amazonStatus] ?? 'unknown';
  }

  private async apiGet(token: string, creds: IntegrationCredentials, path: string): Promise<unknown> {
    // Amazon SP-API vereist AWS Signature V4 signing
    // Voor productie gebruik @aws-sdk/signature-v4 package
    // Hier gebruiken we de access token direct (werkt voor sandbox)
    const endpoint = creds.shopDomain ?? 'https://sellingpartnerapi-eu.amazon.com';
    const res = await fetch(`${endpoint}${path}`, {
      headers: {
        'x-amz-access-token': token,
        'Content-Type':       'application/json',
      },
    });
    if (!res.ok) throw new Error(`Amazon SP-API fout ${res.status}: ${await res.text()}`);
    return res.json();
  }

  // OAuth2 URL voor Amazon Seller Authorization
  static buildAuthUrl(clientId: string, redirectUri: string, state: string): string {
    return `https://sellercentral.amazon.com/apps/authorize/consent?` +
      new URLSearchParams({
        application_id: clientId,
        redirect_uri:   redirectUri,
        state,
        version:        'beta',
      }).toString();
  }

  static async exchangeCode(
    code: string,
    clientId: string,
    clientSecret: string
  ): Promise<{ accessToken: string; refreshToken: string }> {
    const res = await fetch('https://api.amazon.com/auth/o2/token', {
      method:  'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type:    'authorization_code',
        code,
        client_id:     clientId,
        client_secret: clientSecret,
      }),
    });
    if (!res.ok) throw new Error(`Amazon OAuth mislukt: ${res.status}`);
    const d = await res.json() as { access_token: string; refresh_token: string };
    return { accessToken: d.access_token, refreshToken: d.refresh_token };
  }
}

// ============================================================
// ETSY v3 API
//
// Authenticatie: OAuth2
// API: https://developers.etsy.com/documentation
// Rate limits: 10 req/sec, 10.000/dag
//
// Etsy is primair voor handgemaakte/vintage producten.
// Orders worden 'receipts' genoemd in de Etsy API.
// ============================================================
export class EtsyConnector implements IPlatformConnector {
  readonly platform = 'etsy' as const;

  async testConnection(creds: IntegrationCredentials): Promise<ConnectionTestResult> {
    try {
      const data = await this.apiGet(creds, '/application/openapi-ping') as Record<string, unknown>;
      // Haal shop info op
      const shopData = await this.apiGet(
        creds,
        `/application/users/${creds.shopDomain}/shops`
      ) as Record<string, unknown>;

      const shops = shopData.results as Record<string, unknown>[] | undefined;
      const shop  = shops?.[0] as Record<string, unknown> | undefined;

      return {
        success:      true,
        shopName:     shop?.shop_name as string ?? 'Etsy Shop',
        shopCurrency: shop?.currency_code as string ?? 'EUR',
        shopCountry:  shop?.country_iso as string ?? 'NL',
      };
    } catch (err: unknown) {
      return { success: false, error: err instanceof Error ? err.message : 'Verbinding mislukt' };
    }
  }

  async fetchOrders(creds: IntegrationCredentials, options: FetchOptions): Promise<PaginatedResult<NormalizedOrder>> {
    const shopId = creds.shopDomain!;
    const limit  = Math.min(options.limit ?? 100, 100);
    const offset = options.page ? (options.page - 1) * limit : 0;

    const params = new URLSearchParams({
      limit:  String(limit),
      offset: String(offset),
    });

    const data = await this.apiGet(
      creds,
      `/application/shops/${shopId}/receipts?${params}`
    ) as Record<string, unknown>;

    const results = (data.results as Record<string, unknown>[] | undefined) ?? [];
    const count   = data.count as number ?? 0;
    const items   = results.map(r => this.normalizeOrder(r));
    const hasMore = offset + limit < count;

    return {
      items,
      hasNextPage: hasMore,
      nextPage:    hasMore ? (options.page ?? 1) + 1 : undefined,
      totalCount:  count,
    };
  }

  async fetchProducts(creds: IntegrationCredentials, options: FetchOptions): Promise<PaginatedResult<NormalizedProduct>> {
    const shopId = creds.shopDomain!;
    const limit  = Math.min(options.limit ?? 100, 100);
    const offset = options.page ? (options.page - 1) * limit : 0;

    const data = await this.apiGet(
      creds,
      `/application/shops/${shopId}/listings/active?limit=${limit}&offset=${offset}`
    ) as Record<string, unknown>;

    const results   = (data.results as Record<string, unknown>[] | undefined) ?? [];
    const count     = data.count as number ?? 0;
    const items     = results.map(p => this.normalizeProduct(p));
    const hasMore   = offset + limit < count;

    return { items, hasNextPage: hasMore, nextPage: hasMore ? (options.page ?? 1) + 1 : undefined };
  }

  async fetchCustomers(): Promise<PaginatedResult<NormalizedCustomer>> {
    // Etsy stelt geen directe klantdata beschikbaar via API
    return { items: [], hasNextPage: false };
  }

  async refreshAccessToken(creds: IntegrationCredentials): Promise<TokenRefreshResult> {
    const res = await fetch('https://api.etsy.com/v3/public/oauth/token', {
      method:  'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type:    'refresh_token',
        client_id:     process.env.ETSY_CLIENT_ID!,
        refresh_token: creds.refreshToken!,
      }),
    });
    if (!res.ok) throw new Error('Etsy token refresh mislukt');
    const d = await res.json() as { access_token: string; refresh_token: string; expires_in: number };
    return {
      accessToken:  d.access_token,
      refreshToken: d.refresh_token,
      expiresAt:    new Date(Date.now() + d.expires_in * 1000),
    };
  }

  // ── Normalisatie ──────────────────────────────────────────
  private normalizeOrder(r: Record<string, unknown>): NormalizedOrder {
    const transactions = (r.transactions as Record<string, unknown>[] | undefined) ?? [];

    const lineItems: NormalizedLineItem[] = transactions.map(t => ({
      externalId:    String(t.transaction_id),
      productId:     t.listing_id ? String(t.listing_id) : undefined,
      title:         String(t.title ?? ''),
      quantity:      (t.quantity as number) ?? 1,
      unitPrice:     ((t.price as Record<string, number> | undefined)?.amount ?? 0) / 100,
      totalPrice:    (((t.price as Record<string, number> | undefined)?.amount ?? 0) / 100) * ((t.quantity as number) ?? 1),
      discountAmount: 0,
    }));

    const grandTotal = (r.grandtotal as Record<string, number> | undefined);

    return {
      externalId:     String(r.receipt_id),
      externalNumber: `#${r.receipt_id}`,
      totalAmount:    (grandTotal?.amount ?? 0) / 100,
      subtotalAmount: ((r.subtotal as Record<string, number> | undefined)?.amount ?? 0) / 100,
      taxAmount:      ((r.total_tax_cost as Record<string, number> | undefined)?.amount ?? 0) / 100,
      shippingAmount: ((r.total_shipping_cost as Record<string, number> | undefined)?.amount ?? 0) / 100,
      discountAmount: ((r.discount_amt as Record<string, number> | undefined)?.amount ?? 0) / 100,
      currency:       grandTotal?.divisor ? 'EUR' : 'EUR',
      status:         r.status === 'paid' ? 'completed' : String(r.status ?? 'pending'),
      financialStatus: r.is_paid ? 'paid' : 'pending',
      fulfillmentStatus: r.is_shipped ? 'shipped' : 'unshipped',
      customerEmailHash: r.buyer_email
        ? crypto.createHash('sha256').update(String(r.buyer_email).toLowerCase()).digest('hex')
        : undefined,
      lineItems,
      source:   'etsy',
      orderedAt: new Date((r.create_timestamp as number) * 1000),
      updatedAt: new Date((r.update_timestamp as number ?? r.create_timestamp as number) * 1000),
    };
  }

  private normalizeProduct(p: Record<string, unknown>): NormalizedProduct {
    const price = (p.price as Record<string, number> | undefined);
    return {
      externalId:       String(p.listing_id),
      title:            String(p.title ?? ''),
      handle:           p.url as string | undefined,
      status:           p.state as string ?? 'active',
      tags:             (p.tags as string[] | undefined) ?? [],
      totalInventory:   p.quantity as number | undefined,
      requiresShipping: p.is_digital === false,
      priceMin:         price ? price.amount / 100 : undefined,
      priceMax:         price ? price.amount / 100 : undefined,
      publishedAt:      p.original_creation_timestamp
        ? new Date((p.original_creation_timestamp as number) * 1000)
        : undefined,
      updatedAt: new Date((p.last_modified_timestamp as number ?? Date.now() / 1000) * 1000),
    };
  }

  verifyWebhook(payload: Buffer, signature: string, secret: string): boolean {
    const computed = crypto.createHmac('sha256', secret).update(payload).digest('hex');
    return crypto.timingSafeEqual(Buffer.from(computed), Buffer.from(signature));
  }

  private async apiGet(creds: IntegrationCredentials, path: string): Promise<unknown> {
    const res = await fetch(`https://api.etsy.com/v3${path}`, {
      headers: {
        'x-api-key':     process.env.ETSY_CLIENT_ID!,
        'Authorization': `Bearer ${creds.accessToken}`,
      },
    });
    if (!res.ok) throw new Error(`Etsy API fout ${res.status}: ${await res.text()}`);
    return res.json();
  }

  // OAuth2 helpers
  static buildAuthUrl(clientId: string, redirectUri: string, state: string, codeChallenge: string): string {
    return `https://www.etsy.com/oauth/connect?` + new URLSearchParams({
      response_type:         'code',
      redirect_uri:          redirectUri,
      scope:                 'transactions_r listings_r',
      client_id:             clientId,
      state,
      code_challenge:        codeChallenge,
      code_challenge_method: 'S256',
    }).toString();
  }

  static async exchangeCode(code: string, redirectUri: string, codeVerifier: string): Promise<{ accessToken: string; refreshToken: string; expiresIn: number }> {
    const res = await fetch('https://api.etsy.com/v3/public/oauth/token', {
      method:  'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type:    'authorization_code',
        client_id:     process.env.ETSY_CLIENT_ID!,
        redirect_uri:  redirectUri,
        code,
        code_verifier: codeVerifier,
      }),
    });
    if (!res.ok) throw new Error(`Etsy OAuth mislukt: ${res.status}`);
    const d = await res.json() as { access_token: string; refresh_token: string; expires_in: number };
    return { accessToken: d.access_token, refreshToken: d.refresh_token, expiresIn: d.expires_in };
  }
}
