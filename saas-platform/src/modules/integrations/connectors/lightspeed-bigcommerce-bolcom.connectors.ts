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
      const shop = data.shop || {};
      return { success: true, shopName: shop.name, shopCurrency: shop.mainCurrency, shopCountry: shop.country };
    } catch (err: unknown) {
      return { success: false, error: err instanceof Error ? err.message : 'Verbinding mislukt' };
    }
  }

  async fetchOrders(creds: IntegrationCredentials, options: FetchOptions): Promise<PaginatedResult<NormalizedOrder>> {
    const page  = options.page || 1;
    const limit = Math.min(options.limit || 50, 50);
    const params = new URLSearchParams({ page: String(page), limit: String(limit) });
    if (options.updatedAfter) params.set('updated_at_min', options.updatedAfter.toISOString());
    const data   = await this.get(creds, '/api/orders.json?' + params.toString()) as Record<string, unknown>;
    const orders = Array.isArray(data.orders) ? data.orders as Record<string, unknown>[]
                 : data.order ? [data.order as Record<string, unknown>] : [];
    const count  = parseInt(String(data.count || orders.length));
    const items  = orders.map(o => this.normalizeOrder(o));
    const hasNextPage = (page * limit) < count;
    return { items, hasNextPage, nextPage: hasNextPage ? page + 1 : undefined, totalCount: count };
  }

  async fetchProducts(creds: IntegrationCredentials, options: FetchOptions): Promise<PaginatedResult<NormalizedProduct>> {
    const page  = options.page || 1;
    const limit = Math.min(options.limit || 50, 50);
    const data  = await this.get(creds, '/api/products.json?page=' + page + '&limit=' + limit) as Record<string, unknown>;
    const prods = Array.isArray(data.products) ? data.products as Record<string, unknown>[]
                : data.product ? [data.product as Record<string, unknown>] : [];
    const count = parseInt(String(data.count || prods.length));
    return { items: prods.map(p => this.normalizeProduct(p)), hasNextPage: (page * limit) < count, nextPage: page + 1 };
  }

  async fetchCustomers(creds: IntegrationCredentials, options: FetchOptions): Promise<PaginatedResult<NormalizedCustomer>> {
    const page  = options.page || 1;
    const limit = Math.min(options.limit || 50, 50);
    const data  = await this.get(creds, '/api/customers.json?page=' + page + '&limit=' + limit) as Record<string, unknown>;
    const custs = Array.isArray(data.customers) ? data.customers as Record<string, unknown>[]
                : data.customer ? [data.customer as Record<string, unknown>] : [];
    const count = parseInt(String(data.count || custs.length));
    return { items: custs.map(c => this.normalizeCustomer(c)), hasNextPage: (page * limit) < count, nextPage: page + 1 };
  }

  async refreshAccessToken(creds: IntegrationCredentials): Promise<TokenRefreshResult> {
    const res = await fetch('https://cloud.lightspeedapp.com/oauth/access_token.php', {
      method:  'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type:    'refresh_token',
        client_id:     process.env.LIGHTSPEED_CLIENT_ID || '',
        client_secret: process.env.LIGHTSPEED_CLIENT_SECRET || '',
        refresh_token: creds.refreshToken || '',
      }),
    });
    if (!res.ok) throw new Error('Lightspeed token refresh mislukt');
    const d = await res.json() as { access_token: string; refresh_token: string; expires_in: number };
    return { accessToken: d.access_token, refreshToken: d.refresh_token, expiresAt: new Date(Date.now() + d.expires_in * 1000) };
  }

  private normalizeOrder(o: Record<string, unknown>): NormalizedOrder {
    const orderProducts = o.orderProducts as Record<string, unknown> | undefined;
    const lineItemsRaw  = Array.isArray(orderProducts?.orderProduct)
      ? orderProducts!.orderProduct as Record<string, unknown>[]
      : [];
    return {
      externalId:     String(o.id),
      externalNumber: o.number ? '#' + o.number : undefined,
      totalAmount:    parseFloat(String(o.priceIncl || o.price || '0')),
      subtotalAmount: parseFloat(String(o.priceExcl || '0')),
      taxAmount:      parseFloat(String(o.taxAmount || '0')),
      shippingAmount: parseFloat(String(o.shipmentPrice || '0')),
      discountAmount: parseFloat(String(o.discountAmount || '0')),
      currency:       String(o.currency || 'EUR'),
      status:         String(o.status || 'pending'),
      lineItems: lineItemsRaw.map((li): NormalizedLineItem => ({
        externalId:     String(li.id),
        productId:      li.productId ? String(li.productId) : undefined,
        sku:            li.articleCode as string | undefined,
        title:          String(li.productTitle || ''),
        quantity:       parseInt(String(li.quantityOrdered || '1')),
        unitPrice:      parseFloat(String(li.priceIncl || '0')),
        totalPrice:     parseFloat(String(li.priceIncl || '0')) * parseInt(String(li.quantityOrdered || '1')),
        discountAmount: 0,
      })),
      orderedAt: new Date(String(o.createdAt || o.date)),
      updatedAt: new Date(String(o.updatedAt || o.createdAt)),
    };
  }

  private normalizeProduct(p: Record<string, unknown>): NormalizedProduct {
    return {
      externalId: String(p.id),
      title:      String(p.title || ''),
      status:     p.isVisible ? 'active' : 'draft',
      updatedAt:  new Date(String(p.updatedAt || p.createdAt)),
    };
  }

  private normalizeCustomer(c: Record<string, unknown>): NormalizedCustomer {
    const email = String(c.email || '');
    return {
      externalId:  String(c.id),
      emailHash:   crypto.createHash('sha256').update(email.toLowerCase()).digest('hex'),
      firstName:   c.firstname as string | undefined,
      lastName:    c.lastname  as string | undefined,
      country:     c.country   as string | undefined,
      totalSpent:  parseFloat(String(c.totalSpent || '0')),
      orderCount:  parseInt(String(c.totalOrders || '0')),
      updatedAt:   new Date(String(c.updatedAt || c.createdAt)),
    };
  }

  private async get(creds: IntegrationCredentials, path: string): Promise<unknown> {
    const base = creds.storeUrl || ('https://api.webshopapp.com/' + creds.shopDomain);
    const res  = await fetch(base + path, { headers: { 'Authorization': 'Bearer ' + creds.accessToken } });
    if (!res.ok) throw new Error('Lightspeed API fout ' + res.status);
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
    const page  = options.page || 1;
    const limit = Math.min(options.limit || 250, 250);
    const params = new URLSearchParams({ page: String(page), limit: String(limit) });
    if (options.updatedAfter) params.set('min_date_modified', options.updatedAfter.toISOString());
    const orders = await this.get(creds, storeHash, '/v2/orders?' + params.toString()) as Record<string, unknown>[];
    const items  = (Array.isArray(orders) ? orders : []).map(o => this.normalizeOrder(o));
    return { items, hasNextPage: items.length === limit, nextPage: items.length === limit ? page + 1 : undefined };
  }

  async fetchProducts(creds: IntegrationCredentials, options: FetchOptions): Promise<PaginatedResult<NormalizedProduct>> {
    const storeHash = this.extractStoreHash(creds);
    const page  = options.page || 1;
    const limit = Math.min(options.limit || 250, 250);
    const prods = await this.get(creds, storeHash, '/v3/catalog/products?page=' + page + '&limit=' + limit) as { data?: Record<string, unknown>[] };
    const items = (prods.data || []).map(p => this.normalizeProduct(p));
    return { items, hasNextPage: items.length === limit, nextPage: items.length === limit ? page + 1 : undefined };
  }

  async fetchCustomers(creds: IntegrationCredentials, options: FetchOptions): Promise<PaginatedResult<NormalizedCustomer>> {
    const storeHash = this.extractStoreHash(creds);
    const page  = options.page || 1;
    const limit = Math.min(options.limit || 250, 250);
    const custs = await this.get(creds, storeHash, '/v2/customers?page=' + page + '&limit=' + limit) as Record<string, unknown>[];
    const items = (Array.isArray(custs) ? custs : []).map(c => this.normalizeCustomer(c));
    return { items, hasNextPage: items.length === limit, nextPage: items.length === limit ? page + 1 : undefined };
  }

  private normalizeOrder(o: Record<string, unknown>): NormalizedOrder {
    return {
      externalId:     String(o.id),
      externalNumber: '#' + o.id,
      totalAmount:    parseFloat(String(o.total_inc_tax || o.total_ex_tax || '0')),
      subtotalAmount: parseFloat(String(o.subtotal_inc_tax || '0')),
      taxAmount:      parseFloat(String(o.total_tax || '0')),
      shippingAmount: parseFloat(String(o.shipping_cost_inc_tax || '0')),
      discountAmount: parseFloat(String(o.discount_amount || '0')),
      currency:       String(o.currency_code || 'EUR'),
      status:         String(o.status || 'pending'),
      lineItems:      [],
      orderedAt:      new Date(String(o.date_created)),
      updatedAt:      new Date(String(o.date_modified || o.date_created)),
    };
  }

  private normalizeProduct(p: Record<string, unknown>): NormalizedProduct {
    return {
      externalId:     String(p.id),
      title:          String(p.name || ''),
      status:         p.is_visible ? 'active' : 'draft',
      totalInventory: parseInt(String(p.total_stock || '0')),
      priceMin:       parseFloat(String(p.price || '0')),
      updatedAt:      new Date(String(p.date_modified || p.date_created)),
    };
  }

  private normalizeCustomer(c: Record<string, unknown>): NormalizedCustomer {
    const email = String(c.email || '');
    return {
      externalId:  String(c.id),
      emailHash:   crypto.createHash('sha256').update(email.toLowerCase()).digest('hex'),
      firstName:   c.first_name as string | undefined,
      lastName:    c.last_name  as string | undefined,
      totalSpent:  0,
      orderCount:  0,
      updatedAt:   new Date(String(c.date_modified || c.date_created)),
    };
  }

  private extractStoreHash(creds: IntegrationCredentials): string {
    const url   = creds.storeUrl || '';
    const match = url.match(/stores\/([a-z0-9]+)/);
    return match ? match[1] : url.replace(/[^a-z0-9]/gi, '');
  }

  private async get(creds: IntegrationCredentials, storeHash: string, path: string): Promise<unknown> {
    const res = await fetch('https://api.bigcommerce.com/stores/' + storeHash + path, {
      headers: {
        'X-Auth-Token':  creds.accessToken || creds.apiKey || '',
        'Content-Type':  'application/json',
        'Accept':        'application/json',
      },
    });
    if (!res.ok) throw new Error('BigCommerce API fout ' + res.status);
    return res.json();
  }
}

