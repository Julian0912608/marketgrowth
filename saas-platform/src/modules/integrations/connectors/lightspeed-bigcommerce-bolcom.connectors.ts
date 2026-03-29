// ============================================================
// src/modules/integrations/connectors/lightspeed-bigcommerce-bolcom.connectors.ts
//
// FIX: fetchViaOrders (incremental sync) haalt nu ook FBB orders
// op en haalt per order het detail op via /retailer/orders/{id}
// zodat open/pending orders correct worden opgeslagen met de
// juiste prijs, datum en status — net zoals de full sync.
// ============================================================

import crypto from 'crypto';
import {
  IPlatformConnector,
  IntegrationCredentials,
  FetchOptions,
  PaginatedResult,
  NormalizedOrder,
  NormalizedLineItem,
  NormalizedProduct,
  NormalizedCustomer,
  ConnectionTestResult,
} from '../types/integration.types';

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

// ============================================================
// LIGHTSPEED
// ============================================================
export class LightspeedConnector implements IPlatformConnector {
  readonly platform = 'lightspeed' as const;

  async testConnection(creds: IntegrationCredentials): Promise<ConnectionTestResult> {
    try {
      await this.get(creds, '/orders.json?limit=1');
      return { success: true, shopName: 'Lightspeed Store', shopCurrency: 'EUR', shopCountry: 'NL' };
    } catch (err: unknown) {
      return { success: false, error: err instanceof Error ? err.message : 'Verbinding mislukt' };
    }
  }

  async fetchOrders(creds: IntegrationCredentials, options: FetchOptions): Promise<PaginatedResult<NormalizedOrder>> {
    const page  = options.page || 1;
    const limit = Math.min(options.limit || 250, 250);
    const params = new URLSearchParams({ page: String(page), limit: String(limit) });
    if (options.updatedAfter) params.set('updated_at_min', options.updatedAfter.toISOString());
    const orders = await this.get(creds, '/orders.json?' + params.toString()) as Record<string, unknown>[];
    const items  = (Array.isArray(orders) ? orders : []).map(o => this.normalizeOrder(o));
    return { items, hasNextPage: items.length === limit, nextPage: items.length === limit ? page + 1 : undefined };
  }

  async fetchProducts(creds: IntegrationCredentials, options: FetchOptions): Promise<PaginatedResult<NormalizedProduct>> {
    const page  = options.page || 1;
    const limit = Math.min(options.limit || 250, 250);
    const prods = await this.get(creds, `/products.json?page=${page}&limit=${limit}`) as { products?: Record<string, unknown>[] };
    const items = ((prods as any).products || (Array.isArray(prods) ? prods : [])).map((p: Record<string, unknown>) => this.normalizeProduct(p));
    return { items, hasNextPage: items.length === limit, nextPage: items.length === limit ? page + 1 : undefined };
  }

  async fetchCustomers(creds: IntegrationCredentials, options: FetchOptions): Promise<PaginatedResult<NormalizedCustomer>> {
    return { items: [], hasNextPage: false };
  }

