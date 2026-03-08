// ============================================================
// src/modules/integrations/connectors/lightspeed.connector.ts
//
// Lightspeed eCom (C-Series) REST API connector.
// Authenticatie: OAuth2
// API: https://developers.lightspeedhq.com/ecom/
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

export class LightspeedConnector implements IPlatformConnector {
  readonly platform = 'lightspeed' as const;

  async testConnection(creds: IntegrationCredentials): Promise<ConnectionTestResult> {
    try {
      const data = await this.get(creds, '/api/shop.json');
      const shop = data.shop ?? {};
      return {
        success:      true,
        shopName:     shop.name,
        shopCurrency: shop.mainCurrency,
        shopCountry:  shop.country,
      };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  }

  async fetchOrders(
    creds: IntegrationCredentials,
    options: FetchOptions
  ): Promise<PaginatedResult<NormalizedOrder>> {
    const page  = options.page ?? 1;
    const limit = Math.min(options.limit ?? 50, 50);
    const params = new URLSearchParams({ page: String(page), limit: String(limit) });
    if (options.updatedAfter) {
      params.set('updated_at_min', options.updatedAfter.toISOString());
    }

    const data = await this.get(creds, `/api/orders.json?${params}`);
    const orders = Array.isArray(data.orders) ? data.orders : (data.order ? [data.order] : []);
    const count = parseInt(data.count ?? orders.length);

    const items = orders.map((o: any) => this.normalizeOrder(o));
    const hasNextPage = (page * limit) < count;

    return { items, hasNextPage, nextPage: hasNextPage ? page + 1 : undefined, totalCount: count };
  }

  async fetchProducts(
    creds: IntegrationCredentials,
    options: FetchOptions
  ): Promise<PaginatedResult<NormalizedProduct>> {
    const page  = options.page ?? 1;
    const limit = Math.min(options.limit ?? 50, 50);
    const data  = await this.get(creds, `/api/products.json?page=${page}&limit=${limit}`);
    const prods = Array.isArray(data.products) ? data.products : (data.product ? [data.product] : []);
    const count = parseInt(data.count ?? prods.length);
    const items = prods.map((p: any) => this.normalizeProduct(p));
    return { items, hasNextPage: (page * limit) < count, nextPage: page + 1 };
  }

  async fetchCustomers(
    creds: IntegrationCredentials,
    options: FetchOptions
  ): Promise<PaginatedResult<NormalizedCustomer>> {
    const page  = options.page ?? 1;
    const limit = Math.min(options.limit ?? 50, 50);
    const data  = await this.get(creds, `/api/customers.json?page=${page}&limit=${limit}`);
    const custs = Array.isArray(data.customers) ? data.customers : (data.customer ? [data.customer] : []);
    const count = parseInt(data.count ?? custs.length);
    const items = custs.map((c: any) => this.normalizeCustomer(c));
    return { items, hasNextPage: (page * limit) < count, nextPage: page + 1 };
  }

  async refreshAccessToken(creds: IntegrationCredentials): Promise<TokenRefreshResult> {
    const res = await fetch('https://cloud.lightspeedapp.com/oauth/access_token.php', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type:    'refresh_token',
        client_id:     process.env.LIGHTSPEED_CLIENT_ID!,
        client_secret: process.env.LIGHTSPEED_CLIENT_SECRET!,
        refresh_token: creds.refreshToken!,
      }),
    });
    if (!res.ok) throw new Error('Lightspeed token refresh mislukt');
    const d = await res.json();
    return {
      accessToken:  d.access_token,
      refreshToken: d.refresh_token,
      expiresAt:    new Date(Date.now() + d.expires_in * 1000),
    };
  }

  private normalizeOrder(o: any): NormalizedOrder {
    return {
      externalId:     String(o.id),
      externalNumber: o.number ? `#${o.number}` : undefined,
      totalAmount:    parseFloat(o.priceIncl ?? o.price ?? '0'),
      subtotalAmount: parseFloat(o.priceExcl ?? '0'),
      taxAmount:      parseFloat(o.taxAmount ?? '0'),
      shippingAmount: parseFloat(o.shipmentPrice ?? '0'),
      discountAmount: parseFloat(o.discountAmount ?? '0'),
      currency:       o.currency ?? 'EUR',
      status:         o.status ?? 'pending',
      lineItems:      (o.orderProducts?.orderProduct ?? []).map((li: any): NormalizedLineItem => ({
        externalId: String(li.id),
        productId:  li.productId ? String(li.productId) : undefined,
        sku:        li.articleCode ?? undefined,
        title:      li.productTitle ?? '',
        quantity:   parseInt(li.quantityOrdered ?? '1'),
        unitPrice:  parseFloat(li.priceIncl ?? '0'),
        totalPrice: parseFloat(li.priceIncl ?? '0') * parseInt(li.quantityOrdered ?? '1'),
        discountAmount: 0,
      })),
      orderedAt: new Date(o.createdAt ?? o.date),
      updatedAt: new Date(o.updatedAt ?? o.createdAt),
    };
  }

  private normalizeProduct(p: any): NormalizedProduct {
    return {
      externalId: String(p.id),
      title:      p.title ?? '',
      handle:     p.url ?? undefined,
      status:     p.isVisible ? 'active' : 'draft',
      updatedAt:  new Date(p.updatedAt ?? p.createdAt),
    };
  }

  private normalizeCustomer(c: any): NormalizedCustomer {
    const email = c.email ?? '';
    return {
      externalId:  String(c.id),
      emailHash:   crypto.createHash('sha256').update(email.toLowerCase()).digest('hex'),
      firstName:   c.firstname ?? undefined,
      lastName:    c.lastname ?? undefined,
      country:     c.country ?? undefined,
      totalSpent:  parseFloat(c.totalSpent ?? '0'),
      orderCount:  parseInt(c.totalOrders ?? '0'),
      updatedAt:   new Date(c.updatedAt ?? c.createdAt),
    };
  }

  private async get(creds: IntegrationCredentials, path: string): Promise<any> {
    const base = creds.storeUrl ?? `https://api.webshopapp.com/${creds.shopDomain}`;
    const res  = await fetch(`${base}${path}`, {
      headers: { 'Authorization': `Bearer ${creds.accessToken}` },
    });
    if (!res.ok) throw new Error(`Lightspeed API fout ${res.status}`);
    return res.json();
  }
}


