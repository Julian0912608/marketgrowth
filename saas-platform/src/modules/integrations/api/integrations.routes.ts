// ============================================================
// src/modules/integrations/api/integrations.routes.ts
// ============================================================

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { db } from '../../../infrastructure/database/connection';
import { getTenantContext } from '../../../shared/middleware/tenant-context';
import { ShopifyOAuthService } from '../shopify/service/shopify-oauth.service';
import { BolComConnector } from '../bolcom/service/bolcom.connector';
import { EtsyConnector } from '../etsy/service/etsy.connector';
import { WooCommerceConnector } from '../woocommerce/service/woocommerce.connector';
import { SyncService } from '../../sync/service/sync.service';
import { encryptSecret } from '../../../shared/crypto/encryption';
import { logger } from '../../../shared/logging/logger';

export const integrationsRouter = Router();
const shopifyOAuth = new ShopifyOAuthService();
const syncService  = new SyncService();

// ── GET /api/integrations — alle koppelingen ophalen ─────────
integrationsRouter.get('/', async (req: Request, res: Response) => {
  const { tenantId } = getTenantContext();
  const result = await db.query(
    `SELECT id, platform, shop_name, shop_url, status,
            last_sync_at, last_error, created_at
     FROM platform_connections
     WHERE tenant_id = $1
     ORDER BY created_at DESC`,
    [tenantId]
  );
  res.json({ connections: result.rows });
});

// ── POST /api/integrations/shopify/install — start OAuth ─────
integrationsRouter.post('/shopify/install', async (req: Request, res: Response) => {
  const { shopDomain } = z.object({ shopDomain: z.string().min(3) }).parse(req.body);
  const url = shopifyOAuth.generateInstallUrl(shopDomain);
  res.json({ installUrl: url });
});

// ── GET /api/integrations/shopify/callback — OAuth callback ──
integrationsRouter.get('/shopify/callback', async (req: Request, res: Response) => {
  const params = req.query as { shop: string; code: string; state: string; hmac: string };
  const { connectionId, shopName } = await shopifyOAuth.handleCallback(params);

  // Direct eerste sync starten
  syncService.syncConnection(connectionId).catch(err =>
    logger.error('shopify.initial_sync.failed', { connectionId, error: ((err as Error).message) })
  );

  res.redirect(`${process.env.APP_URL}/dashboard/integrations?connected=shopify&shop=${shopName}`);
});

// ── POST /api/integrations/bolcom/connect ─────────────────────
integrationsRouter.post('/bolcom/connect', async (req: Request, res: Response) => {
  const { tenantId } = getTenantContext();
  const { clientId, clientSecret } = z.object({
    clientId:     z.string().min(1),
    clientSecret: z.string().min(1),
  }).parse(req.body);

  // Test connectie
  const connector = new BolComConnector(clientId, clientSecret);
  const test = await connector.testConnection();
  if (!test.ok) {
    return res.status(400).json({ error: `Bol.com connectie mislukt: ${test.error}` });
  }

  const result = await db.query<{ id: string }>(
    `INSERT INTO platform_connections
       (tenant_id, platform, shop_name, api_key_enc, api_secret_enc, status)
     VALUES ($1, 'bolcom', 'Bol.com Store', $2, $3, 'active')
     ON CONFLICT (tenant_id, platform, shop_name)
     DO UPDATE SET api_key_enc = EXCLUDED.api_key_enc, api_secret_enc = EXCLUDED.api_secret_enc,
                   status = 'active', updated_at = now()
     RETURNING id`,
    [tenantId, encryptSecret(clientId), encryptSecret(clientSecret)]
  );

  const connectionId = result.rows[0].id;
  syncService.syncConnection(connectionId).catch(() => {});

  res.json({ connectionId, message: 'Bol.com gekoppeld' });
});

// ── POST /api/integrations/etsy/connect ───────────────────────
integrationsRouter.post('/etsy/connect', async (req: Request, res: Response) => {
  const { tenantId } = getTenantContext();
  const { shopId, accessToken } = z.object({
    shopId:      z.string().min(1),
    accessToken: z.string().min(1),
  }).parse(req.body);

  const connector = new EtsyConnector(shopId, accessToken);
  const test = await connector.testConnection();
  if (!test.ok) return res.status(400).json({ error: test.error });

  const result = await db.query<{ id: string }>(
    `INSERT INTO platform_connections
       (tenant_id, platform, shop_name, platform_shop_id, access_token_enc, status)
     VALUES ($1, 'etsy', $2, $3, $4, 'active')
     ON CONFLICT (tenant_id, platform, shop_name)
     DO UPDATE SET access_token_enc = EXCLUDED.access_token_enc, status = 'active', updated_at = now()
     RETURNING id`,
    [tenantId, test.shopName, shopId, encryptSecret(accessToken)]
  );

  const connectionId = result.rows[0].id;
  syncService.syncConnection(connectionId).catch(() => {});
  res.json({ connectionId, shopName: test.shopName });
});

// ── POST /api/integrations/woocommerce/connect ────────────────
integrationsRouter.post('/woocommerce/connect', async (req: Request, res: Response) => {
  const { tenantId } = getTenantContext();
  const { siteUrl, consumerKey, consumerSecret } = z.object({
    siteUrl:        z.string().url(),
    consumerKey:    z.string().min(1),
    consumerSecret: z.string().min(1),
  }).parse(req.body);

  const connector = new WooCommerceConnector(siteUrl, consumerKey, consumerSecret);
  const test = await connector.testConnection();
  if (!test.ok) return res.status(400).json({ error: test.error });

  const result = await db.query<{ id: string }>(
    `INSERT INTO platform_connections
       (tenant_id, platform, shop_name, shop_url, api_key_enc, api_secret_enc, status)
     VALUES ($1, 'woocommerce', $2, $3, $4, $5, 'active')
     ON CONFLICT (tenant_id, platform, shop_name)
     DO UPDATE SET api_key_enc = EXCLUDED.api_key_enc, api_secret_enc = EXCLUDED.api_secret_enc,
                   status = 'active', updated_at = now()
     RETURNING id`,
    [tenantId, test.shopName, siteUrl, encryptSecret(consumerKey), encryptSecret(consumerSecret)]
  );

  syncService.syncConnection(result.rows[0].id).catch(() => {});
  res.json({ connectionId: result.rows[0].id, shopName: test.shopName });
});

// ── POST /api/integrations/:id/sync — manuele sync ───────────
integrationsRouter.post('/:id/sync', async (req: Request, res: Response) => {
  const { id } = req.params;
  const result = await syncService.syncConnection(id);
  res.json(result);
});

// ── DELETE /api/integrations/:id — koppeling verwijderen ──────
integrationsRouter.delete('/:id', async (req: Request, res: Response) => {
  const { tenantId } = getTenantContext();
  await db.query(
    `UPDATE platform_connections SET status = 'disconnected' WHERE id = $1 AND tenant_id = $2`,
    [req.params.id, tenantId]
  );
  res.json({ message: 'Koppeling verwijderd' });
});
