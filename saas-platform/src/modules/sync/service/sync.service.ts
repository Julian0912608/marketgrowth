// ============================================================
// src/modules/sync/service/sync.service.ts
//
// Centrale sync-orchestrator.
// Haalt data op van alle gekoppelde platforms en slaat het
// genormaliseerd op in de database.
// Geschikt voor 500+ tenants via job queue (BullMQ).
// ============================================================

import { db } from '../../../infrastructure/database/connection';
import { logger } from '../../../shared/logging/logger';
import { ShopifyConnector } from '../../integrations/shopify/service/shopify.connector';
import { BolComConnector }  from '../../integrations/bolcom/service/bolcom.connector';
import { EtsyConnector }    from '../../integrations/etsy/service/etsy.connector';
import { WooCommerceConnector } from '../../integrations/woocommerce/service/woocommerce.connector';
import { AmazonConnector }  from '../../integrations/amazon/service/amazon.connector';
import { PinterestConnector } from '../../integrations/pinterest/service/pinterest.connector';
import { decryptSecret }    from '../../../shared/crypto/encryption';
import { PlatformConnector, NormalizedOrder, NormalizedProduct } from '../../integrations/base/platform-connector';

interface ConnectionRow {
  id:               string;
  tenant_id:        string;
  platform:         string;
  shop_name:        string;
  shop_url:         string;
  access_token_enc: string;
  api_key_enc:      string;
  api_secret_enc:   string;
  platform_shop_id: string;
  platform_metadata: Record<string, any>;
  last_sync_at:     Date | null;
  sync_cursor:      string | null;
}

export class SyncService {

  // ── Haal connector op voor een connection ─────────────────
  private buildConnector(conn: ConnectionRow): PlatformConnector {
    const token  = conn.access_token_enc ? decryptSecret(conn.access_token_enc) : '';
    const key    = conn.api_key_enc      ? decryptSecret(conn.api_key_enc)      : '';
    const secret = conn.api_secret_enc   ? decryptSecret(conn.api_secret_enc)   : '';

    switch (conn.platform) {
      case 'shopify':
        return new ShopifyConnector(conn.shop_url.replace('https://', ''), token);

      case 'bolcom':
        return new BolComConnector(key, secret);

      case 'etsy':
        return new EtsyConnector(conn.platform_shop_id, token);

      case 'woocommerce':
        return new WooCommerceConnector(conn.shop_url, key, secret);

      case 'amazon':
        return new AmazonConnector(
          conn.platform_shop_id,
          conn.platform_metadata?.clientId  ?? key,
          conn.platform_metadata?.clientSecret ?? secret,
          token,
          conn.platform_metadata?.marketplace
        );

      case 'pinterest':
        return new PinterestConnector(conn.platform_shop_id, token);

      default:
        throw new Error(`Onbekend platform: ${conn.platform}`);
    }
  }

