// ============================================================
// src/modules/integrations/connectors/lightspeed-bigcommerce-bolcom.connectors.ts
//
// Fixes t.o.v. origineel:
//   [BOLCOM] Token caching via Redis (voorkomt rate limiting bij 500+ users)
//   [BOLCOM] Echte retailer naam ophalen via /retailer/account
//   [BOLCOM] FBB + FBR orders parallel fetchen
//   [BOLCOM] Betere error logging met status code
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
import { cache } from '../../../infrastructure/cache/redis';

// ============================================================
// LIGHTSPEED
// ============================================================
export class LightspeedConnector implements IPlatformConnector {
  readonly platform = 'lightspeed' as const;

  async testConnection(creds: IntegrationCredentials): Promise<ConnectionTestResult> {
    try {
      const data = await this.get(creds, '/api/shop.json') as Record<string, Record<string, string>>;
      const shop = data.shop ?? {};
      return { success: true, shopName: shop.name, shopCurrency: shop.mainCurrency, shopCountry: shop.country };
    } catch (err: unknown) {
      return { success: false, error: err instanceof Error ? err.message : 'Verbinding mislukt' };
    }
  }

  async fetchOrders(creds: IntegrationCredentials, options: FetchOptions): Promise<PaginatedResult<NormalizedOrder>> {
    const page  = options.page ?? 1;
    const limit = Math.min(options.limit ?? 50, 50);
    const params = new URLSearchParams({ page: String(page), limit: String(limit) });
    if (options.updatedAfter) params.set('updated_at_min', options.updatedAfter.toISOString());

    const data   = await this.get(creds, `/api/orders.json?${params}`) as Record<string, unknown>;
    const orders = Array.isArray(data.orders) ? data.orders as Record<string, unknown>[]
                 : data.order ? [data.order as Record<string, unknown>] : [];
    const count  = parseInt(String(data.count ?? orders.length));
    const items  = orders.map(o => this.normalizeOrder(o));
    const hasNextPage = (page * limit) < count;
    return { items, hasNextPage, nextPage: hasNextPage ? page + 1 : undefined, totalCount: count };
  }

  async fetchProducts(creds: IntegrationCredentials, options: FetchOptions): Promise<PaginatedResult<NormalizedProduct>> {
    const page  = options.page ?? 1;
    const limit = Math.min(options.limit ?? 50, 50);
    const data  = await this.get(creds, `/api/products.json?page=${page}&limit=${limit}`) as Record<string, unknown>;
    const prods = Array.isArray(data.products) ? data.products as Record<string, unknown>[]
                : data.product ? [data.product as Record<string, unknown>] : [];
    const count = parseInt(String(data.count ?? prods.length));
    return { items: prods.map(p => this.normalizeProduct(p)), hasNextPage: (page * limit) < count, nextPage: page + 1 };
  }

  async fetchCustomers(creds: IntegrationCredentials, options: FetchOptions): Promise<PaginatedResult<NormalizedCustomer>> {
    const page  = options.page ?? 1;
    const limit = Math.min(options.limit ?? 50, 50);
    const data  = await this.get(creds, `/api/customers.json?page=${page}&limit=${limit}`) as Record<string, unknown>;
    const custs = Array.isArray(data.customers) ? data.customers as Record<string, unknown>[]
                : data.customer ? [data.customer as Record<string, unknown>] : [];
    const count = parseInt(String(data.count ?? custs.length));
    return { items: custs.map(c => this.normalizeCustomer(c)), hasNextPage: (page * limit) < count, nextPage: page + 1 };
  }

