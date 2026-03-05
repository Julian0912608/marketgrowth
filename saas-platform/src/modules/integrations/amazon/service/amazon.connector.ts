// ============================================================
// src/modules/integrations/amazon/service/amazon.connector.ts
//
// Amazon Selling Partner API (SP-API)
// ⚠️  Vereist aparte Amazon developer registratie + goedkeuring
// Ondersteunt: orders, inventory, FBA, advertising
// Auth: LWA (Login With Amazon) OAuth2 + AWS SigV4
// ============================================================

import axios from 'axios';
import {
  PlatformConnector,
  NormalizedOrder,
  NormalizedProduct,
  NormalizedAdCampaign,
  OrderStatus,
} from '../../base/platform-connector';
import { logger } from '../../../../shared/logging/logger';

function mapAmazonStatus(status: string): OrderStatus {
  const map: Record<string, OrderStatus> = {
    'Pending':          'pending',
    'Unshipped':        'processing',
    'PartiallyShipped': 'shipped',
    'Shipped':          'shipped',
    'Delivered':        'delivered',
    'Canceled':         'cancelled',
    'Unfulfillable':    'cancelled',
  };
  return map[status] ?? 'unknown';
}

export class AmazonConnector extends PlatformConnector {
  readonly platform = 'amazon';

  private accessToken?: string;
  private tokenExpiresAt?: Date;

  constructor(
    private readonly sellerId: string,
    private readonly clientId: string,       // LWA Client ID
    private readonly clientSecret: string,   // LWA Client Secret
    private readonly refreshToken: string,   // LWA Refresh Token
    private readonly marketplace: string = 'A1F83G8C2ARO7P'  // EU (UK) default
  ) {
    super();
  }

  // ── LWA Token ophalen ─────────────────────────────────────
  private async ensureAccessToken(): Promise<void> {
    if (this.accessToken && this.tokenExpiresAt && this.tokenExpiresAt > new Date()) return;

    const res = await axios.post('https://api.amazon.com/auth/o2/token', {
      grant_type:    'refresh_token',
      client_id:     this.clientId,
      client_secret: this.clientSecret,
      refresh_token: this.refreshToken,
    });

    this.accessToken    = res.data.access_token;
    this.tokenExpiresAt = new Date(Date.now() + (res.data.expires_in - 60) * 1000);
  }

  private getClient() {
    return axios.create({
      baseURL: 'https://sellingpartnerapi-eu.amazon.com',
      headers: {
        'x-amz-access-token': this.accessToken!,
        'Content-Type':       'application/json',
      },
      timeout: 30_000,
    });
  }

  async testConnection(): Promise<{ ok: boolean; shopName?: string; error?: string }> {
    try {
      await this.ensureAccessToken();
      const res = await this.getClient().get(
        `/sellers/v1/marketplaceParticipations`
      );
      const participations = res.data?.payload ?? [];
      const marketplace = participations.find(
        (p: any) => p.marketplace?.id === this.marketplace
      );
      return {
        ok:       true,
        shopName: `Amazon (${marketplace?.marketplace?.countryCode ?? 'EU'})`,
      };
    } catch (err: any) {
      return { ok: false, error: err.message };
    }
  }

  async fetchOrders(opts: { since?: Date; cursor?: string; limit?: number }) {
    await this.ensureAccessToken();
    const client = this.getClient();
    const allOrders: NormalizedOrder[] = [];
    let nextToken = opts.cursor;
    let firstCall = true;

    while (firstCall || nextToken) {
      firstCall = false;
      const params: Record<string, any> = {
        MarketplaceIds: this.marketplace,
        OrderStatuses:  'Unshipped,PartiallyShipped,Shipped,Delivered,Canceled',
      };
      if (opts.since && !nextToken) {
        params.CreatedAfter = opts.since.toISOString();
      }
      if (nextToken) params.NextToken = nextToken;

      const res = await client.get('/orders/v0/orders', { params });
      const payload = res.data?.payload;
      nextToken = payload?.NextToken;

      for (const o of payload?.Orders ?? []) {
        // Order items ophalen
        const itemsRes = await client.get(`/orders/v0/orders/${o.AmazonOrderId}/orderItems`);
        const items = itemsRes.data?.payload?.OrderItems ?? [];

        const lineItems = items.map((li: any) => ({
          externalId:   li.OrderItemId,
          productIdExt: li.ASIN,
          title:        li.Title,
          sku:          li.SellerSKU,
          quantity:     li.QuantityOrdered,
          unitPrice:    parseFloat(li.ItemPrice?.Amount ?? '0') / li.QuantityOrdered,
          totalPrice:   parseFloat(li.ItemPrice?.Amount ?? '0'),
        }));

        const total = parseFloat(o.OrderTotal?.Amount ?? '0');

        allOrders.push({
          externalId:        o.AmazonOrderId,
          externalNumber:    o.AmazonOrderId,
          status:            mapAmazonStatus(o.OrderStatus),
          paymentStatus:     o.PaymentMethod,
          fulfillmentStatus: o.FulfillmentChannel, // AFN = Amazon, MFN = Seller
          subtotal:          total,
          shippingTotal:     0,
          taxTotal:          0,
          discountTotal:     0,
          total,
          currency:          o.OrderTotal?.CurrencyCode ?? 'EUR',
          customerEmail:     o.BuyerInfo?.BuyerEmail,
          customerName:      o.BuyerInfo?.BuyerName,
          orderedAt:         new Date(o.PurchaseDate),
          updatedAtPlatform: new Date(o.LastUpdateDate),
          lineItems,
          rawData:           o,
        });

        // Amazon rate limit: 0.0167 req/sec voor orders
        await new Promise(r => setTimeout(r, 1000));
      }
    }

    logger.info('amazon.orders.fetched', { count: allOrders.length });
    return { orders: allOrders, nextCursor: nextToken };
  }

  async fetchProducts(opts: { since?: Date }): Promise<NormalizedProduct[]> {
    await this.ensureAccessToken();
    const client = this.getClient();
    const allProducts: NormalizedProduct[] = [];
    let nextToken: string | undefined;
    let firstCall = true;

    while (firstCall || nextToken) {
      firstCall = false;
      const params: Record<string, any> = { MarketplaceIds: this.marketplace };
      if (nextToken) params.nextToken = nextToken;

      const res = await client.get('/fba/inventory/v1/summaries', {
        params: { ...params, details: true, granularityType: 'Marketplace', granularityId: this.marketplace },
      });

      const payload = res.data?.payload;
      nextToken = payload?.pagination?.nextToken;

      for (const item of payload?.inventorySummaries ?? []) {
        allProducts.push({
          externalId:        item.asin,
          title:             item.productName ?? item.asin,
          sku:               item.sellerSku,
          status:            item.condition,
          inventoryQuantity: item.inventoryDetails?.fulfillableQuantity ?? 0,
          rawData:           item,
        });
      }

      await new Promise(r => setTimeout(r, 500));
    }

    logger.info('amazon.products.fetched', { count: allProducts.length });
    return allProducts;
  }

  async fetchAdCampaigns(opts: { since?: Date; until?: Date }): Promise<NormalizedAdCampaign[]> {
    // Amazon Advertising API is een aparte API met eigen OAuth
    // Vereist: amazon-advertising-api-sdk of directe calls naar
    // https://advertising.amazon.com/API/docs
    logger.info('amazon.ads.not_implemented');
    return [];
  }
}