// ============================================================
// src/modules/integrations/connectors/bigcommerce.connector.ts
//
// BigCommerce V2/V3 API connector.
// Authenticatie: API Key (store hash + access token)
// ============================================================

export class BigCommerceConnector implements IPlatformConnector {
  readonly platform = 'bigcommerce' as const;

  async testConnection(creds: IntegrationCredentials): Promise<ConnectionTestResult> {
    try {
      const storeHash = this.extractStoreHash(creds);
      const data = await this.get(creds, storeHash, '/v2/store');
      return {
        success:      true,
        shopName:     data.name,
        shopCurrency: data.currency,
        shopCountry:  data.country_code,
        shopTimezone: data.timezone?.name,
      };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  }

  async fetchOrders(
    creds: IntegrationCredentials,
    options: FetchOptions
  ): Promise<PaginatedResult<NormalizedOrder>> {
    const storeHash = this.extractStoreHash(creds);
    const page  = options.page ?? 1;
    const limit = Math.min(options.limit ?? 250, 250);
    const params = new URLSearchParams({ page: String(page), limit: String(limit) });
    if (options.updatedAfter) {
      params.set('min_date_modified', options.updatedAfter.toISOString());
    }

    const orders = await this.get(creds, storeHash, `/v2/orders?${params}`);
    const items  = (Array.isArray(orders) ? orders : []).map((o: any) => this.normalizeOrder(o));

    return {
      items,
      hasNextPage: items.length === limit,
      nextPage: items.length === limit ? page + 1 : undefined,
    };
  }

  async fetchProducts(
    creds: IntegrationCredentials,
    options: FetchOptions
  ): Promise<PaginatedResult<NormalizedProduct>> {
    const storeHash = this.extractStoreHash(creds);
    const page  = options.page ?? 1;
    const limit = Math.min(options.limit ?? 250, 250);
    const prods = await this.get(creds, storeHash, `/v3/catalog/products?page=${page}&limit=${limit}`);
    const items = ((prods.data ?? []) as any[]).map(p => this.normalizeProduct(p));
    return {
      items,
      hasNextPage: !!prods.meta?.pagination?.links?.next,
      nextPage: items.length === limit ? page + 1 : undefined,
    };
  }

  async fetchCustomers(
    creds: IntegrationCredentials,
    options: FetchOptions
  ): Promise<PaginatedResult<NormalizedCustomer>> {
    const storeHash = this.extractStoreHash(creds);
    const page  = options.page ?? 1;
    const limit = Math.min(options.limit ?? 250, 250);
    const custs = await this.get(creds, storeHash, `/v3/customers?page=${page}&limit=${limit}`);
    const items = ((custs.data ?? []) as any[]).map(c => this.normalizeCustomer(c));
    return {
      items,
      hasNextPage: !!custs.meta?.pagination?.links?.next,
      nextPage: items.length === limit ? page + 1 : undefined,
    };
  }

  private normalizeOrder(o: any): NormalizedOrder {
    return {
      externalId:        String(o.id),
      externalNumber:    `#${o.id}`,
      totalAmount:       parseFloat(o.total_inc_tax ?? '0'),
      subtotalAmount:    parseFloat(o.subtotal_inc_tax ?? '0'),
      taxAmount:         parseFloat(o.total_tax ?? '0'),
      shippingAmount:    parseFloat(o.shipping_cost_inc_tax ?? '0'),
      discountAmount:    parseFloat(o.discount_amount ?? '0'),
      currency:          o.currency_code ?? 'USD',
      status:            o.status ?? 'unknown',
      lineItems:         [],   // aparte call nodig voor line items
      orderedAt:         new Date(o.date_created),
      updatedAt:         new Date(o.date_modified ?? o.date_created),
    };
  }

  private normalizeProduct(p: any): NormalizedProduct {
    return {
      externalId:    String(p.id),
      title:         p.name ?? '',
      handle:        p.custom_url?.url ?? undefined,
      status:        p.is_visible ? 'active' : 'draft',
      productType:   p.type ?? undefined,
      vendor:        p.brand_id ? String(p.brand_id) : undefined,
      totalInventory: p.inventory_level,
      priceMin:      p.price ? parseFloat(p.price) : undefined,
      priceMax:      p.price ? parseFloat(p.price) : undefined,
      updatedAt:     new Date(p.date_modified ?? p.date_created),
    };
  }

  private normalizeCustomer(c: any): NormalizedCustomer {
    const email = c.email ?? '';
    return {
      externalId:  String(c.id),
      emailHash:   crypto.createHash('sha256').update(email.toLowerCase()).digest('hex'),
      firstName:   c.first_name ?? undefined,
      lastName:    c.last_name ?? undefined,
      totalSpent:  0,
      orderCount:  0,
      updatedAt:   new Date(c.date_modified ?? c.date_created),
    };
  }

  private extractStoreHash(creds: IntegrationCredentials): string {
    // storeUrl formaat: 'abc123' of 'https://api.bigcommerce.com/stores/abc123'
    const url = creds.storeUrl ?? '';
    const match = url.match(/stores\/([a-z0-9]+)/);
    return match ? match[1] : url.replace(/[^a-z0-9]/gi, '');
  }

  private async get(creds: IntegrationCredentials, storeHash: string, path: string): Promise<any> {
    const res = await fetch(`https://api.bigcommerce.com/stores/${storeHash}${path}`, {
      headers: {
        'X-Auth-Token': creds.accessToken ?? creds.apiKey!,
        'Content-Type': 'application/json',
        'Accept':       'application/json',
      },
    });
    if (!res.ok) throw new Error(`BigCommerce API fout ${res.status}`);
    return res.json();
  }
}


// ============================================================
// src/modules/integrations/connectors/bolcom.connector.ts
//
// Bol.com Retailer API connector.
// Authenticatie: OAuth2 (Client Credentials)
// API: https://developers.bol.com
// ============================================================

export class BolcomConnector implements IPlatformConnector {
  readonly platform = 'bolcom' as const;

