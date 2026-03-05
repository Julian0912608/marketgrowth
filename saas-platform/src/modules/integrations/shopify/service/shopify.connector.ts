// ============================================================
// src/modules/integrations/shopify/service/shopify.connector.ts
//
// Volledige Shopify connector via de REST Admin API.
// Ondersteunt: orders, producten, klanten, Shopify Analytics
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

// Shopify order status mapping
function mapShopifyStatus(financialStatus: string, fulfillmentStatus: string | null): OrderStatus {
  if (financialStatus === 'refunded')   return 'refunded';
  if (financialStatus === 'voided')     return 'cancelled';
  if (fulfillmentStatus === 'fulfilled') return 'delivered';
  if (fulfillmentStatus === 'partial')   return 'shipped';
  if (financialStatus === 'paid')        return 'processing';
  if (financialStatus === 'pending')     return 'pending';
  return 'unknown';
}

export class ShopifyConnector extends PlatformConnector {
  readonly platform = 'shopify';
  private client: AxiosInstance;

  constructor(
    private readonly shopDomain: string,  // bijv. mystore.myshopify.com
    private readonly accessToken: string
  ) {
    super();
    this.client = axios.create({
      baseURL: `https://${shopDomain}/admin/api/2024-01`,
      headers: {
        'X-Shopify-Access-Token': accessToken,
        'Content-Type': 'application/json',
      },
      timeout: 30_000,
    });

    // Rate limit handling: Shopify gebruikt 2 req/sec (40 bucket)
    // Bij 429: wacht en retry
    this.client.interceptors.response.use(
      (res: any) => res,
      async (err: any) => {
        if (err.response?.status === 429) {
          const retryAfter = parseInt(err.response.headers['retry-after'] ?? '2', 10);
          await new Promise(r => setTimeout(r, retryAfter * 1000));
          return this.client(err.config);
        }
        throw err;
      }
    );
  }

  // ── Test connectie ────────────────────────────────────────
  async testConnection(): Promise<{ ok: boolean; shopName?: string; error?: string }> {
    try {
      const res = await this.client.get('/shop.json');
      return { ok: true, shopName: res.data.shop.name };
    } catch (err: any) {
      return { ok: false, error: err.message };
    }
  }

  // ── Orders ophalen ────────────────────────────────────────
  async fetchOrders(opts: { since?: Date; cursor?: string; limit?: number }) {
    const params: Record<string, string | number> = {
      limit:  opts.limit ?? 250,
      status: 'any',
    };

    if (opts.since) {
      params.updated_at_min = opts.since.toISOString();
    }
    if (opts.cursor) {
      params.page_info = opts.cursor;
    }

    const res = await this.client.get('/orders.json', { params });
    const shopifyOrders = res.data.orders ?? [];

    // Volgende pagina cursor uit Link header
    const linkHeader = res.headers['link'] as string | undefined;
    const nextCursor = this.extractNextCursor(linkHeader);

    const orders: NormalizedOrder[] = shopifyOrders.map((o: any) => ({
      externalId:         String(o.id),
      externalNumber:     o.order_number ? String(o.order_number) : undefined,
      status:             mapShopifyStatus(o.financial_status, o.fulfillment_status),
      paymentStatus:      o.financial_status,
      fulfillmentStatus:  o.fulfillment_status,
      subtotal:           parseFloat(o.subtotal_price ?? '0'),
      shippingTotal:      parseFloat(o.total_shipping_price_set?.shop_money?.amount ?? '0'),
      taxTotal:           parseFloat(o.total_tax ?? '0'),
      discountTotal:      parseFloat(o.total_discounts ?? '0'),
      total:              parseFloat(o.total_price ?? '0'),
      currency:           o.currency ?? 'EUR',
      customerEmail:      o.email,
      customerName:       o.billing_address
        ? `${o.billing_address.first_name ?? ''} ${o.billing_address.last_name ?? ''}`.trim()
        : o.customer ? `${o.customer.first_name ?? ''} ${o.customer.last_name ?? ''}`.trim() : undefined,
      customerIdExternal: o.customer?.id ? String(o.customer.id) : undefined,
      orderedAt:          new Date(o.created_at),
      updatedAtPlatform:  new Date(o.updated_at),
      lineItems:          (o.line_items ?? []).map((li: any) => ({
        externalId:   String(li.id),
        productIdExt: li.product_id ? String(li.product_id) : undefined,
        title:        li.title,
        sku:          li.sku,
        quantity:     li.quantity,
        unitPrice:    parseFloat(li.price ?? '0'),
        totalPrice:   parseFloat(li.price ?? '0') * li.quantity,
      })),
      rawData: o,
    }));

    logger.info('shopify.orders.fetched', {
      count: orders.length,
      shopDomain: this.shopDomain,
    });

    return { orders, nextCursor };
  }

