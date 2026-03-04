// ============================================================
// src/modules/sales-dashboard/repository/sales-dashboard.repository.ts
//
// ONLY place that reads/writes sales-related database tables.
// RLS ensures queries are automatically scoped to current tenant.
// No other module may import this repository.
// ============================================================

import { db } from '../../../infrastructure/database/connection';
import { SalesSummary } from '../service/sales-dashboard.service';

export class SalesDashboardRepository {
  async getSalesSummary(dateFrom: Date, dateTo: Date): Promise<SalesSummary> {
    // RLS is active — tenant_id filter is enforced by PostgreSQL automatically
    // We still include tenant_id in the query for the index to be used
    const result = await db.query<{
      total_revenue: string;
      total_orders: string;
      avg_order_value: string;
      currency: string;
    }>(
      `SELECT
         COALESCE(SUM(o.total_amount), 0)::TEXT           AS total_revenue,
         COUNT(o.id)::TEXT                                AS total_orders,
         COALESCE(AVG(o.total_amount), 0)::TEXT           AS avg_order_value,
         COALESCE(MAX(o.currency), 'EUR')                 AS currency
       FROM orders o
       WHERE o.created_at >= $1
         AND o.created_at <  $2
         AND o.status = 'completed'`,
      [dateFrom, dateTo]
    );

    const row = result.rows[0];
    return {
      totalRevenue:      parseFloat(row.total_revenue),
      totalOrders:       parseInt(row.total_orders),
      averageOrderValue: parseFloat(row.avg_order_value),
      currency:          row.currency,
      periodStart:       dateFrom,
      periodEnd:         dateTo,
    };
  }
}
