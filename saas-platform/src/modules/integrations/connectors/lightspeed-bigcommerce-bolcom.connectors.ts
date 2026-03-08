// ============================================================
// src/modules/integrations/connectors/lightspeed-bigcommerce-bolcom.connectors.ts
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
    const data  = await this.get(creds, `/api/orders.json?${params}`) as Record<string, unknown>;
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
    return { externalId: String(p.id), title: String(p.title ?? ''), status: p.isVisible ? 'active' : 'draft', updatedAt: new Date(String(p.updatedAt ?? p.createdAt)) };
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
    const custs = await this.get(creds, storeHash, `/v2/customers?page=${page}&limit=${limit}`) as Record<string, unknown>[];
    const items = (Array.isArray(custs) ? custs : []).map(c => this.normalizeCustomer(c));
    return { items, hasNextPage: items.length === limit, nextPage: items.length === limit ? page + 1 : undefined };
  }

  private normalizeOrder(o: Record<string, unknown>): NormalizedOrder {
    return {
      externalId:     String(o.id),
      externalNumber: `#${o.id}`,
      totalAmount:    parseFloat(String(o.total_inc_tax ?? o.total_ex_tax ?? '0')),
      subtotalAmount: parseFloat(String(o.subtotal_inc_tax ?? '0')),
      taxAmount:      parseFloat(String(o.total_tax ?? '0')),
      shippingAmount: parseFloat(String(o.shipping_cost_inc_tax ?? '0')),
      discountAmount: parseFloat(String(o.discount_amount ?? '0')),
      currency:       String(o.currency_code ?? 'EUR'),
      status:         String(o.status ?? 'pending'),
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
      totalInventory: parseInt(String(p.total_stock ?? '0')),
      priceMin:       parseFloat(String(p.price ?? '0')),
      updatedAt:      new Date(String(p.date_modified ?? p.date_created)),
    };
  }

  private normalizeCustomer(c: Record<string, unknown>): NormalizedCustomer {
    const email = String(c.email ?? '');
    return {
      externalId:  String(c.id),
      emailHash:   crypto.createHash('sha256').update(email.toLowerCase()).digest('hex'),
      firstName:   c.first_name as string | undefined,
      lastName:    c.last_name  as string | undefined,
      totalSpent:  0, orderCount: 0,
      updatedAt:   new Date(String(c.date_modified ?? c.date_created)),
    };
  }

  private extractStoreHash(creds: IntegrationCredentials): string {
    const url   = creds.storeUrl ?? '';
    const match = url.match(/stores\/([a-z0-9]+)/);
    return match ? match[1] : url.replace(/[^a-z0-9]/gi, '');
  }

  private async get(creds: IntegrationCredentials, storeHash: string, path: string): Promise<unknown> {
    const res = await fetch(`https://api.bigcommerce.com/stores/${storeHash}${path}`, {
      headers: { 'X-Auth-Token': creds.accessToken ?? creds.apiKey!, 'Content-Type': 'application/json', 'Accept': 'application/json' },
    });
    if (!res.ok) throw new Error(`BigCommerce API fout ${res.status}`);
    return res.json();
  }
}

// ============================================================
// BOL.COM — volledige rewrite
//
// FIXES tov vorige versie:
//   1. fetchOrders full_sync → Shipments API (90 dagen history)
//   2. fetchOrders incremental → Orders API met change-interval-minute
//   3. parsePrice() verwerkt object {amount, currency} correct
//   4. fetchProducts → Offers API (/retailer/offers) ipv inventory
//      Offers hebben prijs, voorraad, EAN, conditie
//   5. jobType doorgegeven via FetchOptions
// ============================================================

// Bol.com stuurt prijzen soms als object { amount: "12.99", currency: "EUR" }
function parsePrice(raw: unknown): number {
  if (raw == null) return 0;
  if (typeof raw === 'number') return raw;
  if (typeof raw === 'string') return parseFloat(raw) || 0;
  const obj = raw as Record<string, unknown>;
  if (obj.amount != null) return parseFloat(String(obj.amount)) || 0;
  return 0;
}

function safeInt(raw: unknown, fallback = 0): number {
  const n = parseInt(String(raw ?? ''), 10);
  return isNaN(n) ? fallback : n;
}