  // ── Sync één connection ───────────────────────────────────
  async syncConnection(connectionId: string): Promise<{
    ordersImported: number;
    productsImported: number;
    errors: string[];
  }> {
    const result = await db.query<ConnectionRow>(
      `SELECT * FROM platform_connections WHERE id = $1`,
      [connectionId], { allowNoTenant: true }
    );

    const conn = result.rows[0];
    if (!conn) throw new Error(`Connection niet gevonden: ${connectionId}`);

    // Status op 'syncing' zetten
    await db.query(
      `UPDATE platform_connections SET status = 'syncing', updated_at = now() WHERE id = $1`,
      [connectionId], { allowNoTenant: true }
    );

    const errors: string[] = [];
    let ordersImported  = 0;
    let productsImported = 0;

    try {
      const connector = this.buildConnector(conn);

      // ── Orders sync ──────────────────────────────────────
      const since = conn.last_sync_at
        ? new Date(conn.last_sync_at)
        : new Date(Date.now() - 90 * 24 * 60 * 60 * 1000); // 90 dagen terug bij eerste sync

      let cursor = conn.sync_cursor ?? undefined;

      do {
        const { orders, nextCursor } = await connector.fetchOrders({ since, cursor });
        cursor = nextCursor;

        if (orders.length > 0) {
          const imported = await this.saveOrders(conn.tenant_id, connectionId, conn.platform, orders);
          ordersImported += imported;
        }
      } while (cursor);

      // ── Producten sync ───────────────────────────────────
      try {
        const products = await connector.fetchProducts({ since });
        if (products.length > 0) {
          productsImported = await this.saveProducts(conn.tenant_id, connectionId, conn.platform, products);
        }
      } catch (err: any) {
        errors.push(`Products: ${err.message}`);
      }

      // ── Ad Campaigns sync (indien beschikbaar) ───────────
      if (connector.fetchAdCampaigns) {
        try {
          const campaigns = await connector.fetchAdCampaigns({ since });
          if (campaigns.length > 0) {
            await this.saveCampaigns(conn.tenant_id, connectionId, conn.platform, campaigns);
          }
        } catch (err: any) {
          errors.push(`Ads: ${err.message}`);
        }
      }

      // ── Daily analytics aggregeren ───────────────────────
      await this.aggregateDailyAnalytics(conn.tenant_id, connectionId, conn.platform, since);

      // Status updaten
      await db.query(
        `UPDATE platform_connections
         SET status = 'active', last_sync_at = now(), last_error = NULL,
             sync_cursor = NULL, updated_at = now()
         WHERE id = $1`,
        [connectionId], { allowNoTenant: true }
      );

      logger.info('sync.completed', {
        connectionId, platform: conn.platform,
        ordersImported, productsImported,
        errors: errors.length,
      });

    } catch (err: any) {
      errors.push(err.message);
      await db.query(
        `UPDATE platform_connections
         SET status = 'error', last_error = $2, updated_at = now()
         WHERE id = $1`,
        [connectionId, err.message], { allowNoTenant: true }
      );
    }

    return { ordersImported, productsImported, errors };
  }

  // ── Orders opslaan ────────────────────────────────────────
  private async saveOrders(
    tenantId: string, connectionId: string, platform: string,
    orders: NormalizedOrder[]
  ): Promise<number> {
    let saved = 0;

    for (const order of orders) {
      try {
        await db.query(
          `INSERT INTO unified_orders (
            tenant_id, connection_id, platform, external_id, external_number,
            status, payment_status, fulfillment_status,
            subtotal, shipping_total, tax_total, discount_total, total, currency,
            customer_email, customer_name, customer_id_external,
            ordered_at, updated_at_platform, raw_data
          ) VALUES (
            $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20
          )
          ON CONFLICT (tenant_id, connection_id, external_id)
          DO UPDATE SET
            status = EXCLUDED.status,
            payment_status = EXCLUDED.payment_status,
            fulfillment_status = EXCLUDED.fulfillment_status,
            total = EXCLUDED.total,
            raw_data = EXCLUDED.raw_data,
            synced_at = now()`,
          [
            tenantId, connectionId, platform,
            order.externalId, order.externalNumber ?? null,
            order.status, order.paymentStatus ?? null, order.fulfillmentStatus ?? null,
            order.subtotal, order.shippingTotal, order.taxTotal, order.discountTotal,
            order.total, order.currency,
            order.customerEmail ?? null, order.customerName ?? null, order.customerIdExternal ?? null,
            order.orderedAt, order.updatedAtPlatform ?? null,
            JSON.stringify(order.rawData),
          ],
          { allowNoTenant: true }
        );
        saved++;
      } catch (err: any) {
        logger.warn('sync.order.save.failed', { externalId: order.externalId, error: err.message });
      }
    }

    return saved;
  }

