// ============================================================
// src/modules/integrations/tests/integration-isolation.test.ts
//
// KRITISCH: Tenant isolatie voor integraties en orders.
// Tenant A mag NOOIT de data van Tenant B zien.
// ============================================================

import { db }               from '../../../infrastructure/database/connection';
import { runWithTenantContext } from '../../../shared/middleware/tenant-context';
import { v4 as uuidv4 }     from 'uuid';

const TENANT_A = uuidv4();
const TENANT_B = uuidv4();
let PLATFORM_ID: string;
let INTEGRATION_A: string;
let INTEGRATION_B: string;

async function asTenant<T>(tenantId: string, fn: () => Promise<T>): Promise<T> {
  return runWithTenantContext({
    tenantId,
    tenantSlug: `test-${tenantId.slice(0, 6)}`,
    userId: uuidv4(),
    planSlug: 'growth',
    traceId: uuidv4(),
    requestStartedAt: new Date(),
  }, fn);
}

beforeAll(async () => {
  // Platform ophalen
  const p = await db.query(
    `SELECT id FROM integration_platforms WHERE slug = 'shopify'`,
    [], { allowNoTenant: true }
  );
  PLATFORM_ID = p.rows[0].id;

  // Tenants aanmaken
  for (const tid of [TENANT_A, TENANT_B]) {
    await db.query(
      `INSERT INTO tenants (id, name, slug, email) VALUES ($1, $2, $3, $4)
       ON CONFLICT DO NOTHING`,
      [tid, `Test Tenant ${tid.slice(0,6)}`, tid, `${tid}@test.com`],
      { allowNoTenant: true }
    );
  }

  // Integraties aanmaken
  const iA = await db.query(
    `INSERT INTO tenant_integrations (tenant_id, platform_id, platform_slug, shop_domain, status)
     VALUES ($1, $2, 'shopify', $3, 'active') RETURNING id`,
    [TENANT_A, PLATFORM_ID, `${TENANT_A}.myshopify.com`],
    { allowNoTenant: true }
  );
  INTEGRATION_A = iA.rows[0].id;

  const iB = await db.query(
    `INSERT INTO tenant_integrations (tenant_id, platform_id, platform_slug, shop_domain, status)
     VALUES ($1, $2, 'shopify', $3, 'active') RETURNING id`,
    [TENANT_B, PLATFORM_ID, `${TENANT_B}.myshopify.com`],
    { allowNoTenant: true }
  );
  INTEGRATION_B = iB.rows[0].id;

  // Orders voor Tenant A
  await db.query(
    `INSERT INTO orders (tenant_id, integration_id, external_id, platform_slug,
       total_amount, subtotal_amount, tax_amount, shipping_amount, discount_amount,
       currency, status, ordered_at)
     VALUES ($1, $2, 'A-001', 'shopify', 99.99, 85.00, 14.99, 0, 0, 'EUR', 'completed', now()),
            ($1, $2, 'A-002', 'shopify', 199.00, 170.00, 29.00, 0, 0, 'EUR', 'completed', now())`,
    [TENANT_A, INTEGRATION_A],
    { allowNoTenant: true }
  );
  // Tenant B heeft GEEN orders
});

afterAll(async () => {
  // Cleanup
  await db.query(`DELETE FROM orders WHERE tenant_id IN ($1, $2)`, [TENANT_A, TENANT_B], { allowNoTenant: true });
  await db.query(`DELETE FROM tenant_integrations WHERE tenant_id IN ($1, $2)`, [TENANT_A, TENANT_B], { allowNoTenant: true });
  await db.query(`DELETE FROM tenants WHERE id IN ($1, $2)`, [TENANT_A, TENANT_B], { allowNoTenant: true });
});

describe('Integration Tenant Isolation', () => {

  test('Tenant A ziet alleen zijn eigen integraties', async () => {
    const rows = await asTenant(TENANT_A, () =>
      db.query(`SELECT id FROM tenant_integrations WHERE status = 'active'`, [])
    );
    expect(rows.rows.every(r => r.id === INTEGRATION_A)).toBe(true);
    expect(rows.rows.find(r => r.id === INTEGRATION_B)).toBeUndefined();
  });

  test('Tenant B ziet 0 integraties (heeft er geen)', async () => {
    const rows = await asTenant(TENANT_B, () =>
      db.query(`SELECT id FROM tenant_integrations`, [])
    );
    expect(rows.rows.length).toBe(0);
  });

  test('Tenant A ziet zijn orders (2 stuks)', async () => {
    const rows = await asTenant(TENANT_A, () =>
      db.query(`SELECT external_id FROM orders ORDER BY ordered_at`, [])
    );
    expect(rows.rows.length).toBe(2);
    expect(rows.rows.map(r => r.external_id)).toEqual(['A-001', 'A-002']);
  });

  test('Tenant B ziet NIKS van Tenant A zijn orders — kritische isolatie test', async () => {
    const rows = await asTenant(TENANT_B, () =>
      db.query(`SELECT id FROM orders`, [])
    );
    // Dit MOET 0 zijn. Als dit faalt is er een kritisch beveiligingsprobleem.
    expect(rows.rows.length).toBe(0);
  });

  test('Directe query zonder tenant context wordt geweigerd', async () => {
    await expect(
      db.query(`SELECT id FROM orders WHERE tenant_id = $1`, [TENANT_A])
      // Geen allowNoTenant — moet falen
    ).rejects.toThrow('[DB] Query attempted without tenant context');
  });

  test('Tenant A kan niet de integratie van Tenant B syncroon', async () => {
    const rows = await asTenant(TENANT_A, () =>
      db.query(
        `SELECT id FROM tenant_integrations WHERE id = $1`,
        [INTEGRATION_B]  // Probeer Tenant B's integratie te lezen als Tenant A
      )
    );
    // RLS zorgt ervoor dat dit 0 resultaten geeft
    expect(rows.rows.length).toBe(0);
  });
});