  async refreshAccessToken(creds: IntegrationCredentials): Promise<TokenRefreshResult> {
    const res = await fetch('https://cloud.lightspeedapp.com/oauth/access_token.php', {
      method:  'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type:    'refresh_token',
        client_id:     process.env.LIGHTSPEED_CLIENT_ID!,
        client_secret: process.env.LIGHTSPEED_CLIENT_SECRET!,
        refresh_token: creds.refreshToken!,
      }),
    });
    if (!res.ok) throw new Error('Lightspeed token refresh mislukt');
    const d = await res.json() as { access_token: string; refresh_token: string; expires_in: number };
    return { accessToken: d.access_token, refreshToken: d.refresh_token, expiresAt: new Date(Date.now() + d.expires_in * 1000) };
  }

  private normalizeOrder(o: Record<string, unknown>): NormalizedOrder {
    const orderProducts = (o.orderProducts as Record<string, unknown> | undefined);
    const lineItemsRaw  = Array.isArray(orderProducts?.orderProduct)
      ? orderProducts!.orderProduct as Record<string, unknown>[]
      : [];
    return {
      externalId:     String(o.id),
      externalNumber: o.number ? `#${o.number}` : undefined,
      totalAmount:    parseFloat(String(o.priceIncl ?? o.price ?? '0')),
      subtotalAmount: parseFloat(String(o.priceExcl ?? '0')),
      taxAmount:      parseFloat(String(o.taxAmount ?? '0')),
      shippingAmount: parseFloat(String(o.shipmentPrice ?? '0')),
      discountAmount: parseFloat(String(o.discountAmount ?? '0')),
      currency:       String(o.currency ?? 'EUR'),
      status:         String(o.status ?? 'pending'),
      lineItems: lineItemsRaw.map((li): NormalizedLineItem => ({
        externalId:    String(li.id),
        productId:     li.productId ? String(li.productId) : undefined,
        sku:           li.articleCode as string | undefined,
        title:         String(li.productTitle ?? ''),
        quantity:      parseInt(String(li.quantityOrdered ?? '1')),
        unitPrice:     parseFloat(String(li.priceIncl ?? '0')),
        totalPrice:    parseFloat(String(li.priceIncl ?? '0')) * parseInt(String(li.quantityOrdered ?? '1')),
        discountAmount: 0,
      })),
      orderedAt: new Date(String(o.createdAt ?? o.date)),
      updatedAt: new Date(String(o.updatedAt ?? o.createdAt)),
    };
  }

  private normalizeProduct(p: Record<string, unknown>): NormalizedProduct {
    return {
      externalId: String(p.id),
      title:      String(p.title ?? ''),
      status:     p.isVisible ? 'active' : 'draft',
      updatedAt:  new Date(String(p.updatedAt ?? p.createdAt)),
    };
  }

  private normalizeCustomer(c: Record<string, unknown>): NormalizedCustomer {
    const email = String(c.email ?? '');
    return {
      externalId:  String(c.id),
      emailHash:   crypto.createHash('sha256').update(email.toLowerCase()).digest('hex'),
      firstName:   c.firstname as string | undefined,
      lastName:    c.lastname  as string | undefined,
      country:     c.country   as string | undefined,
      totalSpent:  parseFloat(String(c.totalSpent ?? '0')),
      orderCount:  parseInt(String(c.totalOrders ?? '0')),
      updatedAt:   new Date(String(c.updatedAt ?? c.createdAt)),
    };
  }

  private async get(creds: IntegrationCredentials, path: string): Promise<unknown> {
    const base = creds.storeUrl ?? `https://api.webshopapp.com/${creds.shopDomain}`;
    const res  = await fetch(`${base}${path}`, { headers: { 'Authorization': `Bearer ${creds.accessToken}` } });
    if (!res.ok) throw new Error(`Lightspeed API fout ${res.status}`);
    return res.json();
  }
}

// ============================================================
// BIGCOMMERCE
// ============================================================
export class BigCommerceConnector implements IPlatformConnector {
  readonly platform = 'bigcommerce' as const;

  async testConnection(creds: IntegrationCredentials): Promise<ConnectionTestResult> {
    try {
      const storeHash = this.extractStoreHash(creds);
      const data = await this.get(creds, storeHash, '/v2/store') as Record<string, unknown>;
      return { success: true, shopName: data.name as string, shopCurrency: data.currency as string, shopCountry: data.country_code as string };
    } catch (err: unknown) {
      return { success: false, error: err instanceof Error ? err.message : 'Verbinding mislukt' };
    }
  }

