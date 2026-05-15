// ============================================================
// saas-platform/src/modules/integrations/service/shopify-install.service.ts
//
// Shopify App Store install flow. Voldoet aan Shopify's eis
// "Your app must immediately authenticate using OAuth before
// any other steps occur":
//
//   1. /install ontvangt GET met shop/hmac/timestamp.
//   2. HMAC wordt server-side geverifieerd via client_secret.
//   3. Direct 302 redirect naar de shop's /admin/oauth/authorize.
//
// Geen UI, geen login prompt, geen tussenstap. Binding tussen
// Shopify token en MarketGrow tenant gebeurt NA OAuth callback
// via een handoff token, geconsumeerd door /install/finalize.
//
// De bestaande dashboard flow (POST /api/integrations/shopify/install)
// blijft onveranderd. Deze service is uitsluitend voor de
// App Store install path.
// ============================================================

import crypto from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import { cache } from '../../../infrastructure/cache/redis';
import { db } from '../../../infrastructure/database/connection';
import { logger } from '../../../shared/logging/logger';
import { encryptToken } from '../../../shared/crypto/token-encryption';
import { syncQueue } from '../workers/sync.worker';

// Scopes gelijk aan integration.service.ts SHOPIFY_SCOPES.
const SHOPIFY_SCOPES =
  'read_analytics,read_customers,read_inventory,read_marketing_events,read_orders,read_products,read_reports';

const STATE_TTL_SECONDS    = 600;   // 10 min voor OAuth roundtrip
const HANDOFF_TTL_SECONDS  = 900;   // 15 min voor account binding
const MAX_TIMESTAMP_SKEW_S = 300;   // 5 min anti-replay

// Shop hostname regex per Shopify documentatie.
const SHOP_REGEX = /^[a-zA-Z0-9][a-zA-Z0-9\-]*\.myshopify\.com$/;

interface InstallStateData {
  shop:      string;
  createdAt: number;
}

interface HandoffData {
  shop:        string;
  shopName:    string | null;
  accessToken: string;
  scope:       string;
  createdAt:   number;
}

interface InstallStartResult {
  authUrl: string;
}

interface InstallCallbackResult {
  redirectTo: string;
}

export class ShopifyInstallService {

  /**
   * Stap 1 van Shopify install. Verifieert HMAC + shop, slaat
   * state op en geeft de OAuth grant URL terug.
   */
  async startInstall(query: Record<string, string>): Promise<InstallStartResult> {
    const { shop, hmac, timestamp } = query;

    if (!shop || !hmac || !timestamp) {
      throw makeError(400, 'Missing required parameters: shop, hmac, timestamp');
    }

    if (!isValidShop(shop)) {
      throw makeError(400, 'Invalid shop hostname');
    }

    if (!isFreshTimestamp(timestamp)) {
      throw makeError(400, 'Stale or invalid timestamp');
    }

    if (!verifyHmac(query, hmac, requireClientSecret())) {
      logger.warn('shopify.install.hmac_failed', { shop });
      throw makeError(401, 'Invalid HMAC signature');
    }

    const state = crypto.randomBytes(32).toString('hex');
    const stateData: InstallStateData = { shop, createdAt: Date.now() };
    await cache.set(
      'shopify:install:state:' + state,
      JSON.stringify(stateData),
      STATE_TTL_SECONDS
    );

    const redirectUri = buildCallbackUrl();
    const authUrl =
      'https://' + shop + '/admin/oauth/authorize?' +
      new URLSearchParams({
        client_id:    requireClientId(),
        scope:        SHOPIFY_SCOPES,
        redirect_uri: redirectUri,
        state,
      }).toString();

    logger.info('shopify.install.started', { shop });
    return { authUrl };
  }

