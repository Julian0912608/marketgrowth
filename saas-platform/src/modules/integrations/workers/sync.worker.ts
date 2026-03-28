// ============================================================
// src/modules/integrations/workers/sync.worker.ts
//
// FIXES:
//   1. Bulk INSERT voor order line items (geen N+1 meer)
//   2. Per-tenant concurrency guard via Redis SETNX
//      (max 2 gelijktijdige sync jobs per tenant)
//   3. Priority queuing: Scale=1, Growth=5, Starter=10
// ============================================================

import { Queue, Worker, Job } from 'bullmq';
import { db }                from '../../../infrastructure/database/connection';
import { logger }            from '../../../shared/logging/logger';
import { getConnector }      from '../connectors/connector.factory';
import { runWithTenantContext } from '../../../shared/middleware/tenant-context';
import { decryptToken }      from '../../../shared/crypto/token-encryption';
import { v4 as uuidv4 }      from 'uuid';
import { PlanSlug }          from '../../../shared/types/tenant';
import {
  PlatformSlug,
  IntegrationCredentials,
} from '../types/integration.types';

// Raw redis voor incr/decr/expire/del
// eslint-disable-next-line @typescript-eslint/no-var-requires
const rawRedis = require('../../../infrastructure/cache/redis').redis as any;

export interface SyncJobPayload {
  integrationId: string;
  tenantId:      string;
  platformSlug:  string;
  jobType:       'full_sync' | 'incremental';
  syncJobDbId:   string;
  planSlug?:     string;
}

export interface WebhookJobPayload {
  integrationId: string;
  tenantId:      string;
  platformSlug:  string;
  topic:         string;
  payload:       Record<string, unknown>;
}

// ── Redis connectie voor BullMQ ───────────────────────────────
function buildBullMQConnection() {
  const url = process.env.REDIS_URL;
  const IORedis = require('ioredis');

  if (!url) {
    return new IORedis({ host: 'localhost', port: 6379, maxRetriesPerRequest: null });
  }

  const isTLS  = url.startsWith('rediss://');
  let hostname = 'localhost';
  try { hostname = new URL(url).hostname; } catch {}

  return new IORedis(url, {
    tls: isTLS ? { rejectUnauthorized: false, servername: hostname } : undefined,
    maxRetriesPerRequest: null,
    enableOfflineQueue:   true,
    lazyConnect:          false,
    family:               4,
    retryStrategy: (times: number) => {
      if (times > 10) return null;
      return Math.min(times * 500, 5000);
    },
  });
}

const bullConnection = buildBullMQConnection();

// ── Queues ────────────────────────────────────────────────────
export const syncQueue    = new Queue<SyncJobPayload>('integration-sync',      { connection: bullConnection });
export const webhookQueue = new Queue<WebhookJobPayload>('integration-webhook', { connection: bullConnection });

// ── Per-tenant concurrency guard ──────────────────────────────
// Voorkomt dat één tenant alle worker slots opeist
const MAX_CONCURRENT_PER_TENANT = 2;

async function acquireTenantSlot(tenantId: string): Promise<boolean> {
  const key = `sync:concurrent:${tenantId}`;
  try {
    const current = await rawRedis.incr(key);
    if (current === 1) await rawRedis.expire(key, 3600);
    if (current > MAX_CONCURRENT_PER_TENANT) {
      await rawRedis.decr(key);
      return false;
    }
    return true;
  } catch {
    return true;
  }
}

async function releaseTenantSlot(tenantId: string): Promise<void> {
  const key = `sync:concurrent:${tenantId}`;
  try {
    const val = await rawRedis.decr(key);
    if (val <= 0) await rawRedis.del(key);
  } catch {}
}

// ── Platform rate limiter ─────────────────────────────────────
async function acquireRateLimit(platformSlug: string, integrationId: string): Promise<void> {
  const key   = `ratelimit:sync:${platformSlug}:${integrationId}`;
  const limit = getRateLimit(platformSlug);
  try {
    const current = await rawRedis.incr(key);
    if (current === 1) await rawRedis.expire(key, 1);
    if (current > limit) await new Promise(r => setTimeout(r, 1000));
  } catch {}
}

function getRateLimit(platform: string): number {
  const limits: Record<string, number> = {
    shopify: 2, woocommerce: 10, lightspeed: 5,
    magento: 10, bigcommerce: 10, bolcom: 3,
  };
  return limits[platform] ?? 5;
}

// ── Prioriteit op basis van plan ──────────────────────────────
function getPriority(planSlug?: string): number {
  if (planSlug === 'scale')  return 1;
  if (planSlug === 'growth') return 5;
  return 10; // starter
}

