// ============================================================
// src/modules/integrations/bolcom/service/bolcom.connector.ts
//
// Bol.com Retailer API v10
// Ondersteunt: orders, producten, voorraad, verzendstatus
// Auth: Client Credentials OAuth2
// ============================================================

import axios, { AxiosInstance } from 'axios';
import {
  PlatformConnector,
  NormalizedOrder,
  NormalizedProduct,
  OrderStatus,
} from '../../base/platform-connector';
import { logger } from '../../../../shared/logging/logger';

function mapBolStatus(bolStatus: string): OrderStatus {
  const map: Record<string, OrderStatus> = {
    'OPEN':       'pending',
    'PENDING':    'processing',
    'SHIPPED':    'shipped',
    'DELIVERED':  'delivered',
    'CANCELLED':  'cancelled',
  };
  return map[bolStatus.toUpperCase()] ?? 'unknown';
}

export class BolComConnector extends PlatformConnector {
  readonly platform = 'bolcom';
  private client!: AxiosInstance;
  private accessToken?: string;
  private tokenExpiresAt?: Date;

  constructor(
    private readonly clientId: string,
    private readonly clientSecret: string
  ) {
    super();
  }

  // ── OAuth2 Client Credentials ────────────────────────────
  private async ensureAccessToken(): Promise<void> {
    if (this.accessToken && this.tokenExpiresAt && this.tokenExpiresAt > new Date()) {
      return;
    }

    const credentials = Buffer.from(`${this.clientId}:${this.clientSecret}`).toString('base64');
    const res = await axios.post(
      'https://login.bol.com/token?grant_type=client_credentials',
      null,
      {
        headers: {
          Authorization: `Basic ${credentials}`,
          Accept:        'application/json',
        },
      }
    );

    this.accessToken    = res.data.access_token;
    this.tokenExpiresAt = new Date(Date.now() + (res.data.expires_in - 60) * 1000);

    this.client = axios.create({
      baseURL: 'https://api.bol.com/retailer',
      headers: {
        Authorization:  `Bearer ${this.accessToken}`,
        Accept:         'application/vnd.retailer.v10+json',
        'Content-Type': 'application/vnd.retailer.v10+json',
      },
      timeout: 30_000,
    });
  }

  // ── Test connectie ────────────────────────────────────────
  async testConnection(): Promise<{ ok: boolean; shopName?: string; error?: string }> {
    try {
      await this.ensureAccessToken();
      // Test door een simpele orders-aanroep te doen
      await this.client.get('/orders', { params: { 'fulfilment-method': 'FBR', page: 1 } });
      return { ok: true, shopName: 'Bol.com Store' };
    } catch (err: any) {
      return { ok: false, error: err.message };
    }
  }

  // ── Orders ophalen ────────────────────────────────────────
  async fetchOrders(opts: { since?: Date; cursor?: string; limit?: number }) {
    await this.ensureAccessToken();

    const allOrders: NormalizedOrder[] = [];
    let page = opts.cursor ? parseInt(opts.cursor, 10) : 1;
    let hasMore = true;

    while (hasMore) {
      const res = await this.client.get('/orders', {
        params: {
          'fulfilment-method': 'FBR',  // Fulfilled By Retailer
          page,
        },
      });

      const orders = res.data?.orders ?? [];
      if (orders.length === 0) { hasMore = false; break; }

      // Bol.com geeft alleen order summaries — detail ophalen per order
      for (const orderSummary of orders) {
        try {
          const detail = await this.client.get(`/orders/${orderSummary.orderId}`);
          const o = detail.data;

          const lineItems = (o.orderItems ?? []).map((item: any) => ({
            externalId:   String(item.orderItemId),
            productIdExt: item.ean,
            title:        item.product?.title ?? item.ean,
            sku:          item.ean,
            quantity:     item.quantity ?? 1,
            unitPrice:    item.unitPrice ?? 0,
            totalPrice:   (item.unitPrice ?? 0) * (item.quantity ?? 1),
          }));

          const total = lineItems.reduce((sum: number, li: any) => sum + li.totalPrice, 0);

          allOrders.push({
            externalId:        String(o.orderId),
            externalNumber:    o.orderId,
            status:            mapBolStatus(o.orderItems?.[0]?.fulfilment?.status ?? 'OPEN'),
            paymentStatus:     'paid',  // Bol.com betaalt altijd vooraf
            fulfillmentStatus: o.orderItems?.[0]?.fulfilment?.status,
            subtotal:          total,
            shippingTotal:     0,
            taxTotal:          0,
            discountTotal:     0,
            total,
            currency:          'EUR',
            customerEmail:     o.billingDetails?.email,
            customerName:      o.billingDetails
              ? `${o.billingDetails.firstName ?? ''} ${o.billingDetails.surname ?? ''}`.trim()
              : undefined,
            orderedAt:         new Date(o.orderPlacedDateTime),
            updatedAtPlatform: new Date(o.orderPlacedDateTime),
            lineItems,
            rawData:           o,
          });
        } catch (err: any) {
          logger.warn('bolcom.order.detail.failed', { orderId: orderSummary.orderId, error: err.message });
        }
      }

      // Bol.com pagineert met vaste pagina's van 50
      hasMore = orders.length === 50;
      page++;

      // Respecteer Bol.com rate limit: max 60 req/min
      await new Promise(r => setTimeout(r, 250));
    }

    logger.info('bolcom.orders.fetched', { count: allOrders.length });
    return { orders: allOrders, nextCursor: undefined };
  }

  // ── Producten ophalen ─────────────────────────────────────
  async fetchProducts(opts: { since?: Date; limit?: number }): Promise<NormalizedProduct[]> {
    await this.ensureAccessToken();

    const allProducts: NormalizedProduct[] = [];
    let page = 1;
    let hasMore = true;

    while (hasMore) {
      const res = await this.client.get('/inventory', {
        params: { page, 'stock-type': 'SELLABLE' },
      });

      const items = res.data?.inventory ?? [];
      if (items.length === 0) { hasMore = false; break; }

      for (const item of items) {
        allProducts.push({
          externalId:        item.ean,
          title:             item.title ?? item.ean,
          sku:               item.ean,
          status:            item.forecastVolume > 0 ? 'active' : 'low_stock',
          price:             item.price,
          inventoryQuantity: item.stock?.regularStock ?? 0,
          rawData:           item,
        });
      }

      hasMore = items.length === 50;
      page++;
      await new Promise(r => setTimeout(r, 250));
    }

    logger.info('bolcom.products.fetched', { count: allProducts.length });
    return allProducts;
  }
}