  /**
   * OAuth callback. Verifieert state + HMAC + shop, wisselt code
   * in voor offline access token, bewaart token tijdelijk onder
   * een handoff token, en geeft de frontend redirect URL terug.
   *
   * Als de shop al gekoppeld is aan een tenant (re-install):
   * direct dashboard redirect, geen handoff.
   */
  async handleCallback(query: Record<string, string>): Promise<InstallCallbackResult> {
    const { code, hmac, shop, state } = query;

    if (!code || !hmac || !shop || !state) {
      throw makeError(400, 'Missing required parameters: code, hmac, shop, state');
    }

    if (!isValidShop(shop)) {
      throw makeError(400, 'Invalid shop hostname');
    }

    const cached = await cache.get('shopify:install:state:' + state);
    if (!cached) {
      throw makeError(400, 'Expired or invalid state');
    }
    const stateData = JSON.parse(cached) as InstallStateData;
    await cache.del('shopify:install:state:' + state);

    if (stateData.shop !== shop) {
      logger.warn('shopify.install.shop_mismatch', {
        expected: stateData.shop,
        received: shop,
      });
      throw makeError(400, 'Shop mismatch');
    }

    if (!verifyHmac(query, hmac, requireClientSecret())) {
      logger.warn('shopify.install.callback_hmac_failed', { shop });
      throw makeError(401, 'Invalid HMAC signature');
    }

    // Token exchange.
    const tokenRes = await fetch('https://' + shop + '/admin/oauth/access_token', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        client_id:     requireClientId(),
        client_secret: requireClientSecret(),
        code,
      }),
    });

    if (!tokenRes.ok) {
      const body = await tokenRes.text().catch(() => '');
      logger.error('shopify.install.token_exchange_failed', {
        shop,
        status: tokenRes.status,
        body:   body.substring(0, 200),
      });
      throw makeError(502, 'Shopify token exchange failed');
    }

    const tokenJson = await tokenRes.json() as { access_token?: string; scope?: string };
    if (!tokenJson.access_token) {
      throw makeError(502, 'Empty access token from Shopify');
    }

    // Verifieer dat alle gevraagde scopes ook gegrant zijn.
    // (Shopify staat toe dat de user scopes terugschroeft in de URL.)
    const grantedScopes = new Set(
      (tokenJson.scope || '').split(',').map(s => s.trim()).filter(Boolean)
    );
    for (const requested of SHOPIFY_SCOPES.split(',')) {
      if (!grantedScopes.has(requested)) {
        logger.warn('shopify.install.scope_missing', {
          shop,
          requested,
          granted: tokenJson.scope,
        });
        throw makeError(403, 'Required scope not granted: ' + requested);
      }
    }

    // Probeer shop naam op te halen voor weergave op /shopify/connect.
    let shopName: string | null = null;
    try {
      const shopInfo = await fetch(
        'https://' + shop + '/admin/api/2024-01/shop.json',
        { headers: { 'X-Shopify-Access-Token': tokenJson.access_token } }
      );
      if (shopInfo.ok) {
        const j = await shopInfo.json() as { shop?: { name?: string } };
        shopName = j.shop?.name ?? null;
      }
    } catch { /* niet kritiek */ }

    // Bestaat deze shop al als integration?
    const existing = await db.query<{ tenant_id: string }>(
      `SELECT tenant_id FROM tenant_integrations
       WHERE platform_slug = 'shopify' AND shop_domain = $1 AND status != 'disconnected'
       LIMIT 1`,
      [shop],
      { allowNoTenant: true }
    );

    if (existing.rows[0]) {
      // Re-install: update token onder de bestaande tenant.
      const tenantId      = existing.rows[0].tenant_id;
      const integrationId = await upsertShopifyIntegration({
        tenantId,
        shop,
        shopName,
        accessToken: tokenJson.access_token,
      });

      try {
        await syncQueue.add('sync:shopify:' + integrationId + ':reinstall', {
          integrationId,
          tenantId,
          platformSlug: 'shopify',
          jobType:      'full_sync' as const,
          syncJobDbId:  uuidv4(),
        }, { attempts: 3, backoff: { type: 'exponential', delay: 5000 } });
      } catch (err: any) {
        logger.warn('shopify.install.reinstall_sync_enqueue_failed', {
          tenantId,
          error: err.message,
        });
      }

      logger.info('shopify.install.reinstalled', { tenantId, shop });
      return {
        redirectTo:
          buildFrontendUrl() +
          '/dashboard/integrations?reconnected=shopify',
      };
    }

    // Nieuwe install: handoff token uitgeven, frontend kan finalizen.
    const handoffToken = crypto.randomBytes(32).toString('hex');
    const handoff: HandoffData = {
      shop,
      shopName,
      accessToken: tokenJson.access_token,
      scope:       tokenJson.scope || '',
      createdAt:   Date.now(),
    };
    await cache.set(
      'shopify:install:handoff:' + handoffToken,
      JSON.stringify(handoff),
      HANDOFF_TTL_SECONDS
    );

    logger.info('shopify.install.handoff_issued', { shop });

    const params = new URLSearchParams({ handoff: handoffToken, shop });
    if (shopName) params.set('shopName', shopName);

    return {
      redirectTo: buildFrontendUrl() + '/shopify/connect?' + params.toString(),
    };
  }

  /**
   * Niet-consumerende lookup voor /shopify/connect om de shop
   * naam te tonen. Het handoff token is voldoende geheim.
   */
  async previewHandoff(
    handoffToken: string
  ): Promise<{ shop: string; shopName: string | null }> {
    if (!isValidHandoffToken(handoffToken)) {
      throw makeError(400, 'Invalid handoff token');
    }
    const raw = await cache.get('shopify:install:handoff:' + handoffToken);
    if (!raw) {
      throw makeError(410, 'Handoff token expired or already used');
    }
    const data = JSON.parse(raw) as HandoffData;
    return { shop: data.shop, shopName: data.shopName };
  }

  /**
   * Geroepen door ingelogde user vanaf /shopify/connect. Bindt
   * Shopify integratie aan de huidige tenant en consumeert de
   * handoff (atomair: cache.del voor DB-werk om double-submit
   * af te vangen).
   */
  async finalize(
    tenantId: string,
    handoffToken: string
  ): Promise<{ integrationId: string; shop: string }> {
    if (!isValidHandoffToken(handoffToken)) {
      throw makeError(400, 'Invalid handoff token');
    }

    const raw = await cache.get('shopify:install:handoff:' + handoffToken);
    if (!raw) {
      throw makeError(410, 'Handoff token expired or already used');
    }
    const data = JSON.parse(raw) as HandoffData;

    // Atomic consume voor DB-werk.
    await cache.del('shopify:install:handoff:' + handoffToken);

    // Voorkom cross-tenant hijack.
    const existing = await db.query<{ tenant_id: string }>(
      `SELECT tenant_id FROM tenant_integrations
       WHERE platform_slug = 'shopify' AND shop_domain = $1 AND status != 'disconnected'
       LIMIT 1`,
      [data.shop],
      { allowNoTenant: true }
    );
    if (existing.rows[0] && existing.rows[0].tenant_id !== tenantId) {
      logger.warn('shopify.install.cross_tenant_attempt', {
        currentTenant:  tenantId,
        existingTenant: existing.rows[0].tenant_id,
        shop:           data.shop,
      });
      throw makeError(409, 'This Shopify store is already linked to another MarketGrow account.');
    }

    const integrationId = await upsertShopifyIntegration({
      tenantId,
      shop:        data.shop,
      shopName:    data.shopName,
      accessToken: data.accessToken,
    });

    // Trigger initial full_sync.
    try {
      await syncQueue.add('sync:shopify:' + integrationId + ':initial', {
        integrationId,
        tenantId,
        platformSlug: 'shopify',
        jobType:      'full_sync' as const,
        syncJobDbId:  uuidv4(),
      }, { attempts: 3, backoff: { type: 'exponential', delay: 5000 } });
    } catch (err: any) {
      logger.warn('shopify.install.initial_sync_enqueue_failed', {
        tenantId,
        error: err.message,
      });
    }

    logger.info('shopify.install.finalized', {
      tenantId,
      shop: data.shop,
      integrationId,
    });
    return { integrationId, shop: data.shop };
  }
}

