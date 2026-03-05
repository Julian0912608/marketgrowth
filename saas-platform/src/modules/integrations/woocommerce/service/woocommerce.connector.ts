// ============================================================
// src/modules/integrations/woocommerce/service/woocommerce.connector.ts
//
// WooCommerce REST API v3
// Auth: Consumer Key + Consumer Secret (Basic Auth over HTTPS)
// ============================================================

import axios, { AxiosInstance } from 'axios';
import {
  PlatformConnector,
  NormalizedOrder,
  NormalizedProduct,
  OrderStatus,
} from '../../base/platform-connector';
import { logger } from '../../../../shared/logging/logger';

function mapWooStatus(status: string): OrderStatus {
  const map: Record<string, OrderStatus> = {
    'pending':    'pending',
    'processing': 'processing',
    'on-hold':    'pending',
    'completed':  'delivered',
    'cancelled':  'cancelled',
    'refunded':   'refunded',
    'failed':     'cancelled',
    'shipped':    'shipped',
  };
  return map[status] ?? 'unknown';
}

export class WooCommerceConnector extends PlatformConnector {
  readonly platform = 'woocommerce';
  private client: AxiosInstance;

  constructor(
    private readonly siteUrl: string,
    private readonly consumerKey: string,
    private readonly consumerSecret: string
  ) {
    super();
    this.client = axios.create({
      baseURL: `${siteUrl}/wp-json/wc/v3`,
      auth: { username: consumerKey, password: consumerSecret },
      timeout: 30_000,
    });
  }

  async testConnection(): Promise<{ ok: boolean; shopName?: string; error?: string }> {
    try {
      const res = await this.client.get('/system_status');
      return { ok: true, shopName: res.data.settings?.title ?? this.siteUrl };
    } catch (err: any) {
      return { ok: false, error: err.message };
    }
  }

  async fetchOrders(opts: { since?: Date; cursor?: string; limit?: number }) {
    const allOrders: NormalizedOrder[] = [];
    let page = opts.cursor ? parseInt(opts.cursor, 10) : 1;
    const perPage = 100;
    let hasMore = true;

    while (hasMore) {
      const params: Record<string, any> = { per_page: perPage, page, orderby: 'date', order: 'desc' };
      if (opts.since) params.after = opts.since.toISOString();

      const res = await this.client.get('/orders', { params });
      const orders = res.data ?? [];
      if (orders.length === 0) { hasMore = false; break; }

      for (const o of orders) {
        allOrders.push({
          externalId:        String(o.id),
          externalNumber:    o.number,
          status:            mapWooStatus(o.status),
          paymentStatus:     o.payment_method ? 'paid' : 'pending',
          fulfillmentStatus: o.status,
          subtotal:          parseFloat(o.subtotal ?? '0'),
          shippingTotal:     parseFloat(o.shipping_total ?? '0'),
          taxTotal:          parseFloat(o.total_tax ?? '0'),
          discountTotal:     parseFloat(o.discount_total ?? '0'),
          total:             parseFloat(o.total ?? '0'),
          currency:          o.currency ?? 'EUR',
          customerEmail:     o.billing?.email,
          customerName:      `${o.billing?.first_name ?? ''} ${o.billing?.last_name ?? ''}`.trim(),
          customerIdExternal: o.customer_id ? String(o.customer_id) : undefined,
          orderedAt:         new Date(o.date_created),
          updatedAtPlatform: new Date(o.date_modified),
          lineItems:         (o.line_items ?? []).map((li: any) => ({
            externalId:   String(li.id),
            productIdExt: li.product_id ? String(li.product_id) : undefined,
            title:        li.name,
            sku:          li.sku,
            quantity:     li.quantity,
            unitPrice:    parseFloat(li.price ?? '0'),
            totalPrice:   parseFloat(li.total ?? '0'),
          })),
          rawData: o,
        });
      }

      hasMore = orders.length === perPage;
      page++;
    }

    logger.info('woocommerce.orders.fetched', { count: allOrders.length });
    return { orders: allOrders };
  }

  async fetchProducts(opts: { since?: Date; limit?: number }): Promise<NormalizedProduct[]> {
    const allProducts: NormalizedProduct[] = [];
    let page = 1;
    let hasMore = true;

    while (hasMore) {
      const params: Record<string, any> = { per_page: 100, page, status: 'publish' };
      if (opts.since) params.after = opts.since.toISOString();

      const res = await this.client.get('/products', { params });
      const products = res.data ?? [];
      if (products.length === 0) { hasMore = false; break; }

      for (const p of products) {
        allProducts.push({
          externalId:        String(p.id),
          title:             p.name,
          sku:               p.sku,
          status:            p.status,
          price:             parseFloat(p.price ?? '0'),
          compareAtPrice:    p.regular_price ? parseFloat(p.regular_price) : undefined,
          inventoryQuantity: p.stock_quantity ?? undefined,
          imageUrl:          p.images?.[0]?.src,
          productUrl:        p.permalink,
          tags:              (p.tags ?? []).map((t: any) => t.name),
          updatedAtPlatform: new Date(p.date_modified),
          rawData:           p,
        });
      }

      hasMore = products.length === 100;
      page++;
    }

    logger.info('woocommerce.products.fetched', { count: allProducts.length });
    return allProducts;
  }
}