// ============================================================
// BOL.COM
//
// Auth:    Client Credentials via login.bol.com/token
// Token:   Gecached 240 sec in Redis (token geldig 299 sec)
// Orders:  Full sync via Shipments API (FBR + FBB)
//          Incremental via change-interval-minute parameter
// Prijzen: Via /retailer/orders/{orderId} detail (niet in shipment list)
// Producten: Async Offers export (POST → poll → CSV)
// 429:     Retry met Retry-After header
// ============================================================

function parsePrice(raw: unknown): number {
  if (raw == null) return 0;
  if (typeof raw === 'number') return raw;
  if (typeof raw === 'string') return parseFloat(raw) || 0;
  const obj = raw as Record<string, unknown>;
  if (obj.amount != null) return parseFloat(String(obj.amount)) || 0;
  return 0;
}

function safeInt(raw: unknown, fallback: number): number {
  const n = parseInt(String(raw || ''), 10);
  return isNaN(n) ? fallback : n;
}

// In-memory token cache als Redis niet beschikbaar is
const tokenMemoryCache: Record<string, { token: string; expiresAt: number }> = {};

export class BolcomConnector implements IPlatformConnector {
  readonly platform = 'bolcom' as const;

  async testConnection(creds: IntegrationCredentials): Promise<ConnectionTestResult> {
    try {
      await this.getAccessToken(creds);
      return { success: true, shopName: 'Bol.com Retailer', shopCurrency: 'EUR', shopCountry: 'NL' };
    } catch (err: unknown) {
      return { success: false, error: err instanceof Error ? err.message : 'Verbinding mislukt' };
    }
  }

