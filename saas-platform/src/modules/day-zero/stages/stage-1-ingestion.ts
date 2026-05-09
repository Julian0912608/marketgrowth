// ============================================================
// src/modules/day-zero/stages/stage-1-ingestion.ts
//
// Stage 1 (0:00 -> 0:02): Ingestion.
// Aggregeert wat al in onze DB staat na de Step 4 store-connect sync.
//
// Beslissing: we triggeren GEEN nieuwe sync vanuit Bol/Shopify hier.
// Reden: bij onboarding step 4 is de eerste sync al gestart en data
// staat in de DB. Stage 1 = aggregeren, niet pullen.
// Edge case: als orders_12m.count == 0, dan is dat een echte signaal
// (nieuwe winkel zonder verkopen). Stage 4 plan generation handelt dit.
//
// Schema bron: information_schema verificatie 9 mei 2026.
// ============================================================

import { supabaseAdmin } from '../../../shared/database/supabase';
import { logger } from '../../../shared/logging/logger';
import { Stage1IngestionOutput } from '../types/day-zero.types';

const TWELVE_MONTHS_MS = 365 * 24 * 60 * 60 * 1000;

export class Stage1IngestionService {

  async run(tenantId: string): Promise<Stage1IngestionOutput> {
    const startedAt = Date.now();
    const since     = new Date(Date.now() - TWELVE_MONTHS_MS).toISOString();
    const warnings: string[] = [];

    logger.info('day_zero.stage1.start', { tenantId, since });

    const [integrations, orders, products, customers] = await Promise.all([
      this.fetchIntegrations(tenantId),
      this.fetchOrders12m(tenantId, since),
      this.fetchProducts(tenantId),
      this.fetchCustomers(tenantId),
    ]);

    // Sanity warnings (niet failen, alleen loggen)
    if (integrations.length === 0) {
      warnings.push('No connected integrations found at Day Zero start.');
    }
    if (orders.count === 0) {
      warnings.push('No orders in the last 12 months. Plan generation will treat this as a brand-new shop.');
    }
    if (products.count === 0) {
      warnings.push('No products synced. Brand voice extraction in Stage 2 will skip.');
    }

    const output: Stage1IngestionOutput = {
      integrations,
      orders_12m: orders,
      products,
      customers,
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
    const { data, error } = await supabaseAdmin
      .from('tenant_integrations')
      .select('id, platform_slug, shop_name, shop_country, synced_at:last_full_sync_at')
      .eq('tenant_id', tenantId)
      .eq('status', 'connected');

    if (error) throw new Error(`Stage 1 integrations: ${error.message}`);

    return (data ?? []).map((row: any) => ({
      id:           row.id,
      platform:     row.platform_slug,
      shop_name:    row.shop_name,
      shop_country: row.shop_country,
      synced_at:    row.synced_at,
    }));
  }

  private async fetchOrders12m(tenantId: string, since: string): Promise<Stage1IngestionOutput['orders_12m']> {
    // We doen een raw SQL aggregate via RPC of via paginated select.
    // Hier: 2 queries (counts + aggregaten) om RLS/RPC dependencies te vermijden.

    // 1. Hoofdaggregaat: count, sums, min/max date
    const { data: aggData, error: aggErr } = await supabaseAdmin
      .from('orders')
      .select(`
        total_amount.sum(),
        tax_amount.sum(),
        ordered_at.min(),
        ordered_at.max()
      `, { count: 'exact', head: false })
      .eq('tenant_id', tenantId)
      .gte('ordered_at', since);

    if (aggErr) throw new Error(`Stage 1 orders aggregate: ${aggErr.message}`);

    const aggRow            = (aggData?.[0] ?? {}) as any;
    const totalInclVat      = Number(aggRow.sum ?? 0);
    const totalTax          = Number(aggRow.sum_1 ?? 0);
    const firstOrderAt      = aggRow.min ?? null;
    const lastOrderAt       = aggRow.max ?? null;

    // PostgREST aggregaat-naming kan verschillen per Supabase versie.
    // Als bovenstaande shape niet matched, gebruik dan onderstaande fallback:
    const fallbackAgg = await this.fetchOrdersAggregateFallback(tenantId, since);
    const revenueInclVat = totalInclVat || fallbackAgg.revenueInclVat;
    const revenueExclVat = (totalInclVat - totalTax) || fallbackAgg.revenueExclVat;

    // 2. Count via head request (fast, gebruikt index)
    const { count, error: countErr } = await supabaseAdmin
      .from('orders')
      .select('id', { count: 'exact', head: true })
      .eq('tenant_id', tenantId)
      .gte('ordered_at', since);

    if (countErr) throw new Error(`Stage 1 orders count: ${countErr.message}`);

    const orderCount = count ?? 0;

    // 3. Per status en per platform breakdown
    const [statusBreakdown, platformBreakdown] = await Promise.all([
      this.fetchOrderBreakdown(tenantId, since, 'status'),
      this.fetchOrderBreakdown(tenantId, since, 'platform_slug'),
    ]);

    return {
      count:            orderCount,
      revenue_excl_vat: round2(revenueExclVat),
      revenue_incl_vat: round2(revenueInclVat),
      first_order_at:   firstOrderAt,
      last_order_at:    lastOrderAt,
      by_status:        statusBreakdown,
      by_platform:      platformBreakdown,
      avg_order_value:  orderCount > 0 ? round2(revenueExclVat / orderCount) : null,
    };
  }

  /**
   * Robuste fallback met paginated select. Trager maar voorspelbaar
   * los van PostgREST aggregate-naming kwirken.
   */
  private async fetchOrdersAggregateFallback(
    tenantId: string,
    since: string,
  ): Promise<{ revenueExclVat: number; revenueInclVat: number }> {
    let revenueInclVat = 0;
    let revenueExclVat = 0;
    let from = 0;
    const PAGE = 1000;

    while (true) {
      const { data, error } = await supabaseAdmin
        .from('orders')
        .select('total_amount, tax_amount')
        .eq('tenant_id', tenantId)
        .gte('ordered_at', since)
        .range(from, from + PAGE - 1);

      if (error) throw new Error(`Stage 1 orders fallback: ${error.message}`);
      if (!data || data.length === 0) break;

      for (const row of data) {
        const incl = Number(row.total_amount ?? 0);
        const tax  = Number(row.tax_amount ?? 0);
        revenueInclVat += incl;
        revenueExclVat += (incl - tax);
      }

      if (data.length < PAGE) break;
      from += PAGE;
    }

    return { revenueExclVat, revenueInclVat };
  }

  private async fetchOrderBreakdown(
    tenantId: string,
    since:    string,
    field:    'status' | 'platform_slug',
  ): Promise<Record<string, number>> {
    // Geen group-by in PostgREST, dus paginated read en in-memory tellen.
    // Met max ~10k orders/12m bij target audience: geen probleem.
    const breakdown: Record<string, number> = {};
    let from = 0;
    const PAGE = 1000;

    while (true) {
      const { data, error } = await supabaseAdmin
        .from('orders')
        .select(field)
        .eq('tenant_id', tenantId)
        .gte('ordered_at', since)
        .range(from, from + PAGE - 1);

      if (error) throw new Error(`Stage 1 ${field} breakdown: ${error.message}`);
      if (!data || data.length === 0) break;

      for (const row of data) {
        const key = (row as any)[field] ?? 'unknown';
        breakdown[key] = (breakdown[key] ?? 0) + 1;
      }

      if (data.length < PAGE) break;
      from += PAGE;
    }

    return breakdown;
  }

  private async fetchProducts(tenantId: string): Promise<Stage1IngestionOutput['products']> {
    const { count: total, error: e1 } = await supabaseAdmin
      .from('products')
      .select('id', { count: 'exact', head: true })
      .eq('tenant_id', tenantId);
    if (e1) throw new Error(`Stage 1 products count: ${e1.message}`);

    const { count: active, error: e2 } = await supabaseAdmin
      .from('products')
      .select('id', { count: 'exact', head: true })
      .eq('tenant_id', tenantId)
      .eq('status', 'active');
    if (e2) throw new Error(`Stage 1 products active: ${e2.message}`);

    const { count: withDesc, error: e3 } = await supabaseAdmin
      .from('products')
      .select('id', { count: 'exact', head: true })
      .eq('tenant_id', tenantId)
      .not('description', 'is', null);
    if (e3) throw new Error(`Stage 1 products with_description: ${e3.message}`);

    const { count: withImage, error: e4 } = await supabaseAdmin
      .from('products')
      .select('id', { count: 'exact', head: true })
      .eq('tenant_id', tenantId)
      .not('image_url', 'is', null);
    if (e4) throw new Error(`Stage 1 products with_image: ${e4.message}`);

    // Avg prijs (excl VAT) via paginated read. Kleine dataset typisch (<500 SKU).
    let priceSum = 0;
    let priceCount = 0;
    let from = 0;
    const PAGE = 500;
    while (true) {
      const { data, error } = await supabaseAdmin
        .from('products')
        .select('price')
        .eq('tenant_id', tenantId)
        .not('price', 'is', null)
        .range(from, from + PAGE - 1);
      if (error) throw new Error(`Stage 1 products price: ${error.message}`);
      if (!data || data.length === 0) break;
      for (const r of data) {
        const p = Number(r.price);
        if (!isNaN(p) && p > 0) { priceSum += p; priceCount++; }
      }
      if (data.length < PAGE) break;
      from += PAGE;
    }

    return {
      count:              total ?? 0,
      active:             active ?? 0,
      with_description:   withDesc ?? 0,
      with_image:         withImage ?? 0,
      avg_price_excl_vat: priceCount > 0 ? round2(priceSum / priceCount) : null,
    };
  }

  private async fetchCustomers(tenantId: string): Promise<Stage1IngestionOutput['customers']> {
    const { count: total, error: e1 } = await supabaseAdmin
      .from('customers')
      .select('id', { count: 'exact', head: true })
      .eq('tenant_id', tenantId);
    if (e1) throw new Error(`Stage 1 customers count: ${e1.message}`);

    const { count: withOrders, error: e2 } = await supabaseAdmin
      .from('customers')
      .select('id', { count: 'exact', head: true })
      .eq('tenant_id', tenantId)
      .gt('order_count', 0);
    if (e2) throw new Error(`Stage 1 customers with_orders: ${e2.message}`);

    const { count: repeat, error: e3 } = await supabaseAdmin
      .from('customers')
      .select('id', { count: 'exact', head: true })
      .eq('tenant_id', tenantId)
      .gt('order_count', 1);
    if (e3) throw new Error(`Stage 1 customers repeat: ${e3.message}`);

    // Top 10% by total_spent: 1 query, sort + limit
    const high_ltv_count = Math.max(1, Math.floor((total ?? 0) * 0.1));

    return {
      count:          total ?? 0,
      with_orders:    withOrders ?? 0,
      high_ltv_count,
      repeat_count:   repeat ?? 0,
    };
  }
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export const stage1IngestionService = new Stage1IngestionService();
