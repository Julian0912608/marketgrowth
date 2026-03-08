// ============================================================
// src/modules/integrations/connectors/shopify.connector.ts
//
// Shopify Admin REST API connector.
// Authenticatie: OAuth2
// API versie: 2024-01 (stable)
//
// Rate limits: 2 calls/sec (Basic), 4/sec (Advanced), 10/sec (Plus)
// We gebruiken een token bucket via Redis voor 500+ tenants.
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
  WebhookRegistration,
  TokenRefreshResult,
  NormalizedLineItem,
} from '../types/integration.types';
import { logger } from '../../../shared/logging/logger';

const SHOPIFY_API_VERSION = '2024-01';

export class ShopifyConnector implements IPlatformConnector {
  readonly platform = 'shopify' as const;

  // ── Verbinding testen ─────────────────────────────────────
  async testConnection(creds: IntegrationCredentials): Promise<ConnectionTestResult> {
    try {
      const data = await this.get(creds, '/shop.json');
      const shop = data.shop;

      return {
        success: true,
        shopName:     shop.name,
        shopCurrency: shop.currency,
        shopTimezone: shop.iana_timezone,
        shopCountry:  shop.country_code,
      };
    } catch (err: any) {
      return {
        success: false,
        error: err.message ?? 'Verbinding mislukt',
      };
    }
  }

  // ── Orders ophalen ────────────────────────────────────────
  async fetchOrders(
    creds: IntegrationCredentials,
    options: FetchOptions
  ): Promise<PaginatedResult<NormalizedOrder>> {
    const params = new URLSearchParams({
      status: 'any',
      limit:  String(Math.min(options.limit ?? 250, 250)),
    });

    if (options.updatedAfter) {
      params.set('updated_at_min', options.updatedAfter.toISOString());
    }
    if (options.cursor) {
      // Shopify gebruikt Link header cursor paginering
      // De cursor is de volledige next page URL
      const url = new URL(options.cursor);
      url.searchParams.forEach((v, k) => params.set(k, v));
    }

    const { data, nextCursor } = await this.getPaginated(
      creds,
      `/orders.json?${params.toString()}`
    );

    const items = (data.orders ?? []).map((o: any) => this.normalizeOrder(o));

    return { items, hasNextPage: !!nextCursor, nextCursor };
  }

  // ── Producten ophalen ─────────────────────────────────────
  async fetchProducts(
    creds: IntegrationCredentials,
    options: FetchOptions
  ): Promise<PaginatedResult<NormalizedProduct>> {
    const params = new URLSearchParams({
      limit: String(Math.min(options.limit ?? 250, 250)),
    });
    if (options.updatedAfter) {
      params.set('updated_at_min', options.updatedAfter.toISOString());
    }
    if (options.cursor) {
      const url = new URL(options.cursor);
      url.searchParams.forEach((v, k) => params.set(k, v));
    }

    const { data, nextCursor } = await this.getPaginated(
      creds,
      `/products.json?${params.toString()}`
    );

    const items = (data.products ?? []).map((p: any) => this.normalizeProduct(p));
    return { items, hasNextPage: !!nextCursor, nextCursor };
  }

  // ── Klanten ophalen ───────────────────────────────────────
  async fetchCustomers(
    creds: IntegrationCredentials,
    options: FetchOptions
  ): Promise<PaginatedResult<NormalizedCustomer>> {
    const params = new URLSearchParams({
      limit: String(Math.min(options.limit ?? 250, 250)),
    });
    if (options.updatedAfter) {
      params.set('updated_at_min', options.updatedAfter.toISOString());
    }
    if (options.cursor) {
      const url = new URL(options.cursor);
      url.searchParams.forEach((v, k) => params.set(k, v));
    }

    const { data, nextCursor } = await this.getPaginated(
      creds,
      `/customers.json?${params.toString()}`
    );

    const items = (data.customers ?? []).map((c: any) => this.normalizeCustomer(c));
    return { items, hasNextPage: !!nextCursor, nextCursor };
  }

  // ── Webhook registreren ───────────────────────────────────
  async registerWebhook(
    creds: IntegrationCredentials,
    topic: string,
    callbackUrl: string
  ): Promise<WebhookRegistration> {
    const secret = crypto.randomBytes(32).toString('hex');

    const data = await this.post(creds, '/webhooks.json', {
      webhook: {
        topic,
        address: callbackUrl,
        format: 'json',
      },
    });

    return {
      externalHookId: String(data.webhook.id),
      topic,
      endpointUrl: callbackUrl,
      secret,
    };
  }

