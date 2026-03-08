// ============================================================
// src/modules/integrations/connectors/woocommerce.connector.ts
//
// WooCommerce REST API connector.
// Authenticatie: Consumer Key + Consumer Secret (API Key)
// API: WooCommerce REST API v3
//
// Rate limits: afhankelijk van hosting, standaard geen hard limit.
// Wij limiteren zelf op 10 req/sec via Redis token bucket.
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
  NormalizedLineItem,
} from '../types/integration.types';

export class WooCommerceConnector implements IPlatformConnector {
  readonly platform = 'woocommerce' as const;

  // ── Verbinding testen ─────────────────────────────────────
  async testConnection(creds: IntegrationCredentials): Promise<ConnectionTestResult> {
    try {
      const data = await this.get(creds, '/wp-json/wc/v3/system_status');
      const env = data.environment ?? {};

      return {
        success: true,
        shopName:     env.store_id ?? creds.storeUrl,
        shopCurrency: data.settings?.currency ?? 'EUR',
        shopTimezone: env.timezone ?? 'Europe/Amsterdam',
        shopCountry:  data.settings?.country ?? 'NL',
      };
    } catch (err: any) {
      return { success: false, error: err.message ?? 'Verbinding mislukt' };
    }
  }

  // ── Orders ophalen ────────────────────────────────────────
  async fetchOrders(
    creds: IntegrationCredentials,
    options: FetchOptions
  ): Promise<PaginatedResult<NormalizedOrder>> {
    const page    = options.page ?? 1;
    const perPage = Math.min(options.limit ?? 100, 100);

    const params = new URLSearchParams({
      per_page: String(perPage),
      page:     String(page),
      orderby:  'date',
      order:    'desc',
    });

    if (options.updatedAfter) {
      params.set('modified_after', options.updatedAfter.toISOString());
    }

    const { data, total, totalPages } = await this.getWithHeaders(
      creds,
      `/wp-json/wc/v3/orders?${params}`
    );

    const items = (data as any[]).map(o => this.normalizeOrder(o));
    const hasNextPage = page < totalPages;

    return {
      items,
      hasNextPage,
      nextPage: hasNextPage ? page + 1 : undefined,
      totalCount: total,
    };
  }

  // ── Producten ophalen ─────────────────────────────────────
  async fetchProducts(
    creds: IntegrationCredentials,
    options: FetchOptions
  ): Promise<PaginatedResult<NormalizedProduct>> {
    const page    = options.page ?? 1;
    const perPage = Math.min(options.limit ?? 100, 100);

    const params = new URLSearchParams({
      per_page: String(perPage),
      page:     String(page),
    });
    if (options.updatedAfter) {
      params.set('modified_after', options.updatedAfter.toISOString());
    }

    const { data, totalPages } = await this.getWithHeaders(
      creds,
      `/wp-json/wc/v3/products?${params}`
    );

    const items = (data as any[]).map(p => this.normalizeProduct(p));
    return {
      items,
      hasNextPage: page < totalPages,
      nextPage: page < totalPages ? page + 1 : undefined,
    };
  }

