// ============================================================
// saas-platform/src/modules/integrations/workers/sync.worker.ts
//
// SECURITY UPDATE: Credentials worden nu gedecrypteerd na
// ophalen uit de database via decryptToken().
// ============================================================

import { Queue, Worker, Job } from 'bullmq';
import crypto from 'crypto';
import { db } from '../../../infrastructure/database/connection';
import { redis } from '../../../infrastructure/cache/redis';
import { logger } from '../../../shared/logging/logger';
import { getConnector } from '../connectors/connector.factory';
import { runWithTenantContext } from '../../../shared/middleware/tenant-context';
import { decryptToken, encryptToken } from '../../../shared/crypto/token-encryption';
import {
  PlatformSlug,
  IntegrationCredentials,
} from '../types/integration.types';

export interface SyncJobPayload {
  integrationId: string;
  tenantId:      string;
  platformSlug:  string;
  jobType:       'full_sync' | 'incremental';
  syncJobDbId:   string;
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
    tls: isTLS
      ? { rejectUnauthorized: false, servername: hostname }
      : undefined,
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

// ── Rate limiter ──────────────────────────────────────────────
async function acquireRateLimit(platformSlug: string, integrationId: string): Promise<void> {
  const key   = `ratelimit:sync:${platformSlug}:${integrationId}`;
  const limit = getRateLimit(platformSlug);
  try {
    const current = await redis.incr(key);
    if (current === 1) await redis.expire(key, 1);
    if (current > limit) await new Promise(r => setTimeout(r, 1000));
  } catch { /* Redis niet beschikbaar */ }
}

function getRateLimit(platform: string): number {
  const limits: Record<string, number> = {
    shopify: 2, woocommerce: 10, lightspeed: 5,
    magento: 10, bigcommerce: 10, bolcom: 3,
  };
  return limits[platform] ?? 5;
}

// ── Sync worker ───────────────────────────────────────────────
export const syncWorker = new Worker<SyncJobPayload>(
  'integration-sync',
  async (job: Job<SyncJobPayload>) => {
    const { integrationId, tenantId, platformSlug, jobType, syncJobDbId } = job.data;

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

    // ✅ DECRYPTED: credentials worden gedecrypteerd voor gebruik
    const credentials: IntegrationCredentials = {
      integrationId,
      platform:       platformSlug as PlatformSlug,
      accessToken:    decryptToken(row.access_token)    ?? undefined,
      refreshToken:   decryptToken(row.refresh_token)   ?? undefined,
      tokenExpiresAt: row.token_expires_at,
      apiKey:         decryptToken(row.api_key)         ?? undefined,
      apiSecret:      decryptToken(row.api_secret)      ?? undefined,
      storeUrl:       row.store_url,
      shopDomain:     row.shop_domain,
    };

    // Token vernieuwen indien verlopen
    if (credentials.tokenExpiresAt && credentials.tokenExpiresAt < new Date()) {
      const connector = getConnector(platformSlug as PlatformSlug);
      if (connector.refreshAccessToken) {
        const refreshed = await connector.refreshAccessToken(credentials);
        credentials.accessToken    = refreshed.accessToken;
        credentials.tokenExpiresAt = refreshed.expiresAt;

        // ✅ ENCRYPTED: vernieuwde token ook versleuteld opslaan
        await db.query(
          `UPDATE integration_credentials
           SET access_token = $1, token_expires_at = $2, updated_at = now(), encrypted_at = now()
           WHERE integration_id = $3`,
          [encryptToken(refreshed.accessToken), refreshed.expiresAt, integrationId],
          { allowNoTenant: true }
        );
      }
    }

    const connector   = getConnector(platformSlug as PlatformSlug);
    const isFullSync  = jobType === 'full_sync';
    let totalOrders   = 0;
    let totalProducts = 0;

    await runWithTenantContext(
      {
        tenantId,
        tenantSlug:       tenantId,
        userId:           'system',
        planSlug:         'growth',
        traceId:          crypto.randomUUID(),
        requestStartedAt: new Date(),
      },
      async () => {
        const lastSyncRow = isFullSync
          ? null
          : await db.query(
              `SELECT last_sync_at FROM tenant_integrations WHERE id = $1`,
              [integrationId]
            );
        const updatedAfter = isFullSync
          ? undefined
          : (lastSyncRow?.rows[0]?.last_sync_at ?? undefined);

        await acquireRateLimit(platformSlug, integrationId);

        // Orders ophalen en opslaan
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
                uuidv4(),
                tenantId,
                integrationId,
                order.externalId,
                order.externalNumber || null,
                platformSlug,
                order.totalAmount,
                order.subtotalAmount,
                order.taxAmount,
                order.shippingAmount,
                order.discountAmount,
                order.currency,
                order.status,
                order.financialStatus || null,
                order.fulfillmentStatus || null,
                order.customerEmailHash || null,
                order.isFirstOrder || null,
                order.tags ? JSON.stringify(order.tags) : null,
                order.note || null,
                order.source || null,
                order.orderedAt,
              ],
              { allowNoTenant: true }
            );

            const orderId = orderResult.rows[0]?.id;
            if (orderId && order.lineItems?.length > 0) {
              for (const li of order.lineItems) {
                await db.query(
                  `INSERT INTO order_line_items (
                     order_id, tenant_id, external_id, product_id, variant_id,
                     sku, title, quantity, unit_price, total_price, discount_amount, platform
                   ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
                   ON CONFLICT (order_id, external_id)
                   DO UPDATE SET
                     quantity    = EXCLUDED.quantity,
                     unit_price  = EXCLUDED.unit_price,
                     total_price = EXCLUDED.total_price,
                     title       = EXCLUDED.title`,
                  [
                    orderId, tenantId, li.externalId, li.productId || null, li.variantId || null,
                    li.sku || null, li.title, li.quantity, li.unitPrice, li.totalPrice,
                    li.discountAmount, platformSlug,
                  ],
                  { allowNoTenant: true }
                );
              }
            }
            totalOrders++;
          }

          orderPage = result.hasNextPage
            ? (result.nextCursor ?? result.nextPage)
            : undefined;
        }

        // Products ophalen en opslaan
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
      }
    );

    await db.query(
      `UPDATE integration_sync_jobs
       SET status = 'completed', completed_at = now(), orders_synced = $1
       WHERE id = $2`,
      [totalOrders, syncJobDbId],
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
  },
  {
    connection:  bullConnection,
    concurrency: 5,
    removeOnComplete: { count: 100 },
    removeOnFail:     { count: 50 },
  }
);

syncWorker.on('failed', async (job, err) => {
  if (!job) return;
  const { syncJobDbId, integrationId } = job.data;
  logger.error('sync.job.failed', { jobId: job.id, error: err.message, integrationId });

  await db.query(
    `UPDATE integration_sync_jobs SET status = 'failed', error_message = $1, completed_at = now() WHERE id = $2`,
    [err.message.slice(0, 500), syncJobDbId],
    { allowNoTenant: true }
  ).catch(() => {});

  await db.query(
    `UPDATE tenant_integrations SET status = 'error', error_message = $1, updated_at = now() WHERE id = $2`,
    [err.message.slice(0, 500), integrationId],
    { allowNoTenant: true }
  ).catch(() => {});
});

// uuid helper (lokaal om import te vermijden)
function uuidv4(): string {
  return crypto.randomUUID();
}