  // ── Webhook verificatie ───────────────────────────────────
  verifyWebhook(payload: Buffer, signature: string, secret: string): boolean {
    const computed = crypto
      .createHmac('sha256', secret)
      .update(payload)
      .digest('base64');
    return crypto.timingSafeEqual(
      Buffer.from(computed),
      Buffer.from(signature)
    );
  }

  // ── Token vernieuwen (OAuth2) ─────────────────────────────
  // Shopify offline tokens verlopen niet — dit is voor online tokens
  async refreshAccessToken(creds: IntegrationCredentials): Promise<TokenRefreshResult> {
    // Shopify offline access tokens verlopen niet.
    // Deze methode is hier als compat-stub.
    return {
      accessToken: creds.accessToken!,
      expiresAt: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
    };
  }

  // ── OAuth2 URL genereren ──────────────────────────────────
  static buildAuthUrl(
    shopDomain: string,
    clientId: string,
    redirectUri: string,
    state: string
  ): string {
    const scopes = [
      'read_orders',
      'read_products',
      'read_customers',
      'read_analytics',
    ].join(',');

    return (
      `https://${shopDomain}/admin/oauth/authorize?` +
      new URLSearchParams({
        client_id:    clientId,
        scope:        scopes,
        redirect_uri: redirectUri,
        state,
      }).toString()
    );
  }