  async fetchOrders(creds: IntegrationCredentials, options: FetchOptions): Promise<PaginatedResult<NormalizedOrder>> {
    const storeHash = this.extractStoreHash(creds);
    const page  = options.page ?? 1;
    const limit = Math.min(options.limit ?? 250, 250);
    const params = new URLSearchParams({ page: String(page), limit: String(limit) });
    if (options.updatedAfter) params.set('min_date_modified', options.updatedAfter.toISOString());
    const orders = await this.get(creds, storeHash, `/v2/orders?${params}`) as Record<string, unknown>[];
    const items  = (Array.isArray(orders) ? orders : []).map(o => this.normalizeOrder(o));
    return { items, hasNextPage: items.length === limit, nextPage: items.length === limit ? page + 1 : undefined };
  }

  async fetchProducts(creds: IntegrationCredentials, options: FetchOptions): Promise<PaginatedResult<NormalizedProduct>> {
    const storeHash = this.extractStoreHash(creds);
    const page  = options.page ?? 1;
    const limit = Math.min(options.limit ?? 250, 250);
    const prods = await this.get(creds, storeHash, `/v3/catalog/products?page=${page}&limit=${limit}`) as { data?: Record<string, unknown>[]; meta?: Record<string, unknown> };
    const items = (prods.data ?? []).map(p => this.normalizeProduct(p));
    return { items, hasNextPage: items.length === limit, nextPage: items.length === limit ? page + 1 : undefined };
  }

  async fetchCustomers(creds: IntegrationCredentials, options: FetchOptions): Promise<PaginatedResult<NormalizedCustomer>> {
    const storeHash = this.extractStoreHash(creds);
    const page  = options.page ?? 1;
    const limit = Math.min(options.limit ?? 250, 250);
    const custs = await this.get(creds, storeHash, `/v3/customers?page=${page}&limit=${limit}`) as { data?: Record<string, unknown>[] };
    const items = (custs.data ?? []).map(c => this.normalizeCustomer(c));
    return { items, hasNextPage: items.length === limit, nextPage: items.length === limit ? page + 1 : undefined };
  }

  private normalizeOrder(o: Record<string, unknown>): NormalizedOrder {
    return {
      externalId:     String(o.id),
      externalNumber: `#${o.id}`,
      totalAmount:    parseFloat(String(o.total_inc_tax ?? '0')),
      subtotalAmount: parseFloat(String(o.subtotal_inc_tax ?? '0')),
      taxAmount:      parseFloat(String(o.total_tax ?? '0')),
      shippingAmount: parseFloat(String(o.shipping_cost_inc_tax ?? '0')),
      discountAmount: parseFloat(String(o.discount_amount ?? '0')),
      currency:       String(o.currency_code ?? 'USD'),
      status:         String(o.status ?? 'unknown'),
      lineItems:      [],
      orderedAt:      new Date(String(o.date_created)),
      updatedAt:      new Date(String(o.date_modified ?? o.date_created)),
    };
  }

  private normalizeProduct(p: Record<string, unknown>): NormalizedProduct {
    return {
      externalId:     String(p.id),
      title:          String(p.name ?? ''),
      status:         p.is_visible ? 'active' : 'draft',
      totalInventory: p.inventory_level as number | undefined,
      priceMin:       p.price ? parseFloat(String(p.price)) : undefined,
      priceMax:       p.price ? parseFloat(String(p.price)) : undefined,
      updatedAt:      new Date(String(p.date_modified ?? p.date_created)),
    };
  }

  private normalizeCustomer(c: Record<string, unknown>): NormalizedCustomer {
    const email = String(c.email ?? '');
    return {
      externalId: String(c.id),
      emailHash:  crypto.createHash('sha256').update(email.toLowerCase()).digest('hex'),
      firstName:  c.first_name as string | undefined,
      lastName:   c.last_name  as string | undefined,
      totalSpent: 0,
      orderCount: 0,
      updatedAt:  new Date(String(c.date_modified ?? c.date_created)),
    };
  }

  private extractStoreHash(creds: IntegrationCredentials): string {
    const url   = creds.storeUrl ?? '';
    const match = url.match(/stores\/([a-z0-9]+)/);
    return match ? match[1] : url.replace(/[^a-z0-9]/gi, '');
  }

