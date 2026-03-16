import crypto from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import { db } from '../../../infrastructure/database/connection';
import { cache } from '../../../infrastructure/cache/redis';
import { logger } from '../../../shared/logging/logger';
import { getTenantContext } from '../../../shared/middleware/tenant-context';
import { syncQueue } from '../workers/sync.worker';
import { getConnector } from '../connectors/connector.factory';
import {
  PlatformSlug,
  ConnectIntegrationRequest,
  ConnectIntegrationResponse,
  IntegrationSummary,
  SyncStatusResponse,
  SyncJobSummary,
  IntegrationCredentials,
} from '../types/integration.types';

const PLAN_STORE_LIMITS: Record<string, number> = {
  starter: 1,
  growth:  3,
  scale:   999,
};

const PLATFORM_NAMES: Record<PlatformSlug, string> = {
  shopify:     'Shopify',
  woocommerce: 'WooCommerce',
  lightspeed:  'Lightspeed',
  bigcommerce: 'BigCommerce',
  bolcom:      'Bol.com',
  magento:     'Magento',
  amazon:      'Amazon',
  etsy:        'Etsy',
};

const OAUTH_PLATFORMS: PlatformSlug[] = ['shopify', 'amazon', 'etsy'];

// Volledige Shopify scope lijst — moet overeenkomen met Shopify Partner app config
const SHOPIFY_SCOPES = 'read_analytics,read_customers,read_inventory,read_marketing_events,read_orders,read_products,read_reports';

export class IntegrationService {

  // ── Verbinding starten ────────────────────────────────────
  async connect(input: ConnectIntegrationRequest): Promise<ConnectIntegrationResponse> {
    const { tenantId, planSlug } = getTenantContext();

    const countResult = await db.query(
      `SELECT COUNT(*) FROM tenant_integrations WHERE tenant_id = $1 AND status != 'disconnected'`,
      [tenantId]
    );
    const currentCount = parseInt(countResult.rows[0].count);
    const limit = PLAN_STORE_LIMITS[planSlug] ?? 1;

    if (currentCount >= limit) {
      throw Object.assign(
        new Error('Je ' + planSlug + ' abonnement staat maximaal ' + limit + ' winkel(s) toe.'),
        { code: 'PLAN_LIMIT_EXCEEDED', httpStatus: 403 }
      );
    }

    if (OAUTH_PLATFORMS.includes(input.platformSlug)) {
      return this.startOAuthFlow(input, tenantId);
    }

    return this.connectWithApiKey(input, tenantId);
  }

  // ── OAuth flow starten ────────────────────────────────────
  private async startOAuthFlow(input: ConnectIntegrationRequest, tenantId: string): Promise<ConnectIntegrationResponse> {
    const state = crypto.randomBytes(16).toString('hex');
    const integrationId = uuidv4();
    const appUrl = process.env.APP_URL || 'https://marketgrowth-production.up.railway.app';
    const redirectUri = appUrl + '/api/integrations/callback/' + input.platformSlug;

    await cache.set(
      'oauth:state:' + state,
      JSON.stringify({ tenantId, integrationId, platformSlug: input.platformSlug, shopDomain: input.shopDomain }),
      600
    );

    let authUrl: string;

    if (input.platformSlug === 'shopify') {
      if (!input.shopDomain) throw new Error('shopDomain is verplicht voor Shopify');
      authUrl = 'https://' + input.shopDomain + '/admin/oauth/authorize?' +
        new URLSearchParams({
          client_id:    process.env.SHOPIFY_CLIENT_ID || '',
          scope:        SHOPIFY_SCOPES,
          redirect_uri: redirectUri,
          state,
        }).toString();
    } else if (input.platformSlug === 'amazon') {
      authUrl = 'https://sellercentral.amazon.com/apps/authorize/consent?' +
        new URLSearchParams({
          application_id: process.env.AMAZON_CLIENT_ID || '',
          redirect_uri:   redirectUri,
          state,
          version:        'beta',
        }).toString();
    } else if (input.platformSlug === 'etsy') {
      const codeVerifier = crypto.randomBytes(32).toString('base64url');
      const codeChallenge = crypto.createHash('sha256').update(codeVerifier).digest('base64url');
      await cache.set('oauth:pkce:' + state, codeVerifier, 600);
      authUrl = 'https://www.etsy.com/oauth/connect?' +
        new URLSearchParams({
          response_type:         'code',
          redirect_uri:          redirectUri,
          scope:                 'transactions_r listings_r',
          client_id:             process.env.ETSY_CLIENT_ID || '',
          state,
          code_challenge:        codeChallenge,
          code_challenge_method: 'S256',
        }).toString();
    } else {
      throw new Error('Onbekend OAuth platform: ' + input.platformSlug);
    }

    logger.info('integration.oauth.started', { tenantId, platform: input.platformSlug });
    return { integrationId, authUrl, status: 'oauth_required' };
  }

