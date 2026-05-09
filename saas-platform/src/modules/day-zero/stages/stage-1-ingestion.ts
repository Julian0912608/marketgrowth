// ============================================================
// src/modules/day-zero/stages/stage-1-ingestion.ts
//
// Stage 1 (0:00 -> 0:02): Ingestion.
// Aggregeert wat al in onze DB staat na de Step 4 store-connect sync.
// Geen externe API calls hier: Step 4 heeft al een full sync gestart.
//
// Schema bron: information_schema verificatie 9 mei 2026.
// Indexen gebruikt: idx_orders_tenant_ordered_at, idx_products_tenant,
// idx_customers_tenant. Alle queries hebben tenant_id als eerste filter.
// ============================================================

import { db } from '../../../infrastructure/database/connection';
import { logger } from '../../../shared/logging/logger';
import { Stage1IngestionOutput } from '../types/day-zero.types';

const TWELVE_MONTHS_INTERVAL = "INTERVAL '12 months'";

export class Stage1IngestionService {

  async run(tenantId: string): Promise<Stage1IngestionOutput> {
    const startedAt = Date.now();
    const warnings: string[] = [];

    logger.info('day_zero.stage1.start', { tenantId });

    const [integrations, ordersAgg, ordersByStatus, ordersByPlatform, products, customers] = await Promise.all([
      this.fetchIntegrations(tenantId),
      this.fetchOrdersAggregate(tenantId),
      this.fetchOrdersByStatus(tenantId),
      this.fetchOrdersByPlatform(tenantId),
      this.fetchProducts(tenantId),
      this.fetchCustomers(tenantId),
    ]);

    if (integrations.length === 0) {
      warnings.push('No connected integrations found at Day Zero start.');
    }
    if (ordersAgg.count === 0) {
      warnings.push('No orders in the last 12 months. Plan generation will treat this as a brand-new shop.');
    }
    if (products.count === 0) {
      warnings.push('No products synced. Brand voice extraction in Stage 2 will skip.');
    }

    const output: Stage1IngestionOutput = {
      integrations,
      orders_12m: {
        count:            ordersAgg.count,
        revenue_excl_vat: round2(ordersAgg.revenue_excl_vat),
        revenue_incl_vat: round2(ordersAgg.revenue_incl_vat),
        first_order_at:   ordersAgg.first_order_at,
        last_order_at:    ordersAgg.last_order_at,
        by_status:        ordersByStatus,
        by_platform:      ordersByPlatform,
        avg_order_value:  ordersAgg.count > 0
          ? round2(ordersAgg.revenue_excl_vat / ordersAgg.count)
          : null,
      },
      products: {
        count:              products.count,
        active:             products.active,
        with_description:   products.with_description,
        with_image:         products.with_image,
        avg_price_excl_vat: products.avg_price_excl_vat,
      },
      customers: {
        count:          customers.count,
        with_orders:    customers.with_orders,
        high_ltv_count: Math.max(1, Math.floor(customers.count * 0.1)),
        repeat_count:   customers.repeat_count,
      },
      ingestion_completed_at: new Date().toISOString(),
      warnings,
    };

    logger.info('day_zero.stage1.done', {
      tenantId,
      durationMs: Date.now() - startedAt,
      orders:     output.orders_12m.count,
      products:   output.products.count,
      customers:  output.customers.count,
      warnings:   warnings.length,
    });

    return output;
  }

  // --------------------------------------------------------------
  // Sub-fetches
  // --------------------------------------------------------------

  private async fetchIntegrations(tenantId: string): Promise<Stage1IngestionOutput['integrations']> {
    const result = await db.query<{
      id:                string;
      platform_slug:     string;
      shop_name:         string | null;
      shop_country:      string;
      last_full_sync_at: string | null;
    }>(
      `SELECT id, platform_slug, shop_name, shop_country, last_full_sync_at
       FROM tenant_integrations
       WHERE tenant_id = $1 AND status = 'active'`,
      [tenantId],
      { allowNoTenant: true }
    );

    return result.rows.map((row) => ({
      id:           row.id,
      platform:     row.platform_slug,
      shop_name:    row.shop_name,
      shop_country: row.shop_country,
      synced_at:    row.last_full_sync_at,
    }));
  }

