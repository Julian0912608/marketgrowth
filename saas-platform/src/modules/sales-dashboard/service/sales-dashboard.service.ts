// ============================================================
// src/modules/sales-dashboard/service/sales-dashboard.service.ts
//
// EXAMPLE: How every module service should be structured.
//
// Rules demonstrated here:
//  1. Always check permissions before doing anything
//  2. Never query other module's tables
//  3. Publish events instead of calling other modules directly
//  4. Use tenant context — never accept tenantId as a parameter
// ============================================================

import { permissionService } from '../../../shared/permissions/permission.service';
import { FeatureNotAvailableError } from '../../../shared/permissions/errors';
import { getTenantContext } from '../../../shared/middleware/tenant-context';
import { eventBus } from '../../../shared/events/event-bus';
import { logger } from '../../../shared/logging/logger';
import { cache } from '../../../infrastructure/cache/redis';
import { SalesDashboardRepository } from '../repository/sales-dashboard.repository';

export interface SalesSummary {
  totalRevenue: number;
  totalOrders: number;
  averageOrderValue: number;
  currency: string;
  periodStart: Date;
  periodEnd: Date;
}

export class SalesDashboardService {
  constructor(
    private readonly repo = new SalesDashboardRepository()
  ) {}

  async getSalesSummary(dateFrom: Date, dateTo: Date): Promise<SalesSummary> {
    // 1. Get context — tenantId comes from here, NEVER from a parameter
    const { tenantId } = getTenantContext();

    // 2. Check permission — always before any business logic
    const permission = await permissionService.check({
      tenantId,
      feature: 'sales-dashboard',
      action: 'view',
    });

    if (!permission.allowed) {
      throw new FeatureNotAvailableError('sales-dashboard', permission.requiredPlan);
    }

    // 3. Check cache before hitting database
    const cacheKey = cache.key(tenantId, 'sales-summary', dateFrom.toISOString(), dateTo.toISOString());
    const cached = await cache.getJson<SalesSummary>(cacheKey);
    if (cached) {
      logger.debug('sales-dashboard.cache.hit', { cacheKey });
      return cached;
    }

    // 4. Fetch from repository (repository handles tenant isolation via RLS)
    const summary = await this.repo.getSalesSummary(dateFrom, dateTo);

    // 5. Cache for 5 minutes
    await cache.setJson(cacheKey, summary, 300);

    logger.info('sales-dashboard.summary.fetched', {
      totalOrders: summary.totalOrders,
      totalRevenue: summary.totalRevenue,
    });

    return summary;
  }
}