  async fetchOrders(creds: IntegrationCredentials, options: FetchOptions): Promise<PaginatedResult<NormalizedOrder>> {
    const token      = await this.getAccessToken(creds);
    const page       = options.page || 1;
    const isFullSync = options.jobType === 'full_sync' || !options.updatedAfter;

    if (isFullSync) {
      return this.fetchViaShipments(token, page);
    }
    return this.fetchViaOrders(token, options.updatedAfter, page);
  }

  // Full sync: via Shipments API (FBR + FBB apart)
  private async fetchViaShipments(token: string, page: number): Promise<PaginatedResult<NormalizedOrder>> {
    const [fbrData, fbbData] = await Promise.all([
      this.apiGet(token, '/retailer/shipments?fulfilment-method=FBR&page=' + page)
        .catch(() => ({ shipments: [] })) as Promise<{ shipments?: Record<string, unknown>[] }>,
      this.apiGet(token, '/retailer/shipments?fulfilment-method=FBB&page=' + page)
        .catch(() => ({ shipments: [] })) as Promise<{ shipments?: Record<string, unknown>[] }>,
    ]);

    const fbrShipments = fbrData.shipments || [];
    const fbbShipments = fbbData.shipments || [];
    const allShipments = [...fbrShipments, ...fbbShipments];
    const hasNextPage  = fbrShipments.length === 50 || fbbShipments.length === 50;

    const seenOrderIds = new Set<string>();
    const orders: NormalizedOrder[] = [];

    for (const s of allShipments) {
      const order   = s.order as Record<string, unknown> | undefined;
      const orderId = String(order?.orderId || s.orderId || '');
      if (!orderId || seenOrderIds.has(orderId)) continue;
      seenOrderIds.add(orderId);

      try {
        const detail = await this.apiGet(token, '/retailer/orders/' + orderId) as Record<string, unknown>;
        orders.push(this.normalizeOrderDetail(detail));
      } catch {
        orders.push(this.normalizeShipment(s, orderId));
      }
    }

    return { items: orders, hasNextPage, nextPage: hasNextPage ? page + 1 : undefined };
  }