  private async fetchOrdersAggregate(tenantId: string): Promise<{
    count:            number;
    revenue_incl_vat: number;
    revenue_excl_vat: number;
    first_order_at:   string | null;
    last_order_at:    string | null;
  }> {
    const result = await db.query<{
      count:            string;
      revenue_incl_vat: string | null;
      revenue_excl_vat: string | null;
      first_order_at:   string | null;
      last_order_at:    string | null;
    }>(
      `SELECT
         COUNT(*)::text                                            AS count,
         COALESCE(SUM(total_amount), 0)::text                      AS revenue_incl_vat,
         COALESCE(SUM(total_amount - tax_amount), 0)::text         AS revenue_excl_vat,
         MIN(ordered_at)                                           AS first_order_at,
         MAX(ordered_at)                                           AS last_order_at
       FROM orders
       WHERE tenant_id = $1
         AND ordered_at >= now() - ${TWELVE_MONTHS_INTERVAL}`,
      [tenantId],
      { allowNoTenant: true }
    );

    const row = result.rows[0];
    return {
      count:            parseInt(row.count, 10),
      revenue_incl_vat: parseFloat(row.revenue_incl_vat ?? '0'),
      revenue_excl_vat: parseFloat(row.revenue_excl_vat ?? '0'),
      first_order_at:   row.first_order_at,
      last_order_at:    row.last_order_at,
    };
  }

  private async fetchOrdersByStatus(tenantId: string): Promise<Record<string, number>> {
    const result = await db.query<{ status: string; count: string }>(
      `SELECT status, COUNT(*)::text AS count
       FROM orders
       WHERE tenant_id = $1
         AND ordered_at >= now() - ${TWELVE_MONTHS_INTERVAL}
       GROUP BY status`,
      [tenantId],
      { allowNoTenant: true }
    );

    const breakdown: Record<string, number> = {};
    for (const row of result.rows) {
      breakdown[row.status ?? 'unknown'] = parseInt(row.count, 10);
    }
    return breakdown;
  }

  private async fetchOrdersByPlatform(tenantId: string): Promise<Record<string, number>> {
    const result = await db.query<{ platform_slug: string | null; count: string }>(
      `SELECT platform_slug, COUNT(*)::text AS count
       FROM orders
       WHERE tenant_id = $1
         AND ordered_at >= now() - ${TWELVE_MONTHS_INTERVAL}
       GROUP BY platform_slug`,
      [tenantId],
      { allowNoTenant: true }
    );

    const breakdown: Record<string, number> = {};
    for (const row of result.rows) {
      breakdown[row.platform_slug ?? 'unknown'] = parseInt(row.count, 10);
    }
    return breakdown;
  }

  private async fetchProducts(tenantId: string): Promise<{
    count:              number;
    active:             number;
    with_description:   number;
    with_image:         number;
    avg_price_excl_vat: number | null;
  }> {
    const result = await db.query<{
      count:            string;
      active:           string;
      with_description: string;
      with_image:       string;
      avg_price:        string | null;
    }>(
      `SELECT
         COUNT(*)::text                                                     AS count,
         COUNT(*) FILTER (WHERE status = 'active')::text                    AS active,
         COUNT(*) FILTER (WHERE description IS NOT NULL)::text              AS with_description,
         COUNT(*) FILTER (WHERE image_url IS NOT NULL)::text                AS with_image,
         AVG(price) FILTER (WHERE price IS NOT NULL AND price > 0)::text    AS avg_price
       FROM products
       WHERE tenant_id = $1`,
      [tenantId],
      { allowNoTenant: true }
    );

    const row = result.rows[0];
    return {
      count:              parseInt(row.count, 10),
      active:             parseInt(row.active, 10),
      with_description:   parseInt(row.with_description, 10),
      with_image:         parseInt(row.with_image, 10),
      avg_price_excl_vat: row.avg_price ? round2(parseFloat(row.avg_price)) : null,
    };
  }

  private async fetchCustomers(tenantId: string): Promise<{
    count:        number;
    with_orders:  number;
    repeat_count: number;
  }> {
    const result = await db.query<{
      count:        string;
      with_orders:  string;
      repeat_count: string;
    }>(
      `SELECT
         COUNT(*)::text                                  AS count,
         COUNT(*) FILTER (WHERE order_count > 0)::text   AS with_orders,
         COUNT(*) FILTER (WHERE order_count > 1)::text   AS repeat_count
       FROM customers
       WHERE tenant_id = $1`,
      [tenantId],
      { allowNoTenant: true }
    );

    const row = result.rows[0];
    return {
      count:        parseInt(row.count, 10),
      with_orders:  parseInt(row.with_orders, 10),
      repeat_count: parseInt(row.repeat_count, 10),
    };
  }
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export const stage1IngestionService = new Stage1IngestionService();
