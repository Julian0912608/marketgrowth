// ============================================================
// src/modules/integrations/connectors/connector.factory.ts
//
// Factory die de juiste connector retourneert op basis van platform.
// Voeg hier nieuwe platforms toe — de rest van de code hoeft
// niet te veranderen.
// ============================================================

import { PlatformSlug, IPlatformConnector } from '../types/integration.types';
import { ShopifyConnector }     from './shopify.connector';
import { WooCommerceConnector } from './woocommerce.connector';
import { LightspeedConnector, BigCommerceConnector, BolcomConnector } from './other-connectors';

const connectors: Record<PlatformSlug, IPlatformConnector> = {
  shopify:     new ShopifyConnector(),
  woocommerce: new WooCommerceConnector(),
  lightspeed:  new LightspeedConnector(),
  magento:     new WooCommerceConnector(),   // Magento2 gebruikt vergelijkbare REST API structuur
  bigcommerce: new BigCommerceConnector(),
  bolcom:      new BolcomConnector(),
};

export function getConnector(platform: PlatformSlug): IPlatformConnector {
  const connector = connectors[platform];
  if (!connector) {
    throw new Error(`Geen connector beschikbaar voor platform: ${platform}`);
  }
  return connector;
}

export function getSupportedPlatforms(): PlatformSlug[] {
  return Object.keys(connectors) as PlatformSlug[];
}


// ============================================================
// src/modules/integrations/workers/sync.worker.ts
//
// BullMQ worker die sync jobs verwerkt.
// Draait als aparte process — niet in de API server.
// Schaalbaar: meerdere workers kunnen parallel draaien.
//
// Queue names:
//   'integration:full-sync'      — eerste keer of handmatige volledige sync
//   'integration:incremental'    — elke 15 minuten via scheduler
//   'integration:webhook'        — realtime verwerking van platform webhooks
// ============================================================

import { Worker, Queue, Job } from 'bullmq';
import { db }          from '../../../infrastructure/database/connection';
import { cache }       from '../../../infrastructure/cache/redis';
import { eventBus }    from '../../../shared/events/event-bus';
import { logger }      from '../../../shared/logging/logger';
import { runWithTenantContext } from '../../../shared/middleware/tenant-context';
import { getConnector }        from '../connectors/connector.factory';
import { IntegrationCredentials, NormalizedOrder, PlatformSlug } from '../types/integration.types';
import crypto from 'crypto';

