// ============================================================
// src/modules/integrations/workers/sync.worker.ts
// ============================================================

import { Worker, Queue, Job } from 'bullmq';
import { db }          from '../../../infrastructure/database/connection';
import { cache, redis } from '../../../infrastructure/cache/redis';
import { eventBus }    from '../../../shared/events/event-bus';
import { logger }      from '../../../shared/logging/logger';
import { runWithTenantContext } from '../../../shared/middleware/tenant-context';
import { getConnector }        from '../connectors/connector.factory';
import {
  IntegrationCredentials,
  NormalizedOrder,
  NormalizedProduct,
  PlatformSlug,
} from '../types/integration.types';
import crypto from 'crypto';

// ── Job payload types ─────────────────────────────────────────
export interface SyncJobPayload {
  integrationId: string;
  tenantId:      string;
  platformSlug:  PlatformSlug;
  jobType:       'full_sync' | 'incremental';
  syncJobDbId:   string;
}

export interface WebhookJobPayload {
  integrationId: string;
  tenantId:      string;
  platformSlug:  PlatformSlug;
  topic:         string;
  body:          Record<string, unknown>;
}

// ── Redis connection ──────────────────────────────────────────
const redisConnection = {
  host: process.env.REDIS_HOST ?? 'localhost',
  port: parseInt(process.env.REDIS_PORT ?? '6379'),
};

// ── Queues ────────────────────────────────────────────────────
export const syncQueue    = new Queue<SyncJobPayload>('integration-sync',    { connection: redisConnection });
export const webhookQueue = new Queue<WebhookJobPayload>('integration-webhook', { connection: redisConnection });

// ── Rate limiter (gebruikt raw redis client voor incr/expire) ─
async function acquireRateLimit(platformSlug: string, integrationId: string): Promise<void> {
  const key    = `ratelimit:sync:${platformSlug}:${integrationId}`;
  const limit  = getRateLimit(platformSlug);

  try {
    const current = await redis.incr(key);
    if (current === 1) {
      await redis.expire(key, 1); // 1 seconde window
    }
    if (current > limit) {
      await new Promise(r => setTimeout(r, 1000));
    }
  } catch {
    // Redis niet beschikbaar — gewoon doorgaan
  }
}

function getRateLimit(platform: string): number {
  const limits: Record<string, number> = {
    shopify:     2,
    woocommerce: 10,
    lightspeed:  5,
    magento:     10,
    bigcommerce: 10,
    bolcom:      3,
  };
  return limits[platform] ?? 5;
}