  // Incremental sync: via Orders API met change-interval-minute
  private async fetchViaOrders(token: string, updatedAfter: Date | undefined, page: number): Promise<PaginatedResult<NormalizedOrder>> {
    const minutesAgo    = updatedAfter
      ? Math.ceil((Date.now() - updatedAfter.getTime()) / 60000)
      : 120;
    const cappedMinutes = Math.min(minutesAgo, 2880); // max 48u

    const data = await this.apiGet(
      token,
      '/retailer/orders?status=ALL&fulfilment-method=FBR&change-interval-minute=' + cappedMinutes + '&page=' + page
    ) as { orders?: Record<string, unknown>[] };

    const rawOrders = data.orders || [];
    const items = rawOrders.map(o => this.normalizeOrderSummary(o));
    return { items, hasNextPage: rawOrders.length === 50, nextPage: rawOrders.length === 50 ? page + 1 : undefined };
  }

  async fetchProducts(creds: IntegrationCredentials, options: FetchOptions): Promise<PaginatedResult<NormalizedProduct>> {
    const token = await this.getAccessToken(creds);
    try {
      // Start async export
      const exportRes = await this.apiPost(token, '/retailer/offers/export', {
        format: 'CSV',
      }) as { processStatusId?: string };

      const processId = exportRes.processStatusId;
      if (!processId) return { items: [], hasNextPage: false };

      // Poll tot klaar (max 10x, 3 sec interval)
      let reportId: string | null = null;
      for (let i = 0; i < 10; i++) {
        await new Promise(r => setTimeout(r, 3000));
        const status = await this.apiGet(token, '/shared/process-status/' + processId) as {
          status?: string; entityId?: string;
        };
        if (status.status === 'SUCCESS' && status.entityId) {
          reportId = status.entityId;
          break;
        }
        if (status.status === 'FAILURE') break;
      }

      if (!reportId) return { items: [], hasNextPage: false };

      // Download CSV
      const csv = await this.apiGetCsv(token, '/retailer/offers/export/' + reportId);
      const items = this.parseCsvOffers(csv);
      return { items, hasNextPage: false };
    } catch {
      return { items: [], hasNextPage: false };
    }
  }

  async fetchCustomers(): Promise<PaginatedResult<NormalizedCustomer>> {
    // Bol.com geeft geen persoonlijke klantgegevens (AVG/privacy)
    return { items: [], hasNextPage: false };
  }

  async refreshAccessToken(creds: IntegrationCredentials): Promise<TokenRefreshResult> {
    const token = await this.getAccessToken(creds);
    return { accessToken: token, expiresAt: new Date(Date.now() + 240000) };
  }