  // ── OAuth2 token uitwisselen ──────────────────────────────
  static async exchangeCode(
    shopDomain: string,
    code: string,
    clientId: string,
    clientSecret: string
  ): Promise<{ accessToken: string }> {
    const res = await fetch(
      `https://${shopDomain}/admin/oauth/access_token`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client_id:     clientId,
          client_secret: clientSecret,
          code,
        }),
      }
    );

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Shopify OAuth token exchange mislukt: ${err}`);
    }

    const data = await res.json();
    return { accessToken: data.access_token };
  }

  // ── Normalisatie ──────────────────────────────────────────

  private normalizeOrder(o: any): NormalizedOrder {
    return {
      externalId:        String(o.id),
      externalNumber:    o.name,           // '#1001'
      totalAmount:       parseFloat(o.total_price ?? '0'),
      subtotalAmount:    parseFloat(o.subtotal_price ?? '0'),
      taxAmount:         parseFloat(o.total_tax ?? '0'),
      shippingAmount:    o.shipping_lines?.reduce(
        (s: number, l: any) => s + parseFloat(l.price ?? '0'), 0
      ) ?? 0,
      discountAmount:    parseFloat(o.total_discounts ?? '0'),
      currency:          o.currency ?? 'EUR',
      status:            this.mapOrderStatus(o.financial_status, o.fulfillment_status),
      financialStatus:   o.financial_status,
      fulfillmentStatus: o.fulfillment_status,
      customerEmailHash: o.email
        ? crypto.createHash('sha256').update(o.email.toLowerCase()).digest('hex')
        : undefined,
      isFirstOrder:      o.customer?.orders_count === 1,
      lineItems:         (o.line_items ?? []).map((li: any) => this.normalizeLineItem(li)),
      tags:              o.tags ? o.tags.split(', ').filter(Boolean) : [],
      note:              o.note ?? undefined,
      source:            o.source_name ?? undefined,
      orderedAt:         new Date(o.created_at),
      updatedAt:         new Date(o.updated_at),
    };
  }

  private normalizeLineItem(li: any): NormalizedLineItem {
    return {
      externalId:     String(li.id),
      productId:      li.product_id ? String(li.product_id) : undefined,
      variantId:      li.variant_id  ? String(li.variant_id) : undefined,
      sku:            li.sku ?? undefined,
      title:          li.title ?? '',
      quantity:       li.quantity ?? 1,
      unitPrice:      parseFloat(li.price ?? '0'),
      totalPrice:     parseFloat(li.price ?? '0') * (li.quantity ?? 1),
      discountAmount: (li.discount_allocations ?? []).reduce(
        (s: number, d: any) => s + parseFloat(d.amount ?? '0'), 0
      ),
    };
  }

  private normalizeProduct(p: any): NormalizedProduct {
    const prices = (p.variants ?? [])
      .map((v: any) => parseFloat(v.price ?? '0'))
      .filter((n: number) => n > 0);

    return {
      externalId:       String(p.id),
      title:            p.title ?? '',
      handle:           p.handle ?? undefined,
      status:           p.status ?? undefined,
      productType:      p.product_type ?? undefined,
      tags:             p.tags ? p.tags.split(', ').filter(Boolean) : [],
      vendor:           p.vendor ?? undefined,
      totalInventory:   p.variants?.reduce(
        (s: number, v: any) => s + (v.inventory_quantity ?? 0), 0
      ),
      requiresShipping: p.variants?.[0]?.requires_shipping ?? true,
      priceMin:         prices.length ? Math.min(...prices) : undefined,
      priceMax:         prices.length ? Math.max(...prices) : undefined,
      publishedAt:      p.published_at ? new Date(p.published_at) : undefined,
      updatedAt:        new Date(p.updated_at),
    };
  }

  private normalizeCustomer(c: any): NormalizedCustomer {
    return {
      externalId:       String(c.id),
      emailHash:        c.email
        ? crypto.createHash('sha256').update(c.email.toLowerCase()).digest('hex')
        : crypto.createHash('sha256').update(String(c.id)).digest('hex'),
      firstName:        c.first_name ?? undefined,
      lastName:         c.last_name ?? undefined,
      country:          c.default_address?.country_code ?? undefined,
      acceptsMarketing: c.accepts_marketing ?? false,
      totalSpent:       parseFloat(c.total_spent ?? '0'),
      orderCount:       c.orders_count ?? 0,
      firstOrderAt:     undefined,   // niet beschikbaar in basis customer endpoint
      lastOrderAt:      c.last_order_id ? undefined : undefined,
      updatedAt:        new Date(c.updated_at),
    };
  }

  private mapOrderStatus(financial: string, fulfillment: string): string {
    if (financial === 'refunded' || financial === 'voided') return 'refunded';
    if (financial === 'paid' && fulfillment === 'fulfilled') return 'completed';
    if (financial === 'paid') return 'processing';
    if (financial === 'pending') return 'pending';
    return financial ?? 'unknown';
  }

  // ── HTTP helpers ──────────────────────────────────────────

  private baseUrl(creds: IntegrationCredentials): string {
    return `https://${creds.shopDomain}/admin/api/${SHOPIFY_API_VERSION}`;
  }

  private async get(creds: IntegrationCredentials, path: string): Promise<any> {
    const res = await fetch(`${this.baseUrl(creds)}${path}`, {
      headers: {
        'X-Shopify-Access-Token': creds.accessToken!,
        'Content-Type':           'application/json',
      },
    });

    if (!res.ok) {
      const text = await res.text();
      throw Object.assign(
        new Error(`Shopify API fout ${res.status}: ${text}`),
        { httpStatus: res.status, rateLimited: res.status === 429 }
      );
    }

    return res.json();
  }

  private async getPaginated(
    creds: IntegrationCredentials,
    path: string
  ): Promise<{ data: any; nextCursor?: string }> {
    const res = await fetch(`${this.baseUrl(creds)}${path}`, {
      headers: {
        'X-Shopify-Access-Token': creds.accessToken!,
        'Content-Type':           'application/json',
      },
    });

    if (!res.ok) {
      throw Object.assign(
        new Error(`Shopify API fout ${res.status}`),
        { httpStatus: res.status, rateLimited: res.status === 429 }
      );
    }

    // Cursor uit Link header halen
    let nextCursor: string | undefined;
    const linkHeader = res.headers.get('link');
    if (linkHeader) {
      const match = linkHeader.match(/<([^>]+)>;\s*rel="next"/);
      if (match) nextCursor = match[1];
    }

    const data = await res.json();
    return { data, nextCursor };
  }

  private async post(
    creds: IntegrationCredentials,
    path: string,
    body: any
  ): Promise<any> {
    const res = await fetch(`${this.baseUrl(creds)}${path}`, {
      method: 'POST',
      headers: {
        'X-Shopify-Access-Token': creds.accessToken!,
        'Content-Type':           'application/json',
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Shopify POST fout ${res.status}: ${text}`);
    }

    return res.json();
  }
}