  private async get(creds: IntegrationCredentials, storeHash: string, path: string): Promise<unknown> {
    const res = await fetch(`https://api.bigcommerce.com/stores/${storeHash}${path}`, {
      headers: {
        'X-Auth-Token':  creds.accessToken ?? creds.apiKey!,
        'Content-Type':  'application/json',
        'Accept':        'application/json',
      },
    });
    if (!res.ok) throw new Error(`BigCommerce API fout ${res.status}`);
    return res.json();
  }
}
// ============================================================
// VERVANG de volledige BolcomConnector klasse in:
// saas-platform/src/modules/integrations/connectors/lightspeed-bigcommerce-bolcom.connectors.ts
//
// Gebaseerd op officiële bol.com Retailer API v10 documentatie:
// - Orders API: status=ALL geeft alleen laatste 48 uur
// - Shipments API: geeft verzonden orders tot 3 maanden terug
// - latest-change-date: haal per dag historische orders op
// - unitPrice in order detail is een object {amount, currency}
// ============================================================

export class BolcomConnector implements IPlatformConnector {
  readonly platform = 'bolcom' as const;

  // ── Verbinding testen ─────────────────────────────────────
  async testConnection(creds: IntegrationCredentials): Promise<ConnectionTestResult> {
    try {
      const token = await this.getAccessToken(creds);
      try {
        const account = await this.apiGet(token, '/retailer/retailers/me') as Record<string, unknown>;
        const shopName = String(account.displayName ?? account.accountName ?? 'Bol.com Retailer');
        return { success: true, shopName, shopCurrency: 'EUR', shopCountry: 'NL' };
      } catch {
        return { success: true, shopName: 'Bol.com Retailer', shopCurrency: 'EUR', shopCountry: 'NL' };
      }
    } catch (err: unknown) {
      return { success: false, error: err instanceof Error ? err.message : 'Verbinding mislukt' };
    }
  }

  // ── Orders ophalen ────────────────────────────────────────
  // Strategie:
  // - full_sync: gebruik Shipments API (3 mnd geschiedenis) + orders van vandaag/gisteren
  // - incremental: gebruik Orders API met change-interval-minute
  async fetchOrders(creds: IntegrationCredentials, options: FetchOptions): Promise<PaginatedResult<NormalizedOrder>> {
    const token = await this.getAccessToken(creds);
    const page  = options.page ?? 1;

    // Bij full sync of geen updatedAfter: gebruik Shipments API voor historische data
    if (!options.updatedAfter || options.jobType === 'full_sync') {
      return this.fetchOrdersViaShipments(token, page);
    }

    // Incremental: haal recente orders op via Orders API
    return this.fetchRecentOrders(token, page, options.updatedAfter);
  }

  // Shipments API — geeft orders tot 3 maanden terug MET correcte prijzen
  private async fetchOrdersViaShipments(token: string, page: number): Promise<PaginatedResult<NormalizedOrder>> {
    const data = await this.apiGet(
      token,
      `/retailer/shipments?fulfilment-method=ALL&page=${page}`
    ) as { shipments?: Record<string, unknown>[] };

    const shipments = data.shipments ?? [];
    const orders    = shipments.map(s => this.normalizeShipment(s));

    return {
      items:       orders,
      hasNextPage: shipments.length === 50,
      nextPage:    shipments.length === 50 ? page + 1 : undefined,
    };
  }