export class BolcomConnector implements IPlatformConnector {
  readonly platform = 'bolcom' as const;

  // ── Verbinding testen ─────────────────────────────────────
  async testConnection(creds: IntegrationCredentials): Promise<ConnectionTestResult> {
    try {
      await this.getAccessToken(creds);
      return { success: true, shopName: 'Bol.com Retailer', shopCurrency: 'EUR', shopCountry: 'NL' };
    } catch (err: unknown) {
      return { success: false, error: err instanceof Error ? err.message : 'Verbinding mislukt' };
    }
  }

  // ── Orders ophalen ────────────────────────────────────────
  async fetchOrders(
    creds: IntegrationCredentials,
    options: FetchOptions
  ): Promise<PaginatedResult<NormalizedOrder>> {
    const token      = await this.getAccessToken(creds);
    const page       = options.page ?? 1;
    const isFullSync = options.jobType === 'full_sync' || !options.updatedAfter;

    if (isFullSync) {
      // Shipments API: tot 90 dagen terug, bevat echte verkoopprijs incl. BTW
      return this.fetchViaShipments(token, page);
    } else {
      // Incremental: orders die gewijzigd zijn na updatedAfter
      return this.fetchViaOrders(token, options.updatedAfter, page);
    }
  }

  // Shipments API — historische data, bevat correcte prijzen
  // BELANGRIJK: Shipments API accepteert GEEN fulfilment-method=ALL
  // Moet twee aparte calls doen: FBR en FBB
  private async fetchViaShipments(
    token: string,
    page: number
  ): Promise<PaginatedResult<NormalizedOrder>> {
    // Haal FBR en FBB shipments parallel op
    const [fbrData, fbbData] = await Promise.all([
      this.apiGet(token, `/retailer/shipments?fulfilment-method=FBR&page=${page}`)
        .catch(() => ({ shipments: [] })) as Promise<{ shipments?: Record<string, unknown>[] }>,
      this.apiGet(token, `/retailer/shipments?fulfilment-method=FBB&page=${page}`)
        .catch(() => ({ shipments: [] })) as Promise<{ shipments?: Record<string, unknown>[] }>,
    ]);

    const fbrShipments = fbrData.shipments ?? [];
    const fbbShipments = fbbData.shipments ?? [];
    const allShipments = [...fbrShipments, ...fbbShipments];

    // hasNextPage als ofwel FBR ofwel FBB nog een volgende pagina heeft (50 items)
    const hasNextPage = fbrShipments.length === 50 || fbbShipments.length === 50;

    return {
      items:       allShipments.map(s => this.normalizeShipment(s)),
      hasNextPage,
      nextPage:    hasNextPage ? page + 1 : undefined,
    };
  }

  // Orders API — recente orders met change-interval-minute
  // fulfilment-method=ALL bestaat ook niet op Orders API — gebruik FBR (eigen verzending)
  private async fetchViaOrders(
    token: string,
    updatedAfter: Date | undefined,
    page: number
  ): Promise<PaginatedResult<NormalizedOrder>> {
    const minutesAgo    = updatedAfter
      ? Math.ceil((Date.now() - updatedAfter.getTime()) / 60000)
      : 120;
    const cappedMinutes = Math.min(minutesAgo, 2880); // max 48u

    // status=ALL + fulfilment-method=FBR: alle FBR orders van afgelopen X minuten
    const data = await this.apiGet(
      token,
      `/retailer/orders?status=ALL&fulfilment-method=FBR&change-interval-minute=${cappedMinutes}&page=${page}`
    ) as { orders?: Record<string, unknown>[] };

    const rawOrders = data.orders ?? [];

    // Haal detail op per order voor correcte prijzen
    const orders: NormalizedOrder[] = [];
    for (const o of rawOrders) {
      try {
        const detail = await this.apiGet(token, `/retailer/orders/${o.orderId}`) as Record<string, unknown>;
        orders.push(this.normalizeOrderDetail(detail));
      } catch {
        orders.push(this.normalizeOrderSummary(o));
      }
    }

    return {
      items:       orders,
      hasNextPage: rawOrders.length === 50,
      nextPage:    rawOrders.length === 50 ? page + 1 : undefined,
    };
  }

