// ============================================================
// src/modules/integrations/shopify/service/shopify-oauth.service.ts
//
// Beheert de Shopify OAuth flow:
//  1. Genereer installatie URL
//  2. Verwerk OAuth callback → wissel code in voor access token
//  3. Sla encrypted token op in database
// ============================================================

import crypto from 'crypto';
import axios from 'axios';
import { db } from '../../../../infrastructure/database/connection';
import { getTenantContext } from '../../../../shared/middleware/tenant-context';
import { logger } from '../../../../shared/logging/logger';
import { ShopifyConnector } from './shopify.connector';
import { encryptSecret, decryptSecret } from '../../../../shared/crypto/encryption';

const SHOPIFY_SCOPES = [
  'read_orders',
  'read_products',
  'read_inventory',
  'read_customers',
  'read_analytics',
  'read_marketing_events',
  'read_reports',
].join(',');

export class ShopifyOAuthService {

  // ── Stap 1: Genereer OAuth installatie URL ────────────────
  generateInstallUrl(shopDomain: string): string {
    const state = crypto.randomBytes(16).toString('hex');

    // State opslaan in Redis/cache zodat we callback kunnen valideren
    // (in productie via Redis, hier via query param voor eenvoud)
    const params = new URLSearchParams({
      client_id:    process.env.SHOPIFY_API_KEY!,
      scope:        SHOPIFY_SCOPES,
      redirect_uri: `${process.env.APP_URL}/api/integrations/shopify/callback`,
      state,
      'grant_options[]': 'per-user',
    });

    return `https://${shopDomain}/admin/oauth/authorize?${params}`;
  }

  // ── Stap 2: Verwerk OAuth callback ───────────────────────
  async handleCallback(params: {
    shop:  string;
    code:  string;
    state: string;
    hmac:  string;
  }): Promise<{ connectionId: string; shopName: string }> {
    const { tenantId } = getTenantContext();

    // HMAC verificatie — voorkomt nep callbacks
    this.verifyHmac(params);

    // Wissel code in voor permanent access token
    const tokenRes = await axios.post(
      `https://${params.shop}/admin/oauth/access_token`,
      {
        client_id:     process.env.SHOPIFY_API_KEY,
        client_secret: process.env.SHOPIFY_API_SECRET,
        code:          params.code,
      }
    );

    const accessToken: string = tokenRes.data.access_token;

    // Test connectie en haal shop info op
    const connector = new ShopifyConnector(params.shop, accessToken);
    const test = await connector.testConnection();
    if (!test.ok) throw new Error(`Shopify connectie mislukt: ${test.error}`);

    // Token versleuteld opslaan
    const encryptedToken = encryptSecret(accessToken);

    const result = await db.query<{ id: string }>(
      `INSERT INTO platform_connections
         (tenant_id, platform, shop_name, shop_url, access_token_enc,
          platform_shop_id, status)
       VALUES ($1, 'shopify', $2, $3, $4, $5, 'active')
       ON CONFLICT (tenant_id, platform, shop_name)
       DO UPDATE SET
         access_token_enc = EXCLUDED.access_token_enc,
         status = 'active',
         last_error = NULL,
         updated_at = now()
       RETURNING id`,
      [tenantId, test.shopName ?? params.shop, `https://${params.shop}`,
       encryptedToken, params.shop],
      { allowNoTenant: true }
    );

    const connectionId = result.rows[0].id;

    logger.info('shopify.oauth.completed', { tenantId, shop: params.shop });

    return { connectionId, shopName: test.shopName ?? params.shop };
  }

  // ── Shopify webhooks registreren ──────────────────────────
  async registerWebhooks(shopDomain: string, accessToken: string): Promise<void> {
    const connector = new ShopifyConnector(shopDomain, accessToken);

    const webhooks = [
      { topic: 'orders/create',  address: `${process.env.APP_URL}/api/integrations/shopify/webhooks/orders` },
      { topic: 'orders/updated', address: `${process.env.APP_URL}/api/integrations/shopify/webhooks/orders` },
      { topic: 'products/update',address: `${process.env.APP_URL}/api/integrations/shopify/webhooks/products` },
    ];

    for (const wh of webhooks) {
      try {
        await axios.post(
          `https://${shopDomain}/admin/api/2024-01/webhooks.json`,
          { webhook: { topic: wh.topic, address: wh.address, format: 'json' } },
          { headers: { 'X-Shopify-Access-Token': accessToken } }
        );
      } catch (err: any) {
        // 422 = webhook bestaat al — dat is ok
        if (err.response?.status !== 422) {
          logger.warn('shopify.webhook.register.failed', { topic: wh.topic, error: err.message });
        }
      }
    }

    logger.info('shopify.webhooks.registered', { shopDomain });
  }

  // ── HMAC verificatie ──────────────────────────────────────
  private verifyHmac(params: { shop: string; code: string; state: string; hmac: string }): void {
    const { hmac, ...rest } = params;
    const message = Object.entries(rest)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}=${v}`)
      .join('&');

    const computed = crypto
      .createHmac('sha256', process.env.SHOPIFY_API_SECRET!)
      .update(message)
      .digest('hex');

    if (computed !== hmac) {
      throw new Error('Shopify HMAC verificatie mislukt — mogelijke aanval');
    }
  }
}

// Helper: haal decrypted access token op voor een connection
export async function getShopifyConnector(connectionId: string): Promise<ShopifyConnector> {
  const result = await db.query<{
    shop_url: string; access_token_enc: string;
  }>(
    `SELECT shop_url, access_token_enc FROM platform_connections
     WHERE id = $1 AND platform = 'shopify'`,
    [connectionId], { allowNoTenant: true }
  );

  const conn = result.rows[0];
  if (!conn) throw new Error(`Shopify connectie niet gevonden: ${connectionId}`);

  const shopDomain = conn.shop_url.replace('https://', '');
  const accessToken = decryptSecret(conn.access_token_enc);
  return new ShopifyConnector(shopDomain, accessToken);
}