// ─────────────────────────────────────────────────────────────
// Internal helpers
// ─────────────────────────────────────────────────────────────

function requireClientId(): string {
  const v = process.env.SHOPIFY_CLIENT_ID;
  if (!v) throw new Error('SHOPIFY_CLIENT_ID is not set');
  return v;
}

function requireClientSecret(): string {
  const v = process.env.SHOPIFY_CLIENT_SECRET;
  if (!v) throw new Error('SHOPIFY_CLIENT_SECRET is not set');
  return v;
}

function buildCallbackUrl(): string {
  const base = process.env.APP_URL || 'https://marketgrowth-production.up.railway.app';
  return base + '/api/shopify/install/callback';
}

function buildFrontendUrl(): string {
  return process.env.FRONTEND_URL || 'https://marketgrow.ai';
}

function isValidShop(shop: string): boolean {
  if (typeof shop !== 'string') return false;
  if (shop.length > 253) return false;
  return SHOP_REGEX.test(shop);
}

function isFreshTimestamp(ts: string): boolean {
  const n = Number(ts);
  if (!Number.isFinite(n) || n <= 0) return false;
  const ageSeconds = Math.abs(Math.floor(Date.now() / 1000) - n);
  return ageSeconds <= MAX_TIMESTAMP_SKEW_S;
}