  // Orders API — recente open + afgehandelde orders (laatste 48 uur)
  private async fetchRecentOrders(token: string, page: number, since: Date): Promise<PaginatedResult<NormalizedOrder>> {
    // Bereken minuten geleden voor change-interval-minute
    const minutesAgo = Math.ceil((Date.now() - since.getTime()) / 60000);
    // Max 2880 minuten (48 uur) — dat is de limiet van de API
    const interval   = Math.min(minutesAgo + 5, 2880);

    const [fbrData, fbbData] = await Promise.allSettled([
      this.apiGet(token, `/retailer/orders?status=ALL&fulfilment-method=FBR&change-interval-minute=${interval}&page=${page}`) as Promise<{ orders?: Record<string, unknown>[] }>,
      this.apiGet(token, `/retailer/orders?status=ALL&fulfilment-method=FBB&change-interval-minute=${interval}&page=${page}`) as Promise<{ orders?: Record<string, unknown>[] }>,
    ]);

    const fbrOrders = fbrData.status === 'fulfilled' ? (fbrData.value.orders ?? []) : [];
    const fbbOrders = fbbData.status === 'fulfilled' ? (fbbData.value.orders ?? []) : [];

    // Dedupliceer op orderId
    const seen = new Set<string>();
    const all: Record<string, unknown>[] = [];
    for (const o of [...fbrOrders, ...fbbOrders]) {
      const id = String(o.orderId);
      if (!seen.has(id)) { seen.add(id); all.push(o); }
    }

    // Haal detail op per order voor correcte prijzen
    const detailed = await Promise.allSettled(
      all.map(o => this.apiGet(token, `/retailer/orders/${o.orderId}`) as Promise<Record<string, unknown>>)
    );

    const items = detailed
      .filter((r): r is PromiseFulfilledResult<Record<string, unknown>> => r.status === 'fulfilled')
      .map(r => this.normalizeOrderDetail(r.value));

    const hasNextPage = fbrOrders.length === 50 || fbbOrders.length === 50;
    return { items, hasNextPage, nextPage: hasNextPage ? page + 1 : undefined };
  }

  // ── Producten / aanbod ophalen ────────────────────────────
  async fetchProducts(creds: IntegrationCredentials, options: FetchOptions): Promise<PaginatedResult<NormalizedProduct>> {
    const token = await this.getAccessToken(creds);
    const page  = options.page ?? 1;
    const data  = await this.apiGet(token, `/retailer/inventory?page=${page}`) as {
      inventory?: Record<string, unknown>[];
    };
    const items = (data.inventory ?? []).map(p => this.normalizeProduct(p));
    return {
      items,
      hasNextPage: items.length === 50,
      nextPage:    items.length === 50 ? page + 1 : undefined,
    };
  }

  async fetchCustomers(): Promise<PaginatedResult<NormalizedCustomer>> {
    // Bol.com stelt geen klantgegevens beschikbaar via API
    return { items: [], hasNextPage: false };
  }

  async refreshAccessToken(creds: IntegrationCredentials): Promise<TokenRefreshResult> {
    const token = await this.getAccessToken(creds);
    return { accessToken: token, expiresAt: new Date(Date.now() + 270_000) };
  }

  // ── Token ophalen met Redis caching ───────────────────────
  private async getAccessToken(creds: IntegrationCredentials): Promise<string> {
    const cacheKey = `bolcom:token:${creds.integrationId}`;
    try {
      const { cache } = await import('../../../infrastructure/cache/redis');
      const cached = await cache.get(cacheKey);
      if (cached) return cached;
    } catch { /* cache miss */ }

    const encoded = Buffer.from(`${creds.apiKey}:${creds.apiSecret}`).toString('base64');
    const res = await fetch('https://login.bol.com/token?grant_type=client_credentials', {
      method:  'POST',
      headers: { 'Authorization': `Basic ${encoded}`, 'Accept': 'application/json' },
    });
    if (!res.ok) throw new Error(`Bol.com token mislukt: ${res.status}`);
    const d = await res.json() as { access_token: string };

    try {
      const { cache } = await import('../../../infrastructure/cache/redis');
      await cache.set(cacheKey, d.access_token, 270);
    } catch { /* cache write mislukt */ }

    return d.access_token;
  }