  // ── Producten ophalen via Offers API ──────────────────────
  // /retailer/offers geeft alle actieve aanbiedingen incl. prijs + voorraad
  async fetchProducts(
    creds: IntegrationCredentials,
    options: FetchOptions
  ): Promise<PaginatedResult<NormalizedProduct>> {
    const token = await this.getAccessToken(creds);
    const page  = options.page ?? 1;

    const data = await this.apiGet(
      token,
      `/retailer/offers?page=${page}`
    ) as { offers?: Record<string, unknown>[] };

    const offers = data.offers ?? [];

    const products: NormalizedProduct[] = offers.map(offer => {
      const pricing   = offer.pricing  as Record<string, unknown> | undefined;
      const stock     = offer.stock    as Record<string, unknown> | undefined;
      const fulfilment = offer.fulfilment as Record<string, unknown> | undefined;

      // Prijs: probeer verschillende velden
      const bundlePrices = pricing?.bundlePrices as Record<string, unknown>[] | undefined;
      const price = bundlePrices?.length
        ? parsePrice(bundlePrices[0]?.unitPrice)
        : parsePrice(pricing?.regularPrice ?? pricing?.mentionedPrice);

      const ean       = String(offer.ean ?? offer.offerReference ?? '');
      const offerId   = String(offer.offerId ?? offer.id ?? ean);
      const stockAmt  = safeInt(stock?.amount ?? 0);

      return {
        externalId:     offerId,
        title:          String(offer.reference ?? ean), // title komt via catalog API, reference is fallback
        ean,
        status:         offer.onHoldByRetailer ? 'draft' : 'active',
        condition:      String(offer.condition ?? 'NEW'),
        fulfillmentBy:  String(fulfilment?.method ?? 'FBR'),
        totalInventory: stockAmt,
        priceMin:       price || undefined,
        priceMax:       price || undefined,
        requiresShipping: true,
        updatedAt:      new Date(),
      } as NormalizedProduct;
    });

    return {
      items:       products,
      hasNextPage: offers.length === 50,
      nextPage:    offers.length === 50 ? page + 1 : undefined,
    };
  }

  async fetchCustomers(): Promise<PaginatedResult<NormalizedCustomer>> {
    // Bol.com geeft geen persoonlijke klantgegevens (AVG/privacy)
    return { items: [], hasNextPage: false };
  }

  async refreshAccessToken(creds: IntegrationCredentials): Promise<TokenRefreshResult> {
    const token = await this.getAccessToken(creds);
    return { accessToken: token, expiresAt: new Date(Date.now() + 270_000) };
  }

  // ── Normaliseer Shipment → NormalizedOrder ─────────────────
  private normalizeShipment(s: Record<string, unknown>): NormalizedOrder {
    const items = (s.shipmentItems as Record<string, unknown>[] | undefined) ?? [];

    const lineItems: NormalizedLineItem[] = items.map(item => {
      // unitPrice is { amount: "12.99", currency: "EUR" } of getal
      const unitPrice = parsePrice(item.unitPrice ?? item.offerPrice);
      const quantity  = safeInt(item.quantity ?? 1, 1);
      const product   = item.product as Record<string, unknown> | undefined;
      return {
        externalId:    String(item.orderItemId ?? item.shipmentItemId ?? ''),
        sku:           String(item.ean ?? ''),
        title:         String(product?.title ?? item.title ?? item.ean ?? ''),
        quantity,
        unitPrice,
        totalPrice:    Math.round(unitPrice * quantity * 100) / 100,
        discountAmount: 0,
      };
    });

    const totalAmount = Math.round(lineItems.reduce((acc, li) => acc + li.totalPrice, 0) * 100) / 100;
    const shipDate    = s.shipmentDate ?? s.orderPlacedDateTime;

    return {
      externalId:        String(s.shipmentId ?? s.orderId ?? ''),
      externalNumber:    s.orderId ? String(s.orderId) : undefined,
      totalAmount,
      subtotalAmount:    totalAmount,
      taxAmount:         Math.round((totalAmount - totalAmount / 1.21) * 100) / 100,
      shippingAmount:    0,
      discountAmount:    0,
      currency:          'EUR',
      status:            'completed',
      financialStatus:   'paid',
      fulfillmentStatus: 'fulfilled',
      lineItems,
      orderedAt:         shipDate ? new Date(String(shipDate)) : new Date(),
      updatedAt:         new Date(),
    };
  }