function isValidHandoffToken(t: string): boolean {
  return typeof t === 'string' && /^[a-f0-9]{64}$/.test(t);
}

/**
 * HMAC-SHA256 verificatie per Shopify docs:
 *   1. Maak query-string sleutel/waarde tabel
 *   2. Verwijder "hmac" key (en "signature" voor zekerheid)
 *   3. Sorteer keys alfabetisch
 *   4. Concat als "key=value&key=value..."
 *   5. HMAC-SHA256 met client_secret
 *   6. Timing-safe compare met hexdigest
 */
function verifyHmac(
  query: Record<string, string>,
  providedHmac: string,
  secret: string
): boolean {
  const entries = Object.entries(query)
    .filter(([k]) => k !== 'hmac' && k !== 'signature')
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => k + '=' + v);

  const message = entries.join('&');
  const digest  = crypto.createHmac('sha256', secret).update(message).digest('hex');

  const a = Buffer.from(digest);
  const b = Buffer.from(providedHmac);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function makeError(status: number, message: string): Error & { httpStatus: number } {
  return Object.assign(new Error(message), { httpStatus: status });
}

/**
 * Idempotent upsert van tenant_integrations + integration_credentials.
 * RLS-bypass via allowNoTenant omdat tenantId expliciet meekomt.
 * Token wordt AES-256-GCM versleuteld via encryptToken.
 */
async function upsertShopifyIntegration(params: {
  tenantId:    string;
  shop:        string;
  shopName:    string | null;
  accessToken: string;
}): Promise<string> {
  const { tenantId, shop, shopName, accessToken } = params;
  const integrationId = uuidv4();

  const upsert = await db.query<{ id: string }>(
    `INSERT INTO tenant_integrations
       (id, tenant_id, platform_slug, shop_domain, shop_name, status, created_at, updated_at)
     VALUES ($1, $2, 'shopify', $3, $4, 'active', now(), now())
     ON CONFLICT (tenant_id, platform_slug, shop_domain)
     DO UPDATE SET
       status     = 'active',
       shop_name  = EXCLUDED.shop_name,
       updated_at = now()
     RETURNING id`,
    [integrationId, tenantId, shop, shopName],
    { allowNoTenant: true }
  );
  const actualId = upsert.rows[0].id;

  await db.query(
    `INSERT INTO integration_credentials
       (integration_id, access_token, updated_at, encrypted_at)
     VALUES ($1, $2, now(), now())
     ON CONFLICT (integration_id)
     DO UPDATE SET
       access_token = EXCLUDED.access_token,
       updated_at   = now(),
       encrypted_at = now()`,
    [actualId, encryptToken(accessToken)],
    { allowNoTenant: true }
  );

  return actualId;
}

export const shopifyInstallService = new ShopifyInstallService();