  async testConnection(creds: IntegrationCredentials): Promise<ConnectionTestResult> {
    try {
      const token = await this.getAccessToken(creds);
      const data  = await this.apiGet(token, '/retailer/orders?status=ALL&fulfilment-method=FBR&page=1');
      return {
        success:      true,
        shopName:     'Bol.com Retailer',
        shopCurrency: 'EUR',
        shopCountry:  'NL',
      };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  }

  async fetchOrders(
    creds: IntegrationCredentials,
    options: FetchOptions
  ): Promise<PaginatedResult<NormalizedOrder>> {
    const token = await this.getAccessToken(creds);
    const page  = options.page ?? 1;

    const data  = await this.apiGet(
      token,
      `/retailer/orders?status=ALL&fulfilment-method=FBR&page=${page}`
    );

    const orders = data.orders ?? [];
    const items  = orders.map((o: any) => this.normalizeOrder(o));

    return {
      items,
      hasNextPage: orders.length === 50,  // bol.com max 50/pagina
      nextPage:    orders.length === 50 ? page + 1 : undefined,
    };
  }

  async fetchProducts(
    creds: IntegrationCredentials,
    options: FetchOptions
  ): Promise<PaginatedResult<NormalizedProduct>> {
    const token = await this.getAccessToken(creds);
    const page  = options.page ?? 1;
    const data  = await this.apiGet(token, `/retailer/inventory?page=${page}`);
    const items = (data.inventory ?? []).map((p: any) => this.normalizeProduct(p));
    return { items, hasNextPage: items.length === 50, nextPage: items.length === 50 ? page + 1 : undefined };
  }

  async fetchCustomers(): Promise<PaginatedResult<NormalizedCustomer>> {
    // Bol.com stelt geen klantgegevens beschikbaar via API (privacybescherming)
    return { items: [], hasNextPage: false };
  }

  async refreshAccessToken(creds: IntegrationCredentials): Promise<import('../types/integration.types').TokenRefreshResult> {
    const token = await this.getAccessToken(creds);
    return {
      accessToken: token,
      expiresAt:   new Date(Date.now() + 290_000),  // ~5 min
    };
  }

  private async getAccessToken(creds: IntegrationCredentials): Promise<string> {
    const encoded = Buffer.from(`${creds.apiKey}:${creds.apiSecret}`).toString('base64');
    const res = await fetch('https://login.bol.com/token?grant_type=client_credentials', {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${encoded}`,
        'Accept':        'application/json',
      },
    });
    if (!res.ok) throw new Error('Bol.com token ophalen mislukt');
    const d = await res.json();
    return d.access_token;
  }

  private normalizeOrder(o: any): NormalizedOrder {
    return {
      externalId:     String(o.orderId),
      externalNumber: o.orderId,
      totalAmount:    (o.orderItems ?? []).reduce(
        (s: number, i: any) => s + parseFloat(i.unitPrice ?? '0') * (i.quantity ?? 1), 0
      ),
      subtotalAmount: 0,
      taxAmount:      0,
      shippingAmount: 0,
      discountAmount: 0,
      currency:       'EUR',
      status:         'completed',
      lineItems:      (o.orderItems ?? []).map((i: any): NormalizedLineItem => ({
        externalId:     String(i.orderItemId),
        sku:            i.ean ?? undefined,
        title:          i.product?.title ?? '',
        quantity:       i.quantity ?? 1,
        unitPrice:      parseFloat(i.unitPrice ?? '0'),
        totalPrice:     parseFloat(i.unitPrice ?? '0') * (i.quantity ?? 1),
        discountAmount: 0,
      })),
      orderedAt: new Date(o.orderPlacedDateTime),
      updatedAt: new Date(o.orderPlacedDateTime),
    };
  }

  private normalizeProduct(p: any): NormalizedProduct {
    return {
      externalId:    p.ean ?? String(p.id),
      title:         p.title ?? '',
      totalInventory: parseInt(p.stock?.correctedStock ?? '0'),
      updatedAt:     new Date(),
    };
  }

  private async apiGet(token: string, path: string): Promise<any> {
    const res = await fetch(`https://api.bol.com${path}`, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Accept':        'application/vnd.retailer.v10+json',
      },
    });
    if (!res.ok) throw new Error(`Bol.com API fout ${res.status}`);
    return res.json();
  }
}