// ── Bulk INSERT helper voor line items ────────────────────────
async function bulkInsertLineItems(
  orderId: string,
  tenantId: string,
  platformSlug: string,
  lineItems: any[]
): Promise<void> {
  if (!lineItems || lineItems.length === 0) return;

  // Bouw een bulk VALUES string: ($1,$2,...),($N+1,...)
  const colCount = 12;
  const values: any[] = [];
  const placeholders: string[] = [];

  for (let i = 0; i < lineItems.length; i++) {
    const li     = lineItems[i];
    const offset = i * colCount;
    placeholders.push(
      `($${offset+1},$${offset+2},$${offset+3},$${offset+4},$${offset+5},$${offset+6},$${offset+7},$${offset+8},$${offset+9},$${offset+10},$${offset+11},$${offset+12})`
    );
    values.push(
      orderId, tenantId, li.externalId, li.productId || null, li.variantId || null,
      li.sku || null, li.title, li.quantity, li.unitPrice, li.totalPrice,
      li.discountAmount, platformSlug
    );
  }

  await db.query(
    `INSERT INTO order_line_items (
       order_id, tenant_id, external_id, product_id, variant_id,
       sku, title, quantity, unit_price, total_price, discount_amount, platform
     ) VALUES ${placeholders.join(',')}
     ON CONFLICT (order_id, external_id)
     DO UPDATE SET
       quantity    = EXCLUDED.quantity,
       unit_price  = EXCLUDED.unit_price,
       total_price = EXCLUDED.total_price,
       title       = EXCLUDED.title`,
    values,
    { allowNoTenant: true }
  );
}