  // ── Producten opslaan ─────────────────────────────────────
  private async saveProducts(
    tenantId: string, connectionId: string, platform: string,
    products: NormalizedProduct[]
  ): Promise<number> {
    let saved = 0;

    for (const p of products) {
      try {
        await db.query(
          `INSERT INTO unified_products (
            tenant_id, connection_id, platform, external_id,
            title, sku, status, price, compare_at_price,
            inventory_quantity, image_url, product_url, tags,
            raw_data, updated_at_platform
          ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
          ON CONFLICT (tenant_id, connection_id, external_id)
          DO UPDATE SET
            title = EXCLUDED.title,
            price = EXCLUDED.price,
            inventory_quantity = EXCLUDED.inventory_quantity,
            raw_data = EXCLUDED.raw_data,
            synced_at = now()`,
          [
            tenantId, connectionId, platform, p.externalId,
            p.title, p.sku ?? null, p.status ?? null,
            p.price ?? null, p.compareAtPrice ?? null,
            p.inventoryQuantity ?? null, p.imageUrl ?? null,
            p.productUrl ?? null, p.tags ?? [],
            JSON.stringify(p.rawData), p.updatedAtPlatform ?? null,
          ],
          { allowNoTenant: true }
        );
        saved++;
      } catch (err: any) {
        logger.warn('sync.product.save.failed', { externalId: p.externalId, error: err.message });
      }
    }

    return saved;
  }

  // ── Campagnes opslaan ─────────────────────────────────────
  private async saveCampaigns(
    tenantId: string, connectionId: string, platform: string, campaigns: any[]
  ): Promise<void> {
    for (const c of campaigns) {
      await db.query(
        `INSERT INTO ad_campaigns (
          tenant_id, connection_id, platform, external_id,
          name, status, spend, impressions, clicks,
          conversions, revenue, roas, raw_data
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
        ON CONFLICT (tenant_id, connection_id, external_id)
        DO UPDATE SET
          spend = EXCLUDED.spend, impressions = EXCLUDED.impressions,
          clicks = EXCLUDED.clicks, conversions = EXCLUDED.conversions,
          revenue = EXCLUDED.revenue, roas = EXCLUDED.roas,
          synced_at = now()`,
        [
          tenantId, connectionId, platform, c.externalId,
          c.name, c.status ?? null, c.spend ?? 0,
          c.impressions ?? 0, c.clicks ?? 0,
          c.conversions ?? 0, c.revenue ?? 0,
          c.roas ?? null, JSON.stringify(c.rawData),
        ],
        { allowNoTenant: true }
      );
    }
  }

  // ── Daily analytics aggregeren ────────────────────────────
  private async aggregateDailyAnalytics(
    tenantId: string, connectionId: string, platform: string, since: Date
  ): Promise<void> {
    await db.query(
      `INSERT INTO daily_analytics (
        tenant_id, connection_id, platform, date,
        orders_count, revenue, avg_order_value, items_sold,
        new_customers, refunds_count, refunds_amount
      )
      SELECT
        tenant_id, connection_id, platform,
        DATE(ordered_at) as date,
        COUNT(*) as orders_count,
        SUM(total) as revenue,
        AVG(total) as avg_order_value,
        0 as items_sold,
        0 as new_customers,
        COUNT(*) FILTER (WHERE status = 'refunded') as refunds_count,
        SUM(total) FILTER (WHERE status = 'refunded') as refunds_amount
      FROM unified_orders
      WHERE tenant_id = $1 AND connection_id = $2
        AND ordered_at >= $3
      GROUP BY tenant_id, connection_id, platform, DATE(ordered_at)
      ON CONFLICT (tenant_id, connection_id, date)
      DO UPDATE SET
        orders_count  = EXCLUDED.orders_count,
        revenue       = EXCLUDED.revenue,
        avg_order_value = EXCLUDED.avg_order_value,
        refunds_count = EXCLUDED.refunds_count,
        refunds_amount = EXCLUDED.refunds_amount`,
      [tenantId, connectionId, since], { allowNoTenant: true }
    );
  }

  // ── Alle actieve connections syncen (voor cron job) ───────
  async syncAllActive(): Promise<void> {
    const connections = await db.query<{ id: string; platform: string }>(
      `SELECT id, platform FROM platform_connections
       WHERE status IN ('active', 'error')
       ORDER BY last_sync_at ASC NULLS FIRST
       LIMIT 100`,
      [], { allowNoTenant: true }
    );

    logger.info('sync.batch.start', { count: connections.rows.length });

    for (const conn of connections.rows) {
      try {
        await this.syncConnection(conn.id);
      } catch (err: any) {
        logger.error('sync.batch.connection.failed', { connectionId: conn.id, error: err.message });
      }
    }
  }
}