  // ── Klanten ophalen ───────────────────────────────────────
  async fetchCustomers(
    creds: IntegrationCredentials,
    options: FetchOptions
  ): Promise<PaginatedResult<NormalizedCustomer>> {
    const page    = options.page ?? 1;
    const perPage = Math.min(options.limit ?? 100, 100);

    const params = new URLSearchParams({
      per_page: String(perPage),
      page:     String(page),
      orderby:  'registered_date',
    });

    const { data, totalPages } = await this.getWithHeaders(
      creds,
      `/wp-json/wc/v3/customers?${params}`
    );

    const items = (data as any[]).map(c => this.normalizeCustomer(c));
    return {
      items,
      hasNextPage: page < totalPages,
      nextPage: page < totalPages ? page + 1 : undefined,
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

  // ── Normalisatie ──────────────────────────────────────────

  private normalizeOrder(o: any): NormalizedOrder {
    return {
      externalId:        String(o.id),
      externalNumber:    `#${o.number}`,
      totalAmount:       parseFloat(o.total ?? '0'),
      subtotalAmount:    parseFloat(o.subtotal ?? '0'),
      taxAmount:         parseFloat(o.total_tax ?? '0'),
      shippingAmount:    parseFloat(o.shipping_total ?? '0'),
      discountAmount:    parseFloat(o.discount_total ?? '0'),
      currency:          o.currency ?? 'EUR',
      status:            this.mapStatus(o.status),
      financialStatus:   o.payment_method ? 'paid' : 'pending',
      fulfillmentStatus: o.status,
      customerEmailHash: o.billing?.email
        ? crypto.createHash('sha256').update(o.billing.email.toLowerCase()).digest('hex')
        : undefined,
      isFirstOrder:      undefined,
      lineItems:         (o.line_items ?? []).map((li: any) => this.normalizeLineItem(li)),
      tags:              [],
      note:              o.customer_note ?? undefined,
      source:            'web',
      orderedAt:         new Date(o.date_created),
      updatedAt:         new Date(o.date_modified ?? o.date_created),
    };
  }

  private normalizeLineItem(li: any): NormalizedLineItem {
    return {
      externalId:     String(li.id),
      productId:      li.product_id ? String(li.product_id) : undefined,
      variantId:      li.variation_id ? String(li.variation_id) : undefined,
      sku:            li.sku ?? undefined,
      title:          li.name ?? '',
      quantity:       li.quantity ?? 1,
      unitPrice:      parseFloat(li.price ?? '0'),
      totalPrice:     parseFloat(li.total ?? '0'),
      discountAmount: 0,
    };
  }

  private normalizeProduct(p: any): NormalizedProduct {
    return {
      externalId:       String(p.id),
      title:            p.name ?? '',
      handle:           p.slug ?? undefined,
      status:           p.status ?? undefined,
      productType:      p.type ?? undefined,
      tags:             p.tags?.map((t: any) => t.name) ?? [],
      vendor:           undefined,
      totalInventory:   p.stock_quantity ?? undefined,
      requiresShipping: !p.virtual,
      priceMin:         p.price ? parseFloat(p.price) : undefined,
      priceMax:         p.regular_price ? parseFloat(p.regular_price) : undefined,
      publishedAt:      p.date_created ? new Date(p.date_created) : undefined,
      updatedAt:        new Date(p.date_modified ?? p.date_created),
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
      country:          c.billing?.country ?? undefined,
      acceptsMarketing: false,
      totalSpent:       parseFloat(c.total_spent ?? '0'),
      orderCount:       c.orders_count ?? 0,
      updatedAt:        new Date(c.date_modified ?? c.date_created),
    };
  }

  private mapStatus(wooStatus: string): string {
    const map: Record<string, string> = {
      'completed':  'completed',
      'processing': 'processing',
      'on-hold':    'pending',
      'pending':    'pending',
      'cancelled':  'cancelled',
      'refunded':   'refunded',
      'failed':     'failed',
    };
    return map[wooStatus] ?? wooStatus;
  }

  // ── HTTP helpers ──────────────────────────────────────────

  private authHeader(creds: IntegrationCredentials): string {
    const encoded = Buffer.from(`${creds.apiKey}:${creds.apiSecret}`).toString('base64');
    return `Basic ${encoded}`;
  }

  private async get(creds: IntegrationCredentials, path: string): Promise<any> {
    const url = `${creds.storeUrl}${path}`;
    const res = await fetch(url, {
      headers: {
        'Authorization': this.authHeader(creds),
        'Content-Type':  'application/json',
      },
    });

    if (!res.ok) {
      const text = await res.text();
      throw Object.assign(
        new Error(`WooCommerce API fout ${res.status}: ${text}`),
        { httpStatus: res.status }
      );
    }

    return res.json();
  }

  private async getWithHeaders(
    creds: IntegrationCredentials,
    path: string
  ): Promise<{ data: any; total: number; totalPages: number }> {
    const url = `${creds.storeUrl}${path}`;
    const res = await fetch(url, {
      headers: {
        'Authorization': this.authHeader(creds),
        'Content-Type':  'application/json',
      },
    });

    if (!res.ok) {
      throw Object.assign(
        new Error(`WooCommerce API fout ${res.status}`),
        { httpStatus: res.status }
      );
    }

    const total      = parseInt(res.headers.get('x-wp-total') ?? '0');
    const totalPages = parseInt(res.headers.get('x-wp-totalpages') ?? '1');
    const data       = await res.json();

    return { data, total, totalPages };
  }
}