// ── Sync worker ───────────────────────────────────────────────
export const syncWorker = new Worker<SyncJobPayload>(
  'integration-sync',
  async (job: Job<SyncJobPayload>) => {
    const { integrationId, tenantId, platformSlug, jobType, syncJobDbId, planSlug } = job.data;

    // Per-tenant concurrency check
    const slotAcquired = await acquireTenantSlot(tenantId);
    if (!slotAcquired) {
      logger.warn('sync.job.throttled', { integrationId, tenantId, platformSlug });
      // Gooi een retryable error — BullMQ zal het later opnieuw proberen
      throw Object.assign(new Error('Tenant concurrency limit bereikt — wordt opnieuw geprobeerd'), {
        retryable: true,
      });
    }

    try {
      logger.info('sync.job.start', { integrationId, tenantId, platformSlug, jobType });

      await db.query(
        `UPDATE integration_sync_jobs SET status = 'running', started_at = now() WHERE id = $1`,
        [syncJobDbId],
        { allowNoTenant: true }
      );

      const credRow = await db.query(
        `SELECT ic.*, ti.shop_domain
         FROM integration_credentials ic
         JOIN tenant_integrations ti ON ti.id = ic.integration_id
         WHERE ic.integration_id = $1`,
        [integrationId],
        { allowNoTenant: true }
      );

      if (!credRow.rows[0]) throw new Error(`Geen credentials voor integratie ${integrationId}`);

      const row = credRow.rows[0];
      const credentials: IntegrationCredentials = {
        integrationId,
        platform:       platformSlug as PlatformSlug,
        accessToken:    decryptToken(row.access_token)    ?? undefined,
        refreshToken:   decryptToken(row.refresh_token)   ?? undefined,
        tokenExpiresAt: row.token_expires_at,
        apiKey:         decryptToken(row.api_key)         ?? undefined,
        apiSecret:      decryptToken(row.api_secret)      ?? undefined,
        shopDomain:     row.shop_domain                   ?? undefined,
        storeUrl:       row.store_url                     ?? undefined,
      };

      const connector = getConnector(platformSlug as PlatformSlug);

      await runWithTenantContext(
        { tenantId, tenantSlug: '', userId: 'sync-worker', planSlug: (planSlug ?? 'starter') as PlanSlug, traceId: uuidv4(), requestStartedAt: new Date() },
        async () => {
          const lastSyncRow = jobType === 'incremental'
            ? await db.query(
                `SELECT MAX(completed_at) AS last_sync_at
                 FROM integration_sync_jobs
                 WHERE integration_id = $1 AND status = 'completed' AND job_type = 'full_sync'`,
                [integrationId], { allowNoTenant: true }
              )
            : null;

          const updatedAfter = jobType === 'incremental' && lastSyncRow?.rows[0]?.last_sync_at
            ? new Date(lastSyncRow.rows[0].last_sync_at)
            : undefined;

          await acquireRateLimit(platformSlug, integrationId);

          let totalOrders   = 0;
          let totalProducts = 0;

          // ── Orders ──────────────────────────────────────────
          let orderPage: number | string | undefined = 1;
          while (orderPage !== undefined) {
            const result = await connector.fetchOrders(credentials, {
              updatedAfter,
              page:   typeof orderPage === 'number' ? orderPage : undefined,
              cursor: typeof orderPage === 'string' ? orderPage : undefined,
            });

            for (const order of result.items) {
              const orderResult = await db.query(
                `INSERT INTO orders
                   (id, tenant_id, integration_id, external_id, external_number, platform_slug,
                    total_amount, subtotal_amount, tax_amount, shipping_amount, discount_amount,
                    currency, status, financial_status, fulfillment_status,
                    customer_email_hash, is_first_order, tags, note, source,
                    ordered_at, updated_at)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,now())
                 ON CONFLICT (tenant_id, integration_id, external_id)
                 DO UPDATE SET
                   total_amount       = EXCLUDED.total_amount,
                   subtotal_amount    = EXCLUDED.subtotal_amount,
                   tax_amount         = EXCLUDED.tax_amount,
                   status             = EXCLUDED.status,
                   financial_status   = EXCLUDED.financial_status,
                   fulfillment_status = EXCLUDED.fulfillment_status,
                   updated_at         = now(),
                   synced_at          = now()
                 RETURNING id`,
                [
                  uuidv4(), tenantId, integrationId,
                  order.externalId, order.externalNumber || null, platformSlug,
                  order.totalAmount, order.subtotalAmount, order.taxAmount,
                  order.shippingAmount, order.discountAmount, order.currency,
                  order.status, order.financialStatus || null, order.fulfillmentStatus || null,
                  order.customerEmailHash || null, order.isFirstOrder || null,
                  order.tags ? JSON.stringify(order.tags) : null,
                  order.note || null, order.source || null, order.orderedAt,
                ],
                { allowNoTenant: true }
              );

              const orderId = orderResult.rows[0]?.id;
              if (orderId && order.lineItems?.length > 0) {
                // ── BULK INSERT (was N+1 loop) ────────────────
                await bulkInsertLineItems(orderId, tenantId, platformSlug, order.lineItems);
              }
              totalOrders++;
            }

            orderPage = result.hasNextPage
              ? (result.nextCursor ?? result.nextPage)
              : undefined;
          }

          // ── Products ─────────────────────────────────────────
          let productPage: number | string | undefined = 1;
          while (productPage !== undefined) {
            const result = await connector.fetchProducts(credentials, {
              updatedAfter,
              page:   typeof productPage === 'number' ? productPage : undefined,
              cursor: typeof productPage === 'string' ? productPage : undefined,
            });

            for (const product of result.items) {
              await db.query(
                `INSERT INTO products (
                   tenant_id, integration_id, external_id, title, handle, status,
                   product_type, tags, vendor, total_inventory, requires_shipping,
                   price_min, price_max, published_at, updated_at,
                   ean, condition, fulfillment_by
                 ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
                 ON CONFLICT (tenant_id, integration_id, external_id)
                 DO UPDATE SET
                   title           = EXCLUDED.title,
                   status          = EXCLUDED.status,
                   total_inventory = EXCLUDED.total_inventory,
                   price_min       = EXCLUDED.price_min,
                   price_max       = EXCLUDED.price_max,
                   ean             = COALESCE(EXCLUDED.ean, products.ean),
                   condition       = COALESCE(EXCLUDED.condition, products.condition),
                   fulfillment_by  = COALESCE(EXCLUDED.fulfillment_by, products.fulfillment_by),
                   updated_at      = now(),
                   synced_at       = now()`,
                [
                  tenantId, integrationId, product.externalId,
                  product.title, (product as any).handle ?? null,
                  product.status ?? 'active', (product as any).productType ?? null,
                  product.tags ? JSON.stringify(product.tags) : null,
                  (product as any).vendor ?? null,
                  product.totalInventory ?? 0, product.requiresShipping ?? true,
                  product.priceMin ?? null, product.priceMax ?? null,
                  (product as any).publishedAt ?? null, product.updatedAt,
                  (product as any).ean ?? null,
                  (product as any).condition ?? 'NEW',
                  (product as any).fulfillmentBy ?? 'FBR',
                ],
                { allowNoTenant: true }
              );
              totalProducts++;
            }

            productPage = result.hasNextPage
              ? (result.nextCursor ?? result.nextPage)
              : undefined;
          }

          // ── Sync job afronden ─────────────────────────────────
          await db.query(
            `UPDATE integration_sync_jobs
             SET status = 'completed', completed_at = now(),
                 orders_synced = $2, products_synced = $3
             WHERE id = $1`,
            [syncJobDbId, totalOrders, totalProducts],
            { allowNoTenant: true }
          );

          await db.query(
            `UPDATE tenant_integrations
             SET last_sync_at = now(), next_sync_at = now() + INTERVAL '1 hour',
                 status = 'active', error_message = null, updated_at = now()
             WHERE id = $1`,
            [integrationId],
            { allowNoTenant: true }
          );

          logger.info('sync.job.complete', {
            integrationId, tenantId, platformSlug,
            totalOrders, totalProducts,
          });
        }
      );

    } finally {
      await releaseTenantSlot(tenantId);
    }
  },
  {
    connection:   bullConnection,
    concurrency:  5, // 5 parallelle jobs totaal
    removeOnComplete: { count: 100 },
    removeOnFail:     { count: 50 },
  }
);

// ── Helper: job toevoegen aan queue met juiste prioriteit ─────
export async function enqueueSyncJob(payload: SyncJobPayload): Promise<void> {
  const priority = getPriority(payload.planSlug);
  await syncQueue.add(
    `sync:${payload.platformSlug}:${payload.integrationId}`,
    payload,
    {
      priority,
      attempts: 3,
      backoff:  { type: 'exponential', delay: 5000 },
      removeOnComplete: 100,
      removeOnFail:      50,
    }
  );
}

syncWorker.on('failed', (job, err) => {
  logger.error('sync.job.failed', {
    jobId:   job?.id,
    jobName: job?.name,
    error:   err.message,
  });
});