  // ── OAuth callback afhandelen ─────────────────────────────
  async handleOAuthCallback(platformSlug: PlatformSlug, code: string, state: string): Promise<{ integrationId: string; tenantId: string }> {
    const cached = await cache.get('oauth:state:' + state);
    if (!cached) throw Object.assign(new Error('Ongeldige of verlopen OAuth state'), { httpStatus: 400 });

    const { tenantId, integrationId, shopDomain } = JSON.parse(cached) as {
      tenantId: string; integrationId: string; platformSlug: PlatformSlug; shopDomain?: string;
    };
    await cache.del('oauth:state:' + state);

    let accessToken: string;
    let refreshToken: string | undefined;

    if (platformSlug === 'shopify') {
      const res = await fetch('https://' + shopDomain + '/admin/oauth/access_token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client_id:     process.env.SHOPIFY_CLIENT_ID,
          client_secret: process.env.SHOPIFY_CLIENT_SECRET,
          code,
        }),
      });
      if (!res.ok) throw new Error('Shopify token exchange mislukt: ' + await res.text());
      const d = await res.json() as { access_token: string };
      accessToken = d.access_token;
    } else if (platformSlug === 'amazon') {
      const res = await fetch('https://api.amazon.com/auth/o2/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type:    'authorization_code',
          code,
          client_id:     process.env.AMAZON_CLIENT_ID || '',
          client_secret: process.env.AMAZON_CLIENT_SECRET || '',
        }),
      });
      if (!res.ok) throw new Error('Amazon token exchange mislukt');
      const d = await res.json() as { access_token: string; refresh_token: string };
      accessToken = d.access_token;
      refreshToken = d.refresh_token;
    } else if (platformSlug === 'etsy') {
      const codeVerifier = await cache.get('oauth:pkce:' + state) || '';
      await cache.del('oauth:pkce:' + state);
      const appUrl = process.env.APP_URL || 'https://marketgrowth-production.up.railway.app';
      const res = await fetch('https://api.etsy.com/v3/public/oauth/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type:    'authorization_code',
          client_id:     process.env.ETSY_CLIENT_ID || '',
          redirect_uri:  appUrl + '/api/integrations/callback/etsy',
          code,
          code_verifier: codeVerifier,
        }),
      });
      if (!res.ok) throw new Error('Etsy token exchange mislukt');
      const d = await res.json() as { access_token: string; refresh_token: string };
      accessToken = d.access_token;
      refreshToken = d.refresh_token;
    } else {
      throw new Error('Onbekend OAuth platform: ' + platformSlug);
    }

    // Test de verbinding
    const connector = getConnector(platformSlug);
    const tempCreds: IntegrationCredentials = {
      integrationId,
      platform: platformSlug,
      accessToken,
      refreshToken,
      shopDomain,
    };
    const testResult = await connector.testConnection(tempCreds);
    if (!testResult.success) throw new Error('Verbindingstest mislukt: ' + testResult.error);

    // Sla integratie op
    await db.query(
      `INSERT INTO tenant_integrations
         (id, tenant_id, platform_slug, shop_domain, shop_name, status, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, 'active', now(), now())
       ON CONFLICT (tenant_id, platform_slug, shop_domain)
       DO UPDATE SET status = 'active', shop_name = EXCLUDED.shop_name, updated_at = now()`,
      [integrationId, tenantId, platformSlug, shopDomain || null, testResult.shopName || null],
      { allowNoTenant: true }
    );

    // Sla credentials op
    await db.query(
      `INSERT INTO integration_credentials (integration_id, access_token, refresh_token, updated_at)
       VALUES ($1, $2, $3, now())
       ON CONFLICT (integration_id)
       DO UPDATE SET access_token = EXCLUDED.access_token, refresh_token = EXCLUDED.refresh_token, updated_at = now()`,
      [integrationId, accessToken, refreshToken || null],
      { allowNoTenant: true }
    );

    // Start initiële full sync
    const syncJobDbId = uuidv4();
    await syncQueue.add('sync:' + platformSlug + ':' + integrationId + ':initial', {
      integrationId,
      tenantId,
      platformSlug,
      jobType:     'full_sync',
      syncJobDbId,
    }, { attempts: 3, backoff: { type: 'exponential', delay: 5000 } });

    logger.info('integration.connected', { tenantId, integrationId, platformSlug });
    return { integrationId, tenantId };
  }

  // ── API key koppeling (WooCommerce, Bol.com, etc.) ────────
  private async connectWithApiKey(input: ConnectIntegrationRequest, tenantId: string): Promise<ConnectIntegrationResponse> {
    const integrationId = uuidv4();
    const connector = getConnector(input.platformSlug);
    const creds: IntegrationCredentials = {
      integrationId,
      platform:   input.platformSlug,
      apiKey:     input.apiKey,
      apiSecret:  input.apiSecret,
      storeUrl:   input.storeUrl,
      shopDomain: input.shopDomain,
    };

    const testResult = await connector.testConnection(creds);
    if (!testResult.success) {
      throw Object.assign(new Error('Verbinding mislukt: ' + testResult.error), { httpStatus: 400 });
    }

    await db.query(
      `INSERT INTO tenant_integrations
         (id, tenant_id, platform_slug, shop_domain, shop_name, store_url, status, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, 'active', now(), now())`,
      [
        integrationId,
        tenantId,
        input.platformSlug,
        input.shopDomain || null,
        testResult.shopName || null,
        input.storeUrl || null,
      ],
      { allowNoTenant: true }
    );

    await db.query(
      `INSERT INTO integration_credentials (integration_id, api_key, api_secret, store_url, updated_at)
       VALUES ($1, $2, $3, $4, now())`,
      [integrationId, input.apiKey || null, input.apiSecret || null, input.storeUrl || null],
      { allowNoTenant: true }
    );

    const syncJobDbId = uuidv4();
    await syncQueue.add('sync:' + input.platformSlug + ':' + integrationId + ':initial', {
      integrationId,
      tenantId,
      platformSlug: input.platformSlug,
      jobType:      'full_sync',
      syncJobDbId,
    }, { attempts: 3, backoff: { type: 'exponential', delay: 5000 } });

    logger.info('integration.connected.apikey', { tenantId, integrationId, platform: input.platformSlug });
    return { integrationId, status: 'connected' };
  }

  // ── Lijst van integraties ─────────────────────────────────
  async listIntegrations(): Promise<IntegrationSummary[]> {
    const { tenantId } = getTenantContext();
    const result = await db.query(
      `SELECT ti.id, ti.platform_slug, ti.shop_domain, ti.shop_name,
              ti.status, ti.last_sync_at, ti.next_sync_at, ti.error_message,
              ti.is_primary, ti.created_at,
              COUNT(o.id)::int AS orders_count
       FROM tenant_integrations ti
       LEFT JOIN orders o ON o.integration_id = ti.id
       WHERE ti.tenant_id = $1 AND ti.status != 'disconnected'
       GROUP BY ti.id ORDER BY ti.created_at ASC`,
      [tenantId]
    );
    return result.rows.map(row => ({
      id:           row.id,
      platformSlug: row.platform_slug as PlatformSlug,
      platformName: PLATFORM_NAMES[row.platform_slug as PlatformSlug] || row.platform_slug,
      status:       row.status,
      shopDomain:   row.shop_domain,
      shopName:     row.shop_name,
      isPrimary:    row.is_primary,
      lastSyncAt:   row.last_sync_at,
      nextSyncAt:   row.next_sync_at,
      ordersCount:  row.orders_count,
      errorMessage: row.error_message,
      createdAt:    row.created_at,
    }));
  }

  // ── Sync triggeren ────────────────────────────────────────
  async triggerSync(integrationId: string, jobType: 'full_sync' | 'incremental' = 'incremental'): Promise<{ syncJobId: string }> {
    const { tenantId } = getTenantContext();
    const syncJobId = uuidv4();

    const integration = await db.query(
      `SELECT platform_slug FROM tenant_integrations WHERE id = $1 AND tenant_id = $2`,
      [integrationId, tenantId]
    );
    if (!integration.rows[0]) throw Object.assign(new Error('Integratie niet gevonden'), { httpStatus: 404 });

    const platformSlug = integration.rows[0].platform_slug as PlatformSlug;

    await db.query(
      `INSERT INTO integration_sync_jobs (id, integration_id, tenant_id, job_type, status, created_at)
       VALUES ($1, $2, $3, $4, 'queued', now())`,
      [syncJobId, integrationId, tenantId, jobType],
      { allowNoTenant: true }
    );

    await syncQueue.add('sync:' + platformSlug + ':' + integrationId, {
      integrationId, tenantId, platformSlug, jobType, syncJobDbId: syncJobId,
    }, { attempts: 3, backoff: { type: 'exponential', delay: 5000 } });

    return { syncJobId };
  }

  // ── Sync status ───────────────────────────────────────────
  async getSyncStatus(integrationId: string): Promise<SyncStatusResponse> {
    const { tenantId } = getTenantContext();

    const integration = await db.query(
      `SELECT status, last_sync_at, next_sync_at, error_message
       FROM tenant_integrations WHERE id = $1 AND tenant_id = $2`,
      [integrationId, tenantId]
    );
    if (!integration.rows[0]) throw Object.assign(new Error('Integratie niet gevonden'), { httpStatus: 404 });

    const jobs = await db.query(
      `SELECT id, job_type, status, orders_synced, started_at, completed_at
       FROM integration_sync_jobs WHERE integration_id = $1
       ORDER BY created_at DESC LIMIT 10`,
      [integrationId],
      { allowNoTenant: true }
    );

    const row = integration.rows[0];
    const allJobs = jobs.rows as SyncJobSummary[];
    const currentJob = allJobs.find(j => j.status === 'running' || j.status === 'queued');
    const recentJobs = allJobs.filter(j => j.status !== 'running' && j.status !== 'queued');

    return {
      integrationId,
      status:       row.status,
      lastSyncAt:   row.last_sync_at,
      nextSyncAt:   row.next_sync_at,
      errorMessage: row.error_message,
      currentJob,
      recentJobs,
    };
  }

  // ── Ontkoppelen ───────────────────────────────────────────
  async disconnect(integrationId: string): Promise<void> {
    const { tenantId } = getTenantContext();
    await db.query(
      `UPDATE tenant_integrations SET status = 'disconnected', updated_at = now()
       WHERE id = $1 AND tenant_id = $2`,
      [integrationId, tenantId]
    );
    await cache.del('integration:' + tenantId + ':' + integrationId);
    logger.info('integration.disconnected', { tenantId, integrationId });
  }
}