  // ── Producten ophalen ─────────────────────────────────────
  async fetchProducts(opts: { since?: Date; limit?: number }): Promise<NormalizedProduct[]> {
    const params: Record<string, string | number> = {
      limit: opts.limit ?? 250,
    };
    if (opts.since) params.updated_at_min = opts.since.toISOString();

    const allProducts: NormalizedProduct[] = [];
    let pageInfo: string | undefined;

    do {
      const res = await this.client.get('/products.json', {
        params: pageInfo ? { limit: 250, page_info: pageInfo } : params,
      });

      const products = res.data.products ?? [];
      pageInfo = this.extractNextCursor(res.headers['link']);

      for (const p of products) {
        // Hoofdvariant gebruiken voor prijs/SKU
        const mainVariant = p.variants?.[0];
        allProducts.push({
          externalId:         String(p.id),
          title:              p.title,
          sku:                mainVariant?.sku,
          status:             p.status,
          price:              mainVariant ? parseFloat(mainVariant.price) : undefined,
          compareAtPrice:     mainVariant?.compare_at_price
            ? parseFloat(mainVariant.compare_at_price) : undefined,
          inventoryQuantity:  mainVariant?.inventory_quantity,
          imageUrl:           p.image?.src,
          productUrl:         `https://${this.shopDomain}/products/${p.handle}`,
          tags:               p.tags ? p.tags.split(',').map((t: string) => t.trim()) : [],
          updatedAtPlatform:  new Date(p.updated_at),
          rawData:            p,
        });
      }
    } while (pageInfo);

    logger.info('shopify.products.fetched', { count: allProducts.length });
    return allProducts;
  }

  // ── Shopify Marketing / Ads data ──────────────────────────
  // Shopify heeft geen directe ads API — dit haalt Marketing Events op
  async fetchAdCampaigns(opts: { since?: Date }): Promise<NormalizedAdCampaign[]> {
    try {
      const res = await this.client.get('/marketing_events.json', {
        params: { limit: 250 },
      });
      const events = res.data.marketing_events ?? [];

      return events.map((e: any) => ({
        externalId:  String(e.id),
        name:        e.event_target ?? e.utm_campaign ?? 'Unknown campaign',
        status:      e.started_at && !e.ended_at ? 'active' : 'completed',
        spend:       0,  // Shopify Marketing Events bevatten geen spend
        impressions: e.impressions_count ?? 0,
        clicks:      e.clicks_count ?? 0,
        conversions: e.orders_count ?? 0,
        revenue:     e.sales_amount ? parseFloat(e.sales_amount) : 0,
        periodStart: e.started_at ? new Date(e.started_at) : undefined,
        periodEnd:   e.ended_at   ? new Date(e.ended_at)   : undefined,
        rawData:     e,
      }));
    } catch {
      return [];  // Marketing Events zijn optioneel
    }
  }

  // ── Helper: Link header cursor parsen ────────────────────
  private extractNextCursor(linkHeader?: string): string | undefined {
    if (!linkHeader) return undefined;
    const match = linkHeader.match(/<[^>]*[?&]page_info=([^&>]+)[^>]*>;\s*rel="next"/);
    return match ? match[1] : undefined;
  }
}