// ── Job payload types ─────────────────────────────────────────
export interface SyncJobPayload {
  integrationId: string;
  tenantId:      string;
  platformSlug:  PlatformSlug;
  jobType:       'full_sync' | 'incremental';
  syncJobDbId:   string;     // ID in integration_sync_jobs tabel
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

// ── Queues (ook gebruikt door de API om jobs te plaatsen) ─────
export const syncQueue    = new Queue<SyncJobPayload>('integration:sync',    { connection: redisConnection });
export const webhookQueue = new Queue<WebhookJobPayload>('integration:webhook', { connection: redisConnection });

// ── Rate limiter helper ───────────────────────────────────────
// Zorgt dat we niet boven platform rate limits komen
// Schaalbaar: Redis-gebaseerd, werkt over meerdere worker instances
async function acquireRateLimit(platformSlug: string, integrationId: string): Promise<void> {
  const key    = `ratelimit:${platformSlug}:${integrationId}`;
  const limit  = getRateLimit(platformSlug);
  const window = 1000; // 1 seconde window

  const current = await cache.incr(key);
  if (current === 1) {
    await cache.expire(key, Math.ceil(window / 1000));
  }

  if (current > limit) {
    const waitMs = window;
    logger.debug('sync.ratelimit.wait', { platformSlug, integrationId, waitMs });
    await new Promise(r => setTimeout(r, waitMs));
  }
}

function getRateLimit(platform: string): number {
  const limits: Record<string, number> = {
    shopify:     2,    // calls/sec voor Basic plan
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
  'integration:sync',
  async (job: Job<SyncJobPayload>) => {
    const { integrationId, tenantId, platformSlug, jobType, syncJobDbId } = job.data;

    // Update job status naar 'running'
    await db.query(
      `UPDATE integration_sync_jobs SET status = 'running', started_at = now() WHERE id = $1`,
      [syncJobDbId],
      { allowNoTenant: true }
    );

    // Haal credentials op
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

    // Refresh token als verlopen (OAuth2)
    if (credentials.tokenExpiresAt && credentials.tokenExpiresAt < new Date()) {
      const connector = getConnector(platformSlug);
      if (connector.refreshAccessToken) {
        const refreshed = await connector.refreshAccessToken(credentials);
        credentials.accessToken  = refreshed.accessToken;
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

    const connector   = getConnector(platformSlug);
    const isFullSync  = jobType === 'full_sync';
    let totalOrders   = 0;
    let totalProducts = 0;
    let totalCustomers = 0;

    // Voer sync uit in tenant context zodat RLS correct werkt
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
        // Haal updatedAfter op voor incrementele sync
        const lastSyncRow = isFullSync
          ? null
          : await db.query(
              `SELECT last_sync_at FROM tenant_integrations WHERE id = $1`,
              [integrationId]
            );
        const updatedAfter = isFullSync
          ? undefined
          : lastSyncRow?.rows[0]?.last_sync_at;

        // ── Orders synchroniseren ───────────────────────────
        let cursor: string | undefined;
        let page = 1;
        let hasMore = true;

        while (hasMore) {
          await acquireRateLimit(platformSlug, integrationId);

          const result = await connector.fetchOrders(credentials, {
            updatedAfter,
            limit:  250,
            cursor,
            page,
          });

          if (result.items.length > 0) {
            await upsertOrders(result.items, integrationId, tenantId, platformSlug);
            totalOrders += result.items.length;

            // Voortgang bijwerken
            await db.query(
              `UPDATE integration_sync_jobs SET orders_synced = $1 WHERE id = $2`,
              [totalOrders, syncJobDbId],
              { allowNoTenant: true }
            );

            // Events publiceren voor AI engine
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

          // Stop na 10.000 orders voor incremental sync (prevent runaway)
          if (!isFullSync && totalOrders >= 10_000) {
            logger.warn('sync.orders.limit_reached', { integrationId, totalOrders });
            break;
          }
        }

        // ── Producten synchroniseren (alleen bij full sync) ─
        if (isFullSync) {
          let productPage = 1;
          let hasMoreProducts = true;

          while (hasMoreProducts) {
            await acquireRateLimit(platformSlug, integrationId);
            const result = await connector.fetchProducts(credentials, {
              limit: 250,
              page:  productPage,
            });

            if (result.items.length > 0) {
              await upsertProducts(result.items, integrationId, tenantId, platformSlug);
              totalProducts += result.items.length;
            }

            hasMoreProducts = result.hasNextPage;
            productPage = result.nextPage ?? productPage + 1;

            if (totalProducts >= 50_000) break; // Veiligheidsgrens
          }
        }
      }
    );

    // Sync job afronden
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

    // Integratie bijwerken
    await db.query(
      `UPDATE tenant_integrations
       SET last_sync_at = now(),
           ${isFullSync ? 'last_full_sync_at = now(),' : ''}
           status = 'active',
           error_message = NULL,
           error_count = 0,
           next_sync_at = now() + INTERVAL '15 minutes',
           updated_at = now()
       WHERE id = $1`,
      [integrationId],
      { allowNoTenant: true }
    );

    logger.info('sync.completed', {
      tenantId,
      integrationId,
      platformSlug,
      totalOrders,
      totalProducts,
      jobType,
    });
  },
  {
    connection: redisConnection,
    concurrency: 10,    // 10 parallel jobs — schaalbaar via meerdere worker processen
    limiter: {
      max:      50,     // max 50 jobs/sec over alle workers
      duration: 1000,
    },
  }
);

// ── Webhook worker ────────────────────────────────────────────
export const webhookWorker = new Worker<WebhookJobPayload>(
  'integration:webhook',
  async (job: Job<WebhookJobPayload>) => {
    const { integrationId, tenantId, platformSlug, topic, body } = job.data;

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
        if (topic.startsWith('orders/')) {
          const connector = getConnector(platformSlug);
          // Normaliseer het webhook payload als een order
          // (body is al het platform-specifieke order object)
          const credRow = await db.query(
            `SELECT ic.*, ti.shop_domain FROM integration_credentials ic
             JOIN tenant_integrations ti ON ti.id = ic.integration_id
             WHERE ic.integration_id = $1`,
            [integrationId],
            { allowNoTenant: true }
          );

          if (credRow.rows[0]) {
            logger.info('webhook.order.processed', { integrationId, topic, tenantId });
          }
        }
      }
    );
  },
  {
    connection: redisConnection,
    concurrency: 20,   // Webhooks snel verwerken
  }
);

// ── Error handling ────────────────────────────────────────────
syncWorker.on('failed', async (job, err) => {
  if (!job) return;
  const { integrationId, syncJobDbId, tenantId } = job.data;

  logger.error('sync.job.failed', {
    integrationId,
    tenantId,
    jobId: job.id,
    error: err.message,
    attempts: job.attemptsMade,
  });

  // Max 3 pogingen, dan integratie op error zetten
  if (job.attemptsMade >= 3) {
    await db.query(
      `UPDATE tenant_integrations
       SET status = 'error',
           error_message = $1,
           error_count = error_count + 1,
           updated_at = now()
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
       ) VALUES (
         $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21
       )
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

    // Upsert line items
    if (result.rows[0] && o.lineItems?.length > 0) {
      const orderId = result.rows[0].id;
      for (const li of o.lineItems) {
        await db.query(
          `INSERT INTO order_line_items (
             order_id, tenant_id, external_id, product_id, variant_id,
             sku, title, quantity, unit_price, total_price, discount_amount
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
           ON CONFLICT DO NOTHING`,
          [
            orderId, tenantId, li.externalId, li.productId, li.variantId,
            li.sku, li.title, li.quantity, li.unitPrice, li.totalPrice, li.discountAmount,
          ]
        );
      }
    }
  }
}

async function upsertProducts(
  products: import('../types/integration.types').NormalizedProduct[],
  integrationId: string,
  tenantId: string,
  platformSlug: string
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
      [
        tenantId, integrationId, p.externalId, p.title, p.handle, p.status,
        p.productType, p.tags, p.vendor, p.totalInventory, p.requiresShipping,
        p.priceMin, p.priceMax, p.publishedAt, p.updatedAt,
      ]
    );
  }
}