// ── Sync worker ───────────────────────────────────────────────
export const syncWorker = new Worker<SyncJobPayload>(
  'integration-sync',
  async (job: Job<SyncJobPayload>) => {
    const { integrationId, tenantId, platformSlug, jobType, syncJobDbId } = job.data;

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

    if (!credRow.rows[0]) {
      throw new Error(`Geen credentials gevonden voor integratie ${integrationId}`);
    }

    const row = credRow.rows[0];
    const credentials: IntegrationCredentials = {
      integrationId,
      platform:       platformSlug,
      accessToken:    row.access_token,
      refreshToken:   row.refresh_token,
      tokenExpiresAt: row.token_expires_at,
      apiKey:         row.api_key,
      apiSecret:      row.api_secret,
      storeUrl:       row.store_url,
      shopDomain:     row.shop_domain,
    };

    // Refresh token als verlopen
    if (credentials.tokenExpiresAt && credentials.tokenExpiresAt < new Date()) {
      const connector = getConnector(platformSlug);
      if (connector.refreshAccessToken) {
        const refreshed = await connector.refreshAccessToken(credentials);
        credentials.accessToken   = refreshed.accessToken;
        credentials.tokenExpiresAt = refreshed.expiresAt;
        await db.query(
          `UPDATE integration_credentials
           SET access_token = $1, token_expires_at = $2, updated_at = now()
           WHERE integration_id = $3`,
          [refreshed.accessToken, refreshed.expiresAt, integrationId],
          { allowNoTenant: true }
        );
      }
    }

    const connector    = getConnector(platformSlug);
    const isFullSync   = jobType === 'full_sync';
    let totalOrders    = 0;
    let totalProducts  = 0;

    await runWithTenantContext(
      {
        tenantId,
        tenantSlug: tenantId,
        userId:     'system',
        planSlug:   'growth',
        traceId:    crypto.randomUUID(),
        requestStartedAt: new Date(),
      },
      async () => {
        const lastSyncRow = isFullSync
          ? null
          : await db.query(
              `SELECT last_sync_at FROM tenant_integrations WHERE id = $1`,
              [integrationId]
            );
        const updatedAfter = isFullSync ? undefined : lastSyncRow?.rows[0]?.last_sync_at;

        // ── Orders sync ──────────────────────────────────────
        let cursor: string | undefined;
        let page    = 1;
        let hasMore = true;

        while (hasMore) {
          await acquireRateLimit(platformSlug, integrationId);

          const result = await connector.fetchOrders(credentials, {
            updatedAfter,
            limit: 250,
            cursor,
            page,
          });

          if (result.items.length > 0) {
            await upsertOrders(result.items, integrationId, tenantId, platformSlug);
            totalOrders += result.items.length;

            await db.query(
              `UPDATE integration_sync_jobs SET orders_synced = $1 WHERE id = $2`,
              [totalOrders, syncJobDbId],
              { allowNoTenant: true }
            );

            for (const order of result.items) {
              if (order.status === 'completed' || order.status === 'processing') {
                await eventBus.publish({
                  type:       'order.created',
                  tenantId,
                  occurredAt: new Date(),
                  payload: {
                    orderId:     order.externalId,
                    totalAmount: order.totalAmount,
                    currency:    order.currency,
                  },
                });
              }
            }
          }

          hasMore = result.hasNextPage;
          cursor  = result.nextCursor;
          page    = result.nextPage ?? page + 1;

          if (!isFullSync && totalOrders >= 10_000) break;
        }

        // ── Producten sync (alleen full sync) ────────────────
        if (isFullSync) {
          let productPage     = 1;
          let hasMoreProducts = true;

          while (hasMoreProducts) {
            await acquireRateLimit(platformSlug, integrationId);
            const result = await connector.fetchProducts(credentials, {
              limit: 250,
              page:  productPage,
            });

            if (result.items.length > 0) {
              await upsertProducts(result.items, integrationId, tenantId);
              totalProducts += result.items.length;
            }

            hasMoreProducts = result.hasNextPage;
            productPage     = result.nextPage ?? productPage + 1;
            if (totalProducts >= 50_000) break;
          }
        }
      }
    );

    const completedAt = new Date();
    await db.query(
      `UPDATE integration_sync_jobs
       SET status = 'completed',
           completed_at = $1,
           duration_ms = EXTRACT(EPOCH FROM ($1 - started_at)) * 1000,
           orders_synced = $2,
           products_synced = $3
       WHERE id = $4`,
      [completedAt, totalOrders, totalProducts, syncJobDbId],
      { allowNoTenant: true }
    );

    await db.query(
      `UPDATE tenant_integrations
       SET last_sync_at = now(),
           status = 'active',
           error_message = NULL,
           error_count = 0,
           next_sync_at = now() + INTERVAL '15 minutes',
           updated_at = now()
       WHERE id = $1`,
      [integrationId],
      { allowNoTenant: true }
    );

    logger.info('sync.completed', { tenantId, integrationId, platformSlug, totalOrders, totalProducts, jobType });
  },
  {
    connection:  redisConnection,
    concurrency: 10,
    limiter: { max: 50, duration: 1000 },
  }
);

// ── Webhook worker ────────────────────────────────────────────
export const webhookWorker = new Worker<WebhookJobPayload>(
  'integration-webhook',
  async (job: Job<WebhookJobPayload>) => {
    const { integrationId, tenantId, platformSlug, topic } = job.data;

    await runWithTenantContext(
      {
        tenantId,
        tenantSlug: tenantId,
        userId:     'webhook',
        planSlug:   'growth',
        traceId:    crypto.randomUUID(),
        requestStartedAt: new Date(),
      },
      async () => {
        logger.info('webhook.processed', { integrationId, topic, tenantId, platformSlug });
      }
    );
  },
  { connection: redisConnection, concurrency: 20 }
);