  private normalizeOrder(o: Record<string, unknown>): NormalizedOrder {
    const lineItemsRaw = (o as any).orderProducts?.orderProduct as Record<string, unknown>[] ?? [];
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
      externalId:     String(p.id),
      title:          String(p.title || ''),
      status:         p.isVisible ? 'active' : 'draft',
      totalInventory: parseInt(String(p.total_stock || '0')),
      priceMin:       parseFloat(String(p.price || '0')),
      updatedAt:      new Date(String(p.date_modified || p.date_created)),
    };
  }

  private async get(creds: IntegrationCredentials, path: string): Promise<unknown> {
    const res = await fetch((creds.storeUrl || '') + path, {
      headers: {
        'Authorization': 'Bearer ' + (creds.accessToken || creds.apiKey || ''),
        'Content-Type': 'application/json',
      },
    });
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
      await this.get(creds, storeHash, '/v2/store');
      return { success: true, shopName: 'BigCommerce Store', shopCurrency: 'USD', shopCountry: 'US' };
    } catch (err: unknown) {
      return { success: false, error: err instanceof Error ? err.message : 'Verbinding mislukt' };
    }
  }

  async fetchOrders(creds: IntegrationCredentials, options: FetchOptions): Promise<PaginatedResult<NormalizedOrder>> {
    const page  = options.page || 1;
    const limit = Math.min(options.limit || 250, 250);
    const params = new URLSearchParams({ page: String(page), limit: String(limit) });
    if (options.updatedAfter) params.set('min_date_modified', options.updatedAfter.toISOString());
    const storeHash = this.extractStoreHash(creds);
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
      totalInventory: parseInt(String(p.inventory_level || '0')),
      priceMin:       parseFloat(String(p.price || '0')),
      updatedAt:      new Date(String(p.date_modified || p.date_created || new Date())),
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
// ============================================================
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
        const detail     = await this.apiGet(token, '/retailer/orders/' + orderId) as Record<string, unknown>;
        const normalized = this.normalizeOrderDetail(detail);
        if (normalized.orderedAt && !isNaN(normalized.orderedAt.getTime()) && normalized.orderedAt.getTime() > 0) {
          orders.push(normalized);
        }
      } catch {
        const normalized = this.normalizeShipment(s, orderId);
        if (normalized.orderedAt && !isNaN(normalized.orderedAt.getTime()) && normalized.orderedAt.getTime() > 0) {
          orders.push(normalized);
        }
      }
    }

    return { items: orders, hasNextPage, nextPage: hasNextPage ? page + 1 : undefined };
  }

  // FIX: Incremental sync — haalt FBR + FBB op via Orders API
  // én haalt altijd alle openstaande orders op zonder tijdsfilter.
  // Zo missen open/pending orders nooit meer uit de sync.
  private async fetchViaOrders(token: string, updatedAfter: Date | undefined, page: number): Promise<PaginatedResult<NormalizedOrder>> {
    const minutesAgo = updatedAfter
      ? Math.ceil((Date.now() - updatedAfter.getTime()) / 60000)
      : 30;

    // Haal gewijzigde orders op via change-interval-minute (max 60 min)
    // én haal altijd alle open orders op in parallel
    const cappedMinutes = Math.max(1, Math.min(minutesAgo, 60));
    const useChangeInterval = minutesAgo <= 60;

    const promises: Promise<{ orders?: Record<string, unknown>[] }>[] = [
      // Altijd: open FBR orders (geen tijdsfilter — vangt nieuwe orders)
      this.apiGet(token, `/retailer/orders?status=OPEN&fulfilment-method=FBR&page=${page}`)
        .catch(() => ({ orders: [] })) as Promise<{ orders?: Record<string, unknown>[] }>,
      // Altijd: open FBB orders
      this.apiGet(token, `/retailer/orders?status=OPEN&fulfilment-method=FBB&page=${page}`)
        .catch(() => ({ orders: [] })) as Promise<{ orders?: Record<string, unknown>[] }>,
    ];

    if (useChangeInterval) {
      // Ook: recent gewijzigde orders (ALL statuses, binnen tijdsvenster)
      promises.push(
        this.apiGet(token, `/retailer/orders?status=ALL&fulfilment-method=FBR&change-interval-minute=${cappedMinutes}&page=${page}`)
          .catch(() => ({ orders: [] })) as Promise<{ orders?: Record<string, unknown>[] }>,
        this.apiGet(token, `/retailer/orders?status=ALL&fulfilment-method=FBB&change-interval-minute=${cappedMinutes}&page=${page}`)
          .catch(() => ({ orders: [] })) as Promise<{ orders?: Record<string, unknown>[] }>,
      );
    } else {
      // Als tijdsvenster te groot: gebruik shipments als fallback voor gewijzigde orders
      return this.fetchViaShipments(token, page);
    }

    const results = await Promise.all(promises);
    const allOrders = results.flatMap(r => r.orders || []);
    const hasNextPage = results.some(r => (r.orders || []).length === 50);

    // Dedupleer op orderId
    const seenOrderIds = new Set<string>();
    const orders: NormalizedOrder[] = [];

    for (const o of allOrders) {
      const orderId = String(o.orderId || '');
      if (!orderId || seenOrderIds.has(orderId)) continue;
      seenOrderIds.add(orderId);

      // Haal order detail op voor correcte prijs, datum en status
      try {
        const detail     = await this.apiGet(token, '/retailer/orders/' + orderId) as Record<string, unknown>;
        const normalized = this.normalizeOrderDetail(detail);
        if (normalized.orderedAt && !isNaN(normalized.orderedAt.getTime()) && normalized.orderedAt.getTime() > 0) {
          orders.push(normalized);
        }
      } catch {
        const normalized = this.normalizeOrderSummary(o);
        if (normalized.externalId) {
          orders.push(normalized);
        }
      }
    }

    return { items: orders, hasNextPage, nextPage: hasNextPage ? page + 1 : undefined };
  }

  // ── Normaliseer order detail (heeft volledige prijs info) ──
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
    const orderedAtRaw = o.orderPlacedDateTime ? new Date(String(o.orderPlacedDateTime)) : new Date(0);

    // Bepaal status op basis van Bol.com order status
    const bolStatus = String(o.status || 'open').toLowerCase();
    const status = bolStatus === 'open' ? 'pending'
      : bolStatus === 'shipped' ? 'completed'
      : bolStatus === 'cancelled' ? 'cancelled'
      : 'completed';

    return {
      externalId:        String(o.orderId || ''),
      externalNumber:    String(o.orderId || ''),
      totalAmount:       Math.round(totalAmount * 100) / 100,
      subtotalAmount:    Math.round((totalAmount / 1.21) * 100) / 100,
      taxAmount:         Math.round((totalAmount - totalAmount / 1.21) * 100) / 100,
      shippingAmount:    0,
      discountAmount:    0,
      currency:          'EUR',
      status,
      financialStatus:   'paid',
      fulfillmentStatus: status === 'pending' ? 'unfulfilled' : 'fulfilled',
      lineItems,
      orderedAt:         orderedAtRaw,
      updatedAt:         new Date(),
    };
  }

  // ── Normaliseer order summary (fallback — minder data) ────
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
    const bolStatus = String(o.status || 'open').toLowerCase();
    const status = bolStatus === 'open' ? 'pending' : bolStatus === 'cancelled' ? 'cancelled' : 'completed';

    return {
      externalId:        String(o.orderId || ''),
      externalNumber:    String(o.orderId || ''),
      totalAmount:       Math.round(totalAmount * 100) / 100,
      subtotalAmount:    Math.round(totalAmount * 100) / 100,
      taxAmount:         0,
      shippingAmount:    0,
      discountAmount:    0,
      currency:          'EUR',
      status,
      financialStatus:   'paid',
      fulfillmentStatus: status === 'pending' ? 'unfulfilled' : 'fulfilled',
      lineItems,
      orderedAt:         o.orderPlacedDateTime
        ? new Date(String(o.orderPlacedDateTime))
        : new Date(0),
      updatedAt: new Date(),
    };
  }

  // ── Normaliseer shipment (fallback als order detail faalt) ─
  private normalizeShipment(s: Record<string, unknown>, orderId: string): NormalizedOrder {
    const items = (s.shipmentItems as Record<string, unknown>[] | undefined) || [];
    const lineItems: NormalizedLineItem[] = items.map(item => {
      const unitPrice  = parsePrice(item.unitPrice || item.offerPrice || item.sellingPrice);
      const quantity   = safeInt(item.quantity || item.quantityShipped || 1, 1);
      const product    = item.product as Record<string, unknown> | undefined;
      const finalPrice = unitPrice > 0 ? unitPrice : parsePrice(item.fulfilmentPrice);
      return {
        externalId:     String(item.shipmentItemId || item.orderItemId || ''),
        sku:            String(item.ean || product?.ean || ''),
        title:          String(product?.title || item.title || item.ean || ''),
        quantity,
        unitPrice:      finalPrice,
        totalPrice:     Math.round(finalPrice * quantity * 100) / 100,
        discountAmount: 0,
      };
    });

    const totalAmount = lineItems.reduce((acc, li) => acc + li.totalPrice, 0);
    const orderPlaced = s.orderPlacedDateTime ? new Date(String(s.orderPlacedDateTime)) : null;
    const shipDate    = s.shipmentDate ? new Date(String(s.shipmentDate)) : null;
    const orderedAt   = orderPlaced ?? shipDate ?? new Date(0);

    return {
      externalId:        orderId,
      externalNumber:    orderId,
      totalAmount:       Math.round(totalAmount * 100) / 100,
      subtotalAmount:    Math.round((totalAmount / 1.21) * 100) / 100,
      taxAmount:         Math.round((totalAmount - totalAmount / 1.21) * 100) / 100,
      shippingAmount:    0,
      discountAmount:    0,
      currency:          'EUR',
      status:            'completed',
      financialStatus:   'paid',
      fulfillmentStatus: 'fulfilled',
      lineItems,
      orderedAt,
      updatedAt:         new Date(),
    };
  }

  async fetchProducts(creds: IntegrationCredentials, options: FetchOptions): Promise<PaginatedResult<NormalizedProduct>> {
    const token = await this.getAccessToken(creds);
    try {
      const exportRes = await this.apiPost(token, '/retailer/offers/export', { format: 'CSV' }) as { processStatusId?: string };
      const processId = exportRes.processStatusId;
      if (!processId) return { items: [], hasNextPage: false };

      let reportId: string | null = null;
      for (let i = 0; i < 10; i++) {
        await new Promise(r => setTimeout(r, 3000));
        const status = await this.apiGet(token, '/shared/process-status/' + processId) as { status?: string; entityId?: string };
        if (status.status === 'SUCCESS' && status.entityId) {
          reportId = status.entityId;
          break;
        }
        if (status.status === 'FAILURE') break;
      }

      if (!reportId) return { items: [], hasNextPage: false };

      const csv = await this.apiGetRaw(token, '/retailer/offers/export/' + reportId);
      const products = this.parseCsvOffers(csv);
      return { items: products, hasNextPage: false };
    } catch {
      return { items: [], hasNextPage: false };
    }
  }

  async fetchCustomers(creds: IntegrationCredentials, options: FetchOptions): Promise<PaginatedResult<NormalizedCustomer>> {
    return { items: [], hasNextPage: false };
  }

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
        priceMin:         price,
        updatedAt:        new Date(),
        updated_at_source: null,
      } as NormalizedProduct;
    }).filter(p => p.externalId);
  }

  private async getAccessToken(creds: IntegrationCredentials): Promise<string> {
    const cacheKey = `bolcom:token:${creds.integrationId}`;

    const memCached = tokenMemoryCache[cacheKey];
    if (memCached && memCached.expiresAt > Date.now()) return memCached.token;

    try {
      const { cache } = await import('../../../infrastructure/cache/redis');
      const cached = await cache.get(cacheKey);
      if (cached) return cached;
    } catch {}

    const clientId     = creds.apiKey     || '';
    const clientSecret = creds.apiSecret  || '';
    const credentials  = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');

    const res = await fetch('https://login.bol.com/token?grant_type=client_credentials', {
      method:  'POST',
      headers: {
        'Authorization': `Basic ${credentials}`,
        'Accept':        'application/json',
      },
    });

    if (!res.ok) throw new Error(`Bol.com auth fout: ${res.status}`);

    const d = await res.json() as { access_token: string; expires_in?: number };
    const token  = d.access_token;
    const ttlMs  = ((d.expires_in || 299) - 60) * 1000;

    tokenMemoryCache[cacheKey] = { token, expiresAt: Date.now() + ttlMs };

    try {
      const { cache } = await import('../../../infrastructure/cache/redis');
      await cache.set(cacheKey, token, Math.floor(ttlMs / 1000));
    } catch {}

    return token;
  }

  private async apiGet(token: string, path: string): Promise<unknown> {
    const res = await fetch('https://api.bol.com' + path, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Accept':        'application/vnd.retailer.v10+json',
      },
    });

    if (res.status === 429) {
      const retryAfter = parseInt(res.headers.get('Retry-After') || '5', 10);
      await new Promise(r => setTimeout(r, retryAfter * 1000));
      return this.apiGet(token, path);
    }

    if (!res.ok) throw new Error(`Bol.com API fout ${res.status} op ${path}`);
    return res.json();
  }

  private async apiGetRaw(token: string, path: string): Promise<string> {
    const res = await fetch('https://api.bol.com' + path, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Accept':        'application/vnd.retailer.v10+csv',
      },
    });
    if (!res.ok) throw new Error(`Bol.com CSV fout ${res.status}`);
    return res.text();
  }

  private async apiPost(token: string, path: string, body: unknown): Promise<unknown> {
    const res = await fetch('https://api.bol.com' + path, {
      method:  'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Accept':        'application/vnd.retailer.v10+json',
        'Content-Type':  'application/vnd.retailer.v10+json',
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`Bol.com POST fout ${res.status}`);
    return res.json();
  }
}
