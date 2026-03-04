// ============================================================
// src/modules/sales-dashboard/tests/tenant-isolation.test.ts
//
// CRITICAL: These tests run on every PR.
// They verify that Tenant A can NEVER see Tenant B's data.
// If these tests fail, the PR is blocked from merging.
// ============================================================

import { db } from '../../../infrastructure/database/connection';
import { runWithTenantContext } from '../../../shared/middleware/tenant-context';
import { SalesDashboardRepository } from '../repository/sales-dashboard.repository';
import { v4 as uuidv4 } from 'uuid';

// Test tenant fixtures
const TENANT_A_ID = uuidv4();
const TENANT_B_ID = uuidv4();

// Helper: run a function as a specific tenant
async function asTenanT<T>(tenantId: string, fn: () => Promise<T>): Promise<T> {
  return runWithTenantContext(
    {
      tenantId,
      tenantSlug: `tenant-${tenantId.slice(0, 8)}`,
      userId: uuidv4(),
      planSlug: 'growth',
      traceId: uuidv4(),
      requestStartedAt: new Date(),
    },
    fn
  );
}

describe('Tenant Isolation: Sales Dashboard', () => {
  beforeAll(async () => {
    // Insert test orders for Tenant A only
    await db.query(
      `INSERT INTO orders (id, tenant_id, total_amount, currency, status, created_at)
       VALUES ($1, $2, 150.00, 'EUR', 'completed', now()),
              ($3, $2, 250.00, 'EUR', 'completed', now())`,
      [uuidv4(), TENANT_A_ID, uuidv4(), TENANT_A_ID],
      { allowNoTenant: true }
    );
    // Tenant B has NO orders
  });

  afterAll(async () => {
    // Clean up test data
    await db.query(
      `DELETE FROM orders WHERE tenant_id IN ($1, $2)`,
      [TENANT_A_ID, TENANT_B_ID],
      { allowNoTenant: true }
    );
  });

  test('Tenant A can see their own orders', async () => {
    const repo = new SalesDashboardRepository();
    const result = await asTenanT(TENANT_A_ID, () =>
      repo.getSalesSummary(new Date('2020-01-01'), new Date('2099-12-31'))
    );

    expect(result.totalOrders).toBe(2);
    expect(result.totalRevenue).toBe(400);
  });

  test('Tenant B sees ZERO orders (isolation enforced)', async () => {
    const repo = new SalesDashboardRepository();
    const result = await asTenanT(TENANT_B_ID, () =>
      repo.getSalesSummary(new Date('2020-01-01'), new Date('2099-12-31'))
    );

    // This is the critical assertion — Tenant B must see 0, not Tenant A's data
    expect(result.totalOrders).toBe(0);
    expect(result.totalRevenue).toBe(0);
  });

  test('Direct query without tenant context is rejected', async () => {
    const repo = new SalesDashboardRepository();

    // Running outside of runWithTenantContext should throw
    await expect(
      repo.getSalesSummary(new Date('2020-01-01'), new Date('2099-12-31'))
    ).rejects.toThrow('[DB] Query attempted without tenant context');
  });
});