  // ── Token ophalen met caching ──────────────────────────────
  // Token is 299 sec geldig. We cachen 240 sec (60 sec buffer).
  // Bol.com heeft strikte rate limits op de auth endpoint.
  private async getAccessToken(creds: IntegrationCredentials): Promise<string> {
    const cacheKey = 'bolcom:token:' + creds.integrationId;

    // 1. Check in-memory cache
    const mem = tokenMemoryCache[cacheKey];
    if (mem && mem.expiresAt > Date.now()) {
      return mem.token;
    }

    // 2. Check Redis cache (als beschikbaar)
    try {
      const { cache } = await import('../../../infrastructure/cache/redis');
      const cached = await cache.get(cacheKey);
      if (cached) {
        tokenMemoryCache[cacheKey] = { token: cached, expiresAt: Date.now() + 200000 };
        return cached;
      }
    } catch {
      // Redis niet beschikbaar — doorgaan
    }

    // 3. Nieuwe token ophalen
    const encoded = Buffer.from((creds.apiKey || '') + ':' + (creds.apiSecret || '')).toString('base64');
    const res = await fetch('https://login.bol.com/token?grant_type=client_credentials', {
      method:  'POST',
      headers: {
        'Authorization': 'Basic ' + encoded,
        'Accept':        'application/json',
        'Content-Type':  'application/x-www-form-urlencoded',
      },
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error('Bol.com auth mislukt (' + res.status + '): ' + body.slice(0, 200));
    }

    const d = await res.json() as { access_token: string; expires_in?: number };
    const token = d.access_token;
    const ttlMs = ((d.expires_in || 299) - 60) * 1000;

    // Sla op in memory cache
    tokenMemoryCache[cacheKey] = { token, expiresAt: Date.now() + ttlMs };

    // Sla op in Redis cache
    try {
      const { cache } = await import('../../../infrastructure/cache/redis');
      await cache.set(cacheKey, token, Math.floor(ttlMs / 1000));
    } catch {
      // Redis niet beschikbaar — alleen memory cache
    }

    return token;
  }

  // ── Normaliseer order detail ───────────────────────────────
  private normalizeOrderDetail(o: Record<string, unknown>): NormalizedOrder {
    const orderItems = (o.orderItems as Record<string, unknown>[] | undefined) || [];
    const lineItems: NormalizedLineItem[] = orderItems.map(item => {
      const unitPrice = parsePrice(item.unitPrice);
      const quantity  = safeInt(item.quantity || 1, 1);
      const product   = item.product as Record<string, unknown> | undefined;
      return {
        externalId:     String(item.orderItemId || ''),
        sku:            String(item.ean || ''),
        title:          String(product?.title || item.title || item.ean || ''),
        quantity,
        unitPrice,
        totalPrice:     Math.round(unitPrice * quantity * 100) / 100,
        discountAmount: 0,
      };
    });

    const totalAmount = lineItems.reduce((acc, li) => acc + li.totalPrice, 0);
    return {
      externalId:        String(o.orderId || ''),
      externalNumber:    String(o.orderId || ''),
      totalAmount:       Math.round(totalAmount * 100) / 100,
      subtotalAmount:    Math.round(totalAmount * 100) / 100,
      taxAmount:         Math.round((totalAmount - totalAmount / 1.21) * 100) / 100,
      shippingAmount:    0,
      discountAmount:    0,
      currency:          'EUR',
      status:            'completed',
      financialStatus:   'paid',
      fulfillmentStatus: 'fulfilled',
      lineItems,
      orderedAt:         o.orderPlacedDateTime ? new Date(String(o.orderPlacedDateTime)) : new Date(),
      updatedAt:         new Date(),
    };
  }

  // ── Normaliseer shipment (fallback) ────────────────────────
  private normalizeShipment(s: Record<string, unknown>, orderId: string): NormalizedOrder {
    const items = (s.shipmentItems as Record<string, unknown>[] | undefined) || [];
    const lineItems: NormalizedLineItem[] = items.map(item => {
      const unitPrice = parsePrice(item.unitPrice || item.offerPrice);
      const quantity  = safeInt(item.quantity || item.quantityShipped || 1, 1);
      const product   = item.product as Record<string, unknown> | undefined;
      return {
        externalId:     String(item.orderItemId || item.shipmentItemId || ''),
        sku:            String(item.ean || ''),
        title:          String(product?.title || item.ean || ''),
        quantity,
        unitPrice,
        totalPrice:     Math.round(unitPrice * quantity * 100) / 100,
        discountAmount: 0,
      };
    });

    const totalAmount = lineItems.reduce((acc, li) => acc + li.totalPrice, 0);
    const shipDate    = s.shipmentDate || s.orderPlacedDateTime;

    return {
      externalId:        orderId,
      externalNumber:    orderId,
      totalAmount:       Math.round(totalAmount * 100) / 100,
      subtotalAmount:    Math.round(totalAmount * 100) / 100,
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

  // ── Normaliseer order summary (incremental) ────────────────
  private normalizeOrderSummary(o: Record<string, unknown>): NormalizedOrder {
    const orderItems = (o.orderItems as Record<string, unknown>[] | undefined) || [];
    const lineItems: NormalizedLineItem[] = orderItems.map(item => {
      const unitPrice = parsePrice(item.unitPrice);
      const quantity  = safeInt(item.quantity || 1, 1);
      const product   = item.product as Record<string, unknown> | undefined;
      return {
        externalId:     String(item.orderItemId || ''),
        sku:            String(item.ean || ''),
        title:          String(product?.title || item.ean || ''),
        quantity,
        unitPrice,
        totalPrice:     Math.round(unitPrice * quantity * 100) / 100,
        discountAmount: 0,
      };
    });

    const totalAmount = lineItems.reduce((acc, li) => acc + li.totalPrice, 0);
    return {
      externalId:        String(o.orderId || ''),
      externalNumber:    String(o.orderId || ''),
      totalAmount:       Math.round(totalAmount * 100) / 100,
      subtotalAmount:    Math.round(totalAmount * 100) / 100,
      taxAmount:         0,
      shippingAmount:    0,
      discountAmount:    0,
      currency:          'EUR',
      status:            'completed',
      financialStatus:   'paid',
      fulfillmentStatus: 'fulfilled',
      lineItems,
      orderedAt:         o.orderPlacedDateTime ? new Date(String(o.orderPlacedDateTime)) : new Date(),
      updatedAt:         new Date(),
    };
  }

  // ── CSV offers parsen ──────────────────────────────────────
  private parseCsvOffers(csv: string): NormalizedProduct[] {
    const lines = csv.split('\n').filter(l => l.trim());
    if (lines.length < 2) return [];

    const headers = lines[0].split(',').map(h => h.trim().replace(/"/g, ''));

    return lines.slice(1).map(line => {
      const cols: Record<string, string> = {};
      const values = line.split(',');
      headers.forEach((h, i) => { cols[h] = (values[i] || '').trim().replace(/"/g, ''); });

      const ean       = cols['ean'] || cols['EAN'] || '';
      const offerId   = cols['offerId'] || cols['offer-id'] || '';
      const reference = cols['reference'] || cols['Reference'] || '';
      const price     = parseFloat(cols['price'] || cols['Price'] || '0');
      const stock     = parseInt(cols['stock'] || cols['Stock'] || '0');
      const onHold    = (cols['onHoldByRetailer'] || '').toLowerCase() === 'true';
      const title     = reference && reference !== ean ? reference : ean;

      return {
        externalId:       offerId || ean,
        title,
        ean,
        status:           onHold ? 'draft' : 'active',
        totalInventory:   stock,
        priceMin:         price || undefined,
        priceMax:         price || undefined,
        requiresShipping: true,
        updatedAt:        new Date(),
      } as NormalizedProduct;
    }).filter(p => p.ean || p.externalId);
  }

  // ── HTTP GET ───────────────────────────────────────────────
  private async apiGet(token: string, path: string, retries: number = 3): Promise<unknown> {
    const res = await fetch('https://api.bol.com' + path, {
      headers: {
        'Authorization': 'Bearer ' + token,
        'Accept':        'application/vnd.retailer.v10+json',
      },
    });

    if (res.status === 429 && retries > 0) {
      const retryAfter = parseInt(res.headers.get('Retry-After') || '60', 10);
      const waitMs     = Math.min(retryAfter * 1000, 120000);
      await new Promise(r => setTimeout(r, waitMs));
      return this.apiGet(token, path, retries - 1);
    }

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error('Bol.com API ' + res.status + ' op ' + path + ': ' + body.slice(0, 300));
    }
    return res.json();
  }

  // ── HTTP POST ──────────────────────────────────────────────
  private async apiPost(token: string, path: string, body: unknown): Promise<unknown> {
    const res = await fetch('https://api.bol.com' + path, {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + token,
        'Accept':        'application/vnd.retailer.v10+json',
        'Content-Type':  'application/vnd.retailer.v10+json',
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const errBody = await res.text().catch(() => '');
      throw new Error('Bol.com POST ' + path + ' mislukt (' + res.status + '): ' + errBody.slice(0, 300));
    }
    return res.json();
  }

  // ── HTTP GET CSV ───────────────────────────────────────────
  private async apiGetCsv(token: string, path: string): Promise<string> {
    const res = await fetch('https://api.bol.com' + path, {
      headers: {
        'Authorization': 'Bearer ' + token,
        'Accept':        'application/vnd.retailer.v10+csv',
      },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error('Bol.com CSV GET ' + path + ' mislukt (' + res.status + '): ' + body.slice(0, 300));
    }
    return res.text();
  }
}
