// ============================================================
// src/modules/integrations/etsy/service/etsy.connector.ts
//
// Etsy Open API v3
// Ondersteunt: orders (receipts), listings, shop stats, ads
// Auth: OAuth2 PKCE
// ============================================================

import axios, { AxiosInstance } from 'axios';
import {
  PlatformConnector,
  NormalizedOrder,
  NormalizedProduct,
  NormalizedAdCampaign,
  OrderStatus,
} from '../../base/platform-connector';
import { logger } from '../../../../shared/logging/logger';

function mapEtsyStatus(status: string): OrderStatus {
  const map: Record<string, OrderStatus> = {
    'paid':       'processing',
    'completed':  'delivered',
    'open':       'pending',
    'cancelled':  'cancelled',
  };
  return map[status.toLowerCase()] ?? 'unknown';
}

export class EtsyConnector extends PlatformConnector {
  readonly platform = 'etsy';
  private client: AxiosInstance;

  constructor(
    private readonly shopId: string,
    private readonly accessToken: string,
    private readonly refreshToken?: string
  ) {
    super();
    this.client = axios.create({
      baseURL: 'https://openapi.etsy.com/v3',
      headers: {
        Authorization:   `Bearer ${accessToken}`,
        'x-api-key':     process.env.ETSY_API_KEY!,
        'Content-Type':  'application/json',
      },
      timeout: 30_000,
    });
  }

  async testConnection(): Promise<{ ok: boolean; shopName?: string; error?: string }> {
    try {
      const res = await this.client.get(`/application/shops/${this.shopId}`);
      return { ok: true, shopName: res.data.shop_name };
    } catch (err: any) {
      return { ok: false, error: err.message };
    }
  }

  async fetchOrders(opts: { since?: Date; cursor?: string; limit?: number }) {
    const allOrders: NormalizedOrder[] = [];
    let offset = opts.cursor ? parseInt(opts.cursor, 10) : 0;
    const limit = opts.limit ?? 100;
    let hasMore = true;

    while (hasMore) {
      const params: Record<string, any> = { limit, offset };
      if (opts.since) params.min_created = Math.floor(opts.since.getTime() / 1000);

      const res = await this.client.get(
        `/application/shops/${this.shopId}/receipts`,
        { params }
      );

      const receipts = res.data?.results ?? [];
      if (receipts.length === 0) { hasMore = false; break; }

      for (const r of receipts) {
        const lineItems = (r.transactions ?? []).map((t: any) => ({
          externalId:   String(t.transaction_id),
          productIdExt: t.listing_id ? String(t.listing_id) : undefined,
          title:        t.title,
          sku:          t.sku,
          quantity:     t.quantity,
          unitPrice:    (t.price?.amount ?? 0) / (t.price?.divisor ?? 100),
          totalPrice:   ((t.price?.amount ?? 0) / (t.price?.divisor ?? 100)) * t.quantity,
        }));

        allOrders.push({
          externalId:        String(r.receipt_id),
          externalNumber:    String(r.receipt_id),
          status:            mapEtsyStatus(r.status),
          paymentStatus:     r.is_paid ? 'paid' : 'pending',
          fulfillmentStatus: r.is_shipped ? 'shipped' : undefined,
          subtotal:          (r.subtotal?.amount ?? 0) / (r.subtotal?.divisor ?? 100),
          shippingTotal:     (r.total_shipping_cost?.amount ?? 0) / (r.total_shipping_cost?.divisor ?? 100),
          taxTotal:          (r.total_tax_cost?.amount ?? 0) / (r.total_tax_cost?.divisor ?? 100),
          discountTotal:     (r.discount_amt?.amount ?? 0) / (r.discount_amt?.divisor ?? 100),
          total:             (r.grandtotal?.amount ?? 0) / (r.grandtotal?.divisor ?? 100),
          currency:          r.grandtotal?.currency_code ?? 'USD',
          customerEmail:     r.buyer_email,
          customerName:      r.name,
          orderedAt:         new Date(r.create_timestamp * 1000),
          updatedAtPlatform: new Date(r.update_timestamp * 1000),
          lineItems,
          rawData:           r,
        });
      }

      hasMore = receipts.length === limit;
      offset += limit;
      await new Promise(r => setTimeout(r, 200));
    }

    logger.info('etsy.orders.fetched', { count: allOrders.length });
    return { orders: allOrders };
  }

  async fetchProducts(opts: { since?: Date; limit?: number }): Promise<NormalizedProduct[]> {
    const allProducts: NormalizedProduct[] = [];
    let offset = 0;
    const limit = opts.limit ?? 100;
    let hasMore = true;

    while (hasMore) {
      const res = await this.client.get(
        `/application/shops/${this.shopId}/listings/active`,
        { params: { limit, offset } }
      );

      const listings = res.data?.results ?? [];
      if (listings.length === 0) { hasMore = false; break; }

      for (const l of listings) {
        allProducts.push({
          externalId:       String(l.listing_id),
          title:            l.title,
          status:           l.state,
          price:            (l.price?.amount ?? 0) / (l.price?.divisor ?? 100),
          inventoryQuantity: l.quantity,
          imageUrl:         l.images?.[0]?.url_570xN,
          productUrl:       l.url,
          tags:             l.tags ?? [],
          updatedAtPlatform: new Date(l.last_modified_timestamp * 1000),
          rawData:          l,
        });
      }

      hasMore = listings.length === limit;
      offset += limit;
      await new Promise(r => setTimeout(r, 200));
    }

    logger.info('etsy.products.fetched', { count: allProducts.length });
    return allProducts;
  }

  async fetchAdCampaigns(): Promise<NormalizedAdCampaign[]> {
    try {
      const res = await this.client.get(
        `/application/shops/${this.shopId}/ads/listings`
      );
      const ads = res.data?.results ?? [];
      return ads.map((ad: any) => ({
        externalId:  String(ad.listing_id),
        name:        `Etsy Ad: ${ad.listing_id}`,
        status:      ad.is_ads_opted_in ? 'active' : 'paused',
        spend:       (ad.daily_budget?.amount ?? 0) / (ad.daily_budget?.divisor ?? 100),
        rawData:     ad,
      }));
    } catch {
      return [];
    }
  }
}
