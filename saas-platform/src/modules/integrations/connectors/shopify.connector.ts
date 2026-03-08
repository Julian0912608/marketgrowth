// ============================================================
// src/modules/integrations/connectors/shopify.connector.ts
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

  async testConnection(creds: IntegrationCredentials): Promise<ConnectionTestResult> {
    try {
      const data = await this.get(creds, '/shop.json') as { shop: Record<string, string> };
      const shop = data.shop;
      return {
        success:      true,
        shopName:     shop.name,
        shopCurrency: shop.currency,
        shopTimezone: shop.iana_timezone,
        shopCountry:  shop.country_code,
      };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Verbinding mislukt';
      return { success: false, error: msg };
    }
  }

  async fetchOrders(creds: IntegrationCredentials, options: FetchOptions): Promise<PaginatedResult<NormalizedOrder>> {
    const params = new URLSearchParams({
      status: 'any',
      limit:  String(Math.min(options.limit ?? 250, 250)),
    });
    if (options.updatedAfter) params.set('updated_at_min', options.updatedAfter.toISOString());
    if (options.cursor) {
      const url = new URL(options.cursor);
      url.searchParams.forEach((v, k) => params.set(k, v));
    }

    const { data, nextCursor } = await this.getPaginated(creds, `/orders.json?${params.toString()}`);
    const items = ((data as Record<string, unknown[]>).orders ?? []).map((o) => this.normalizeOrder(o as Record<string, unknown>));
    return { items, hasNextPage: !!nextCursor, nextCursor };
  }

  async fetchProducts(creds: IntegrationCredentials, options: FetchOptions): Promise<PaginatedResult<NormalizedProduct>> {
    const params = new URLSearchParams({ limit: String(Math.min(options.limit ?? 250, 250)) });
    if (options.updatedAfter) params.set('updated_at_min', options.updatedAfter.toISOString());
    if (options.cursor) {
      const url = new URL(options.cursor);
      url.searchParams.forEach((v, k) => params.set(k, v));
    }

    const { data, nextCursor } = await this.getPaginated(creds, `/products.json?${params.toString()}`);
    const items = ((data as Record<string, unknown[]>).products ?? []).map((p) => this.normalizeProduct(p as Record<string, unknown>));
    return { items, hasNextPage: !!nextCursor, nextCursor };
  }

  async fetchCustomers(creds: IntegrationCredentials, options: FetchOptions): Promise<PaginatedResult<NormalizedCustomer>> {
    const params = new URLSearchParams({ limit: String(Math.min(options.limit ?? 250, 250)) });
    if (options.updatedAfter) params.set('updated_at_min', options.updatedAfter.toISOString());
    if (options.cursor) {
      const url = new URL(options.cursor);
      url.searchParams.forEach((v, k) => params.set(k, v));
    }

    const { data, nextCursor } = await this.getPaginated(creds, `/customers.json?${params.toString()}`);
    const items = ((data as Record<string, unknown[]>).customers ?? []).map((c) => this.normalizeCustomer(c as Record<string, unknown>));
    return { items, hasNextPage: !!nextCursor, nextCursor };
  }

  async registerWebhook(creds: IntegrationCredentials, topic: string, callbackUrl: string): Promise<WebhookRegistration> {
    const secret = crypto.randomBytes(32).toString('hex');
    const data   = await this.post(creds, '/webhooks.json', { webhook: { topic, address: callbackUrl, format: 'json' } }) as Record<string, Record<string, unknown>>;
    return {
      externalHookId: String(data.webhook.id),
      topic,
      endpointUrl: callbackUrl,
      secret,
    };
  }

  verifyWebhook(payload: Buffer, signature: string, secret: string): boolean {
    const computed = crypto.createHmac('sha256', secret).update(payload).digest('base64');
    return crypto.timingSafeEqual(Buffer.from(computed), Buffer.from(signature));
  }

  async refreshAccessToken(creds: IntegrationCredentials): Promise<TokenRefreshResult> {
    return {
      accessToken: creds.accessToken!,
      expiresAt:   new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
    };
  }

  static buildAuthUrl(shopDomain: string, clientId: string, redirectUri: string, state: string): string {
    const scopes = ['read_orders', 'read_products', 'read_customers', 'read_analytics'].join(',');
    return `https://${shopDomain}/admin/oauth/authorize?` +
      new URLSearchParams({ client_id: clientId, scope: scopes, redirect_uri: redirectUri, state }).toString();
  }

  static async exchangeCode(shopDomain: string, code: string, clientId: string, clientSecret: string): Promise<{ accessToken: string }> {
    const res = await fetch(`https://${shopDomain}/admin/oauth/access_token`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ client_id: clientId, client_secret: clientSecret, code }),
    });
    if (!res.ok) throw new Error(`Shopify OAuth token exchange mislukt: ${await res.text()}`);
    const data = await res.json() as { access_token: string };
    return { accessToken: data.access_token };
  }

  // ── Normalisatie ──────────────────────────────────────────
  private normalizeOrder(o: Record<string, unknown>): NormalizedOrder {
    const lineItems  = (o.line_items as Record<string, unknown>[] | undefined) ?? [];
    const shippingLines = (o.shipping_lines as Record<string, unknown>[] | undefined) ?? [];
    const discountAllocs = (o.discount_allocations as Record<string, unknown>[] | undefined) ?? [];

    return {
      externalId:        String(o.id),
      externalNumber:    o.name as string,
      totalAmount:       parseFloat(String(o.total_price ?? '0')),
      subtotalAmount:    parseFloat(String(o.subtotal_price ?? '0')),
      taxAmount:         parseFloat(String(o.total_tax ?? '0')),
      shippingAmount:    shippingLines.reduce((s, l) => s + parseFloat(String((l as Record<string, unknown>).price ?? '0')), 0),
      discountAmount:    parseFloat(String(o.total_discounts ?? '0')),
      currency:          (o.currency as string) ?? 'EUR',
      status:            this.mapOrderStatus(o.financial_status as string, o.fulfillment_status as string),
      financialStatus:   o.financial_status as string | undefined,
      fulfillmentStatus: o.fulfillment_status as string | undefined,
      customerEmailHash: o.email
        ? crypto.createHash('sha256').update((o.email as string).toLowerCase()).digest('hex')
        : undefined,
      isFirstOrder: (o.customer as Record<string, unknown> | undefined)?.orders_count === 1,
      lineItems:    lineItems.map(li => this.normalizeLineItem(li as Record<string, unknown>)),
      tags:         o.tags ? (o.tags as string).split(', ').filter(Boolean) : [],
      note:         o.note as string | undefined,
      source:       o.source_name as string | undefined,
      orderedAt:    new Date(o.created_at as string),
      updatedAt:    new Date(o.updated_at as string),
    };
  }

  private normalizeLineItem(li: Record<string, unknown>): NormalizedLineItem {
    const allocs = (li.discount_allocations as Record<string, unknown>[] | undefined) ?? [];
    return {
      externalId:     String(li.id),
      productId:      li.product_id ? String(li.product_id) : undefined,
      variantId:      li.variant_id  ? String(li.variant_id)  : undefined,
      sku:            li.sku as string | undefined,
      title:          (li.title as string) ?? '',
      quantity:       (li.quantity as number) ?? 1,
      unitPrice:      parseFloat(String(li.price ?? '0')),
      totalPrice:     parseFloat(String(li.price ?? '0')) * ((li.quantity as number) ?? 1),
      discountAmount: allocs.reduce((s, d) => s + parseFloat(String((d as Record<string, unknown>).amount ?? '0')), 0),
    };
  }

  private normalizeProduct(p: Record<string, unknown>): NormalizedProduct {
    const variants = (p.variants as Record<string, unknown>[] | undefined) ?? [];
    const prices   = variants.map(v => parseFloat(String((v as Record<string, unknown>).price ?? '0'))).filter(n => n > 0);
    return {
      externalId:       String(p.id),
      title:            (p.title as string) ?? '',
      handle:           p.handle as string | undefined,
      status:           p.status as string | undefined,
      productType:      p.product_type as string | undefined,
      tags:             p.tags ? (p.tags as string).split(', ').filter(Boolean) : [],
      vendor:           p.vendor as string | undefined,
      totalInventory:   variants.reduce((s, v) => s + ((v as Record<string, unknown>).inventory_quantity as number ?? 0), 0),
      requiresShipping: (variants[0] as Record<string, unknown> | undefined)?.requires_shipping as boolean ?? true,
      priceMin:         prices.length ? Math.min(...prices) : undefined,
      priceMax:         prices.length ? Math.max(...prices) : undefined,
      publishedAt:      p.published_at ? new Date(p.published_at as string) : undefined,
      updatedAt:        new Date(p.updated_at as string),
    };
  }

  private normalizeCustomer(c: Record<string, unknown>): NormalizedCustomer {
    return {
      externalId:       String(c.id),
      emailHash:        c.email
        ? crypto.createHash('sha256').update((c.email as string).toLowerCase()).digest('hex')
        : crypto.createHash('sha256').update(String(c.id)).digest('hex'),
      firstName:        c.first_name as string | undefined,
      lastName:         c.last_name  as string | undefined,
      country:          (c.default_address as Record<string, string> | undefined)?.country_code,
      acceptsMarketing: (c.accepts_marketing as boolean) ?? false,
      totalSpent:       parseFloat(String(c.total_spent ?? '0')),
      orderCount:       (c.orders_count as number) ?? 0,
      updatedAt:        new Date(c.updated_at as string),
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

  private async get(creds: IntegrationCredentials, path: string): Promise<unknown> {
    const res = await fetch(`${this.baseUrl(creds)}${path}`, {
      headers: { 'X-Shopify-Access-Token': creds.accessToken!, 'Content-Type': 'application/json' },
    });
    if (!res.ok) {
      throw Object.assign(new Error(`Shopify API fout ${res.status}: ${await res.text()}`), { httpStatus: res.status });
    }
    return res.json();
  }

  private async getPaginated(creds: IntegrationCredentials, path: string): Promise<{ data: unknown; nextCursor?: string }> {
    const res = await fetch(`${this.baseUrl(creds)}${path}`, {
      headers: { 'X-Shopify-Access-Token': creds.accessToken!, 'Content-Type': 'application/json' },
    });
    if (!res.ok) {
      throw Object.assign(new Error(`Shopify API fout ${res.status}`), { httpStatus: res.status });
    }
    let nextCursor: string | undefined;
    const linkHeader = res.headers.get('link');
    if (linkHeader) {
      const match = linkHeader.match(/<([^>]+)>;\s*rel="next"/);
      if (match) nextCursor = match[1];
    }
    return { data: await res.json(), nextCursor };
  }

  private async post(creds: IntegrationCredentials, path: string, body: unknown): Promise<unknown> {
    const res = await fetch(`${this.baseUrl(creds)}${path}`, {
      method:  'POST',
      headers: { 'X-Shopify-Access-Token': creds.accessToken!, 'Content-Type': 'application/json' },
      body:    JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`Shopify POST fout ${res.status}: ${await res.text()}`);
    return res.json();
  }
}