  // ── Shipment normalisatie (historische data) ──────────────
  // Shipment response bevat: shipmentId, orderId, shipmentDate, shipmentItems[]
  // shipmentItem bevat: orderItemId, ean, title, quantity, unitPrice {amount, currency}
  private normalizeShipment(s: Record<string, unknown>): NormalizedOrder {
    const items = (s.shipmentItems as Record<string, unknown>[] | undefined) ?? [];

    const lineItems: NormalizedLineItem[] = items.map((item): NormalizedLineItem => {
      const qty     = Number(item.quantity ?? 1);
      const unitP   = this.parsePrice(item.unitPrice);
      return {
        externalId:    String(item.orderItemId ?? item.shipmentItemId ?? Math.random()),
        productId:     item.ean ? String(item.ean) : undefined,
        sku:           item.ean ? String(item.ean) : undefined,
        title:         String((item.product as Record<string, unknown> | undefined)?.title ?? item.title ?? ''),
        quantity:      qty,
        unitPrice:     unitP,
        totalPrice:    unitP * qty,
        discountAmount: 0,
      };
    });

    const totalAmount = lineItems.reduce((s, li) => s + li.totalPrice, 0);
    const shipDate    = s.shipmentDate ? new Date(String(s.shipmentDate)) : new Date();

    return {
      externalId:     String(s.orderId ?? s.shipmentId),
      externalNumber: String(s.orderId ?? s.shipmentId),
      totalAmount,
      subtotalAmount: totalAmount,
      taxAmount:      0,
      shippingAmount: 0,
      discountAmount: 0,
      currency:       'EUR',
      status:         'completed',
      lineItems,
      orderedAt:      shipDate,
      updatedAt:      shipDate,
    };
  }

  // ── Order detail normalisatie (recente orders) ────────────
  // Get order by id response: orderId, orderPlacedDateTime, orderItems[]
  // orderItem bevat: unitPrice {amount, currency}, quantity, totalPrice {amount, currency}
  private normalizeOrderDetail(o: Record<string, unknown>): NormalizedOrder {
    const orderItems = (o.orderItems as Record<string, unknown>[] | undefined) ?? [];

    const lineItems: NormalizedLineItem[] = orderItems.map((item): NormalizedLineItem => {
      const qty       = Number(item.quantity ?? item.quantityOrdered ?? 1);
      const unitP     = this.parsePrice(item.unitPrice);
      const totalP    = this.parsePrice(item.totalPrice) || (unitP * qty);
      const product   = item.product as Record<string, unknown> | undefined;
      const offer     = item.offer as Record<string, unknown> | undefined;
      return {
        externalId:    String(item.orderItemId),
        productId:     item.ean ? String(item.ean) : undefined,
        sku:           item.ean ? String(item.ean) : undefined,
        title:         String(product?.title ?? offer?.title ?? ''),
        quantity:      qty,
        unitPrice:     unitP,
        totalPrice:    totalP,
        discountAmount: 0,
      };
    });

    const totalAmount = lineItems.reduce((s, li) => s + li.totalPrice, 0);

    return {
      externalId:     String(o.orderId),
      externalNumber: String(o.orderId),
      totalAmount,
      subtotalAmount: totalAmount,
      taxAmount:      0,
      shippingAmount: 0,
      discountAmount: 0,
      currency:       'EUR',
      status:         'completed',
      lineItems,
      orderedAt:      new Date(String(o.orderPlacedDateTime)),
      updatedAt:      new Date(String(o.orderPlacedDateTime)),
    };
  }

  // ── Product normalisatie ──────────────────────────────────
  private normalizeProduct(p: Record<string, unknown>): NormalizedProduct {
    return {
      externalId:     String(p.ean ?? p.id),
      title:          String(p.title ?? ''),
      totalInventory: parseInt(String(
        (p.stock as Record<string, unknown> | undefined)?.correctedStock ?? '0'
      )),
      updatedAt: new Date(),
    };
  }

  // ── Prijs parser (bol geeft {amount, currency} OF getal) ─
  private parsePrice(val: unknown): number {
    if (val === null || val === undefined) return 0;
    if (typeof val === 'number') return val;
    if (typeof val === 'string') return parseFloat(val) || 0;
    if (typeof val === 'object') {
      const obj = val as Record<string, unknown>;
      return parseFloat(String(obj.amount ?? obj.value ?? '0')) || 0;
    }
    return 0;
  }

  // ── API helper ────────────────────────────────────────────
  private async apiGet(token: string, path: string): Promise<unknown> {
    const res = await fetch(`https://api.bol.com${path}`, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Accept':        'application/vnd.retailer.v10+json',
      },
    });
    if (!res.ok) throw new Error(`Bol.com API fout ${res.status}: ${path}`);
    return res.json();
  }
}