// ── Error handling ────────────────────────────────────────────
syncWorker.on('failed', async (job, err) => {
  if (!job) return;
  const { integrationId, syncJobDbId, tenantId } = job.data;

  logger.error('sync.job.failed', {
    integrationId, tenantId, jobId: job.id,
    error: err.message, attempts: job.attemptsMade,
  });

  if (job.attemptsMade >= 3) {
    await db.query(
      `UPDATE tenant_integrations
       SET status = 'error', error_message = $1, error_count = error_count + 1, updated_at = now()
       WHERE id = $2`,
      [err.message.slice(0, 500), integrationId],
      { allowNoTenant: true }
    );
    await db.query(
      `UPDATE integration_sync_jobs SET status = 'failed', error_message = $1 WHERE id = $2`,
      [err.message.slice(0, 500), syncJobDbId],
      { allowNoTenant: true }
    );
  }
});

// ── Upsert helpers ────────────────────────────────────────────
async function upsertOrders(
  orders: NormalizedOrder[],
  integrationId: string,
  tenantId: string,
  platformSlug: string
): Promise<void> {
  for (const o of orders) {
    const result = await db.query(
      `INSERT INTO orders (
         tenant_id, integration_id, external_id, external_number, platform_slug,
         total_amount, subtotal_amount, tax_amount, shipping_amount, discount_amount,
         currency, status, financial_status, fulfillment_status,
         customer_email_hash, is_first_order, tags, note, source,
         ordered_at, updated_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)
       ON CONFLICT (tenant_id, integration_id, external_id)
       DO UPDATE SET
         total_amount       = EXCLUDED.total_amount,
         subtotal_amount    = EXCLUDED.subtotal_amount,
         status             = EXCLUDED.status,
         financial_status   = EXCLUDED.financial_status,
         fulfillment_status = EXCLUDED.fulfillment_status,
         updated_at         = EXCLUDED.updated_at,
         synced_at          = now()
       RETURNING id`,
      [
        tenantId, integrationId, o.externalId, o.externalNumber, platformSlug,
        o.totalAmount, o.subtotalAmount, o.taxAmount, o.shippingAmount, o.discountAmount,
        o.currency, o.status, o.financialStatus, o.fulfillmentStatus,
        o.customerEmailHash, o.isFirstOrder, o.tags, o.note, o.source,
        o.orderedAt, o.updatedAt,
      ]
    );

    if (result.rows[0] && o.lineItems?.length > 0) {
      const orderId = result.rows[0].id;
      for (const li of o.lineItems) {
        await db.query(
          `INSERT INTO order_line_items (
             order_id, tenant_id, external_id, product_id, variant_id,
             sku, title, quantity, unit_price, total_price, discount_amount
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
           ON CONFLICT DO NOTHING`,
          [orderId, tenantId, li.externalId, li.productId, li.variantId,
           li.sku, li.title, li.quantity, li.unitPrice, li.totalPrice, li.discountAmount]
        );
      }
    }
  }
}

async function upsertProducts(
  products: NormalizedProduct[],
  integrationId: string,
  tenantId: string
): Promise<void> {
  for (const p of products) {
    await db.query(
      `INSERT INTO products (
         tenant_id, integration_id, external_id, title, handle, status,
         product_type, tags, vendor, total_inventory, requires_shipping,
         price_min, price_max, published_at, updated_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
       ON CONFLICT (tenant_id, integration_id, external_id)
       DO UPDATE SET
         title = EXCLUDED.title, status = EXCLUDED.status,
         total_inventory = EXCLUDED.total_inventory,
         price_min = EXCLUDED.price_min, price_max = EXCLUDED.price_max,
         updated_at = EXCLUDED.updated_at, synced_at = now()`,
      [tenantId, integrationId, p.externalId, p.title, p.handle, p.status,
       p.productType, p.tags, p.vendor, p.totalInventory, p.requiresShipping,
       p.priceMin, p.priceMax, p.publishedAt, p.updatedAt]
    );
  }
}