  // ── Normaliseer Order detail → NormalizedOrder ─────────────
  private normalizeOrderDetail(o: Record<string, unknown>): NormalizedOrder {
    const orderItems = (o.orderItems as Record<string, unknown>[] | undefined) ?? [];

    const lineItems: NormalizedLineItem[] = orderItems.map(item => {
      const unitPrice = parsePrice(item.unitPrice ?? item.offerPrice);
      const quantity  = safeInt(item.quantity ?? 1, 1);
      const product   = item.product as Record<string, unknown> | undefined;
      return {
        externalId:    String(item.orderItemId ?? ''),
        sku:           String(item.ean ?? ''),
        title:         String(product?.title ?? item.title ?? item.ean ?? ''),
        quantity,
        unitPrice,
        totalPrice:    Math.round(unitPrice * quantity * 100) / 100,
        discountAmount: 0,
      };
    });

    const totalAmount = Math.round(lineItems.reduce((acc, li) => acc + li.totalPrice, 0) * 100) / 100;

    return {
      externalId:        String(o.orderId ?? ''),
      externalNumber:    String(o.orderId ?? ''),
      totalAmount,
      subtotalAmount:    totalAmount,
      taxAmount:         Math.round((totalAmount - totalAmount / 1.21) * 100) / 100,
      shippingAmount:    0,
      discountAmount:    0,
      currency:          'EUR',
      status:            'completed',
      financialStatus:   'paid',
      fulfillmentStatus: 'fulfilled',
      lineItems,
      orderedAt:         o.orderPlacedDateTime
        ? new Date(String(o.orderPlacedDateTime))
        : new Date(),
      updatedAt:         new Date(),
    };
  }

  // ── Fallback: Order summary (geen detail beschikbaar) ──────
  private normalizeOrderSummary(o: Record<string, unknown>): NormalizedOrder {
    const orderItems = (o.orderItems as Record<string, unknown>[] | undefined) ?? [];
    const lineItems: NormalizedLineItem[] = orderItems.map(item => {
      const unitPrice = parsePrice(item.unitPrice);
      const quantity  = safeInt(item.quantity ?? 1, 1);
      return {
        externalId:    String(item.orderItemId ?? ''),
        sku:           String(item.ean ?? ''),
        title:         String((item.product as Record<string, unknown> | undefined)?.title ?? item.ean ?? ''),
        quantity,
        unitPrice,
        totalPrice:    Math.round(unitPrice * quantity * 100) / 100,
        discountAmount: 0,
      };
    });
    const totalAmount = Math.round(lineItems.reduce((acc, li) => acc + li.totalPrice, 0) * 100) / 100;
    return {
      externalId:        String(o.orderId ?? ''),
      externalNumber:    String(o.orderId ?? ''),
      totalAmount,
      subtotalAmount:    totalAmount,
      taxAmount:         0,
      shippingAmount:    0,
      discountAmount:    0,
      currency:          'EUR',
      status:            'completed',
      financialStatus:   'paid',
      fulfillmentStatus: 'fulfilled',
      lineItems,
      orderedAt:         o.orderPlacedDateTime
        ? new Date(String(o.orderPlacedDateTime))
        : new Date(),
      updatedAt:         new Date(),
    };
  }

  // ── HTTP GET helper ────────────────────────────────────────
  private async apiGet(token: string, path: string): Promise<unknown> {
    const res = await fetch(`https://api.bol.com${path}`, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Accept':        'application/vnd.retailer.v10+json',
      },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Bol.com API ${res.status} op ${path}: ${body.slice(0, 300)}`);
    }
    return res.json();
  }

  // ── Token ophalen via Client Credentials ───────────────────
  private async getAccessToken(creds: IntegrationCredentials): Promise<string> {
    const encoded = Buffer.from(`${creds.apiKey}:${creds.apiSecret}`).toString('base64');
    const res = await fetch('https://login.bol.com/token?grant_type=client_credentials', {
      method:  'POST',
      headers: {
        'Authorization': `Basic ${encoded}`,
        'Accept':        'application/json',
        'Content-Type':  'application/x-www-form-urlencoded',
      },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Bol.com auth mislukt (${res.status}): ${body.slice(0, 200)}`);
    }
    const d = await res.json() as { access_token: string };
    return d.access_token;
  }
}
