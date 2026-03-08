// ============================================================
// src/modules/integrations/service/integration.service.ts
//
// Business logic voor het aanmaken, beheren en synchroniseren
// van platform integraties per tenant.
// ============================================================

import crypto from 'crypto';
import { db }           from '../../../infrastructure/database/connection';
import { cache }        from '../../../infrastructure/cache/redis';
import { eventBus }     from '../../../shared/events/event-bus';
import { logger }       from '../../../shared/logging/logger';
import { permissionService } from '../../../shared/permissions/permission.service';
import { getTenantContext }  from '../../../shared/middleware/tenant-context';
import { getConnector }      from '../connectors/connector.factory';
import { syncQueue }         from '../workers/sync.worker';
import {
  PlatformSlug,
  IntegrationCredentials,
  ConnectIntegrationRequest,
  ConnectIntegrationResponse,
  IntegrationSummary,
  SyncStatusResponse,
} from '../types/integration.types';

export class IntegrationService {

  // ── Integratie aanmaken / verbinden ───────────────────────
  async connect(req: ConnectIntegrationRequest): Promise<ConnectIntegrationResponse> {
    const { tenantId, planSlug } = getTenantContext();

    // Multi-shop check: Starter mag maar 1 winkel
    if (planSlug === 'starter') {
      const count = await db.query(
        `SELECT COUNT(*) FROM tenant_integrations WHERE tenant_id = $1 AND status != 'disconnected'`,
        [tenantId]
      );
      if (parseInt(count.rows[0].count) >= 1) {
        throw Object.assign(
          new Error('Starter plan ondersteunt slechts 1 verbonden winkel. Upgrade naar Growth voor meerdere winkels.'),
          { httpStatus: 403, requiredPlan: 'growth' }
        );
      }
    }

    if (planSlug === 'growth') {
      const perm = await permissionService.check({ tenantId, feature: 'multi-shop' });
      const count = await db.query(
        `SELECT COUNT(*) FROM tenant_integrations WHERE tenant_id = $1 AND status != 'disconnected'`,
        [tenantId]
      );
      if (perm.usageRemaining !== undefined && parseInt(count.rows[0].count) >= 3) {
        throw Object.assign(
          new Error('Growth plan ondersteunt maximaal 3 winkels. Upgrade naar Scale voor onbeperkt.'),
          { httpStatus: 403, requiredPlan: 'scale' }
        );
      }
    }

    const platform = await db.query(
      `SELECT * FROM integration_platforms WHERE slug = $1 AND is_active = true`,
      [req.platformSlug]
    );
    if (!platform.rows[0]) {
      throw Object.assign(new Error(`Platform ${req.platformSlug} niet ondersteund`), { httpStatus: 400 });
    }
    const platformId = platform.rows[0].id;

    // OAuth2 flow
    if (platform.rows[0].auth_type === 'oauth2') {
      return this.initiateOAuth(req.platformSlug, platformId, req.shopDomain!, tenantId);
    }

    // API Key flow (WooCommerce, Magento, BigCommerce, Bol.com)
    return this.connectWithApiKey(req, platformId, tenantId);
  }

  // ── OAuth2 starten ────────────────────────────────────────
  private async initiateOAuth(
    platformSlug: PlatformSlug,
    platformId: string,
    shopDomain: string,
    tenantId: string
  ): Promise<ConnectIntegrationResponse> {
    const state   = crypto.randomBytes(16).toString('hex');
    const oauthId = crypto.randomUUID();

    // Tijdelijke integratie aanmaken
    const result = await db.query(
      `INSERT INTO tenant_integrations (tenant_id, platform_id, platform_slug, shop_domain, status)
       VALUES ($1, $2, $3, $4, 'pending')
       ON CONFLICT (tenant_id, shop_domain) DO UPDATE
       SET status = 'pending', updated_at = now()
       RETURNING id`,
      [tenantId, platformId, platformSlug, shopDomain]
    );
    const integrationId = result.rows[0].id;

    // OAuth state opslaan (5 minuten geldig)
    await db.query(
      `INSERT INTO integration_credentials (integration_id, tenant_id, oauth_state)
       VALUES ($1, $2, $3)
       ON CONFLICT (integration_id) DO UPDATE SET oauth_state = $3, updated_at = now()`,
      [integrationId, tenantId, state]
    );

    // Auth URL genereren per platform
    let authUrl: string;
    const redirectUri = `${process.env.APP_URL}/api/integrations/callback/${platformSlug}`;

    switch (platformSlug) {
      case 'shopify': {
        const { ShopifyConnector } = await import('../connectors/shopify.connector');
        authUrl = ShopifyConnector.buildAuthUrl(
          shopDomain,
          process.env.SHOPIFY_CLIENT_ID!,
          redirectUri,
          state
        );
        break;
      }
      case 'lightspeed': {
        authUrl = `https://cloud.lightspeedapp.com/oauth/authorize.php?` +
          new URLSearchParams({
            response_type: 'code',
            client_id:     process.env.LIGHTSPEED_CLIENT_ID!,
            redirect_uri:  redirectUri,
            state,
          });
        break;
      }
      case 'bolcom': {
        authUrl = `https://login.bol.com/authorize?` +
          new URLSearchParams({
            client_id:     process.env.BOLCOM_CLIENT_ID!,
            redirect_uri:  redirectUri,
            response_type: 'code',
            state,
          });
        break;
      }
      default:
        throw new Error(`OAuth niet geconfigureerd voor ${platformSlug}`);
    }

    logger.info('integration.oauth.initiated', { tenantId, platformSlug, integrationId });
    return { integrationId, status: 'pending', authUrl };
  }

  // ── API Key verbinding ────────────────────────────────────
  private async connectWithApiKey(
    req: ConnectIntegrationRequest,
    platformId: string,
    tenantId: string
  ): Promise<ConnectIntegrationResponse> {
    const tempCredentials: IntegrationCredentials = {
      integrationId: '',
      platform: req.platformSlug,
      apiKey:    req.apiKey,
      apiSecret: req.apiSecret,
      storeUrl:  req.storeUrl,
      shopDomain: req.shopDomain,
    };

    const connector  = getConnector(req.platformSlug);
    const testResult = await connector.testConnection(tempCredentials);

    if (!testResult.success) {
      throw Object.assign(
        new Error(`Verbinding mislukt: ${testResult.error}`),
        { httpStatus: 400 }
      );
    }

    // Integratie opslaan
    const shopDomain = req.shopDomain ?? req.storeUrl ?? `${req.platformSlug}-store`;
    const result = await db.query(
      `INSERT INTO tenant_integrations (
         tenant_id, platform_id, platform_slug, shop_domain, shop_name,
         shop_currency, status, is_primary
       ) VALUES ($1, $2, $3, $4, $5, $6, 'active',
         (SELECT COUNT(*) = 0 FROM tenant_integrations WHERE tenant_id = $1 AND status = 'active')
       )
       ON CONFLICT (tenant_id, shop_domain) DO UPDATE
       SET status = 'active', shop_name = EXCLUDED.shop_name, updated_at = now()
       RETURNING id`,
      [
        tenantId, platformId, req.platformSlug, shopDomain,
        testResult.shopName, testResult.shopCurrency ?? 'EUR',
      ]
    );
    const integrationId = result.rows[0].id;

    await db.query(
      `INSERT INTO integration_credentials (
         integration_id, tenant_id, api_key, api_secret, store_url
       ) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (integration_id) DO UPDATE
       SET api_key = $3, api_secret = $4, store_url = $5, updated_at = now()`,
      [integrationId, tenantId, req.apiKey, req.apiSecret, req.storeUrl]
    );

    // Start initial full sync
    await this.enqueueSyncJob(integrationId, tenantId, req.platformSlug, 'full_sync');

    logger.info('integration.connected', { tenantId, platformSlug: req.platformSlug, integrationId });

    return {
      integrationId,
      status:    'active',
      connected: true,
      shopName:  testResult.shopName,
    };
  }

  // ── OAuth2 callback verwerken ─────────────────────────────
  async handleOAuthCallback(
    platformSlug: PlatformSlug,
    code: string,
    state: string,
    shopDomain?: string
  ): Promise<{ integrationId: string; tenantId: string }> {
    // State verificatie
    const credRow = await db.query(
      `SELECT ic.*, ti.tenant_id, ti.id as integration_id, ti.shop_domain
       FROM integration_credentials ic
       JOIN tenant_integrations ti ON ti.id = ic.integration_id
       WHERE ic.oauth_state = $1 AND ti.platform_slug = $2`,
      [state, platformSlug],
      { allowNoTenant: true }
    );

    if (!credRow.rows[0]) {
      throw Object.assign(new Error('Ongeldige OAuth state — mogelijk verlopen'), { httpStatus: 400 });
    }

    const row = credRow.rows[0];
    const tenantId      = row.tenant_id;
    const integrationId = row.integration_id;
    const domain        = shopDomain ?? row.shop_domain;

    // Token uitwisselen
    let accessToken: string;
    let refreshToken: string | undefined;
    let expiresAt: Date | undefined;

    switch (platformSlug) {
      case 'shopify': {
        const { ShopifyConnector } = await import('../connectors/shopify.connector');
        const result = await ShopifyConnector.exchangeCode(
          domain,
          code,
          process.env.SHOPIFY_CLIENT_ID!,
          process.env.SHOPIFY_CLIENT_SECRET!
        );
        accessToken = result.accessToken;
        expiresAt   = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000); // Shopify offline = 1 jaar
        break;
      }
      case 'lightspeed': {
        const res = await fetch('https://cloud.lightspeedapp.com/oauth/access_token.php', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            grant_type:    'authorization_code',
            client_id:     process.env.LIGHTSPEED_CLIENT_ID!,
            client_secret: process.env.LIGHTSPEED_CLIENT_SECRET!,
            code,
          }),
        });
        const d = await res.json();
        accessToken  = d.access_token;
        refreshToken = d.refresh_token;
        expiresAt    = new Date(Date.now() + d.expires_in * 1000);
        break;
      }
      default:
        throw new Error(`OAuth callback niet geconfigureerd voor ${platformSlug}`);
    }

    // Credentials opslaan
    await db.query(
      `UPDATE integration_credentials
       SET access_token = $1, refresh_token = $2, token_expires_at = $3,
           oauth_state = NULL, updated_at = now()
       WHERE integration_id = $4`,
      [accessToken, refreshToken, expiresAt, integrationId],
      { allowNoTenant: true }
    );

    // Winkelinfo ophalen en opslaan
    const credentials: IntegrationCredentials = {
      integrationId,
      platform: platformSlug,
      accessToken,
      shopDomain: domain,
    };
    const connector  = getConnector(platformSlug);
    const shopInfo   = await connector.testConnection(credentials);

    await db.query(
      `UPDATE tenant_integrations
       SET status = 'active', shop_name = $1, shop_currency = $2,
           shop_timezone = $3, shop_country = $4, updated_at = now()
       WHERE id = $5`,
      [
        shopInfo.shopName, shopInfo.shopCurrency ?? 'EUR',
        shopInfo.shopTimezone, shopInfo.shopCountry, integrationId,
      ],
      { allowNoTenant: true }
    );

    // Start full sync
    await this.enqueueSyncJob(integrationId, tenantId, platformSlug, 'full_sync');

    logger.info('integration.oauth.completed', { tenantId, platformSlug, integrationId });
    return { integrationId, tenantId };
  }

  // ── Integraties ophalen ───────────────────────────────────
  async listIntegrations(): Promise<IntegrationSummary[]> {
    const { tenantId } = getTenantContext();

    const rows = await db.query(
      `SELECT ti.*, ip.name as platform_name,
              (SELECT COUNT(*) FROM orders o WHERE o.integration_id = ti.id) as orders_count
       FROM tenant_integrations ti
       JOIN integration_platforms ip ON ip.id = ti.platform_id
       WHERE ti.tenant_id = $1 AND ti.status != 'disconnected'
       ORDER BY ti.is_primary DESC, ti.created_at ASC`,
      [tenantId]
    );

    return rows.rows.map(r => ({
      id:           r.id,
      platformSlug: r.platform_slug,
      platformName: r.platform_name,
      shopDomain:   r.shop_domain,
      shopName:     r.shop_name,
      status:       r.status,
      lastSyncAt:   r.last_sync_at,
      isPrimary:    r.is_primary,
      ordersCount:  parseInt(r.orders_count),
      errorMessage: r.error_message,
    }));
  }

  // ── Handmatige sync starten ───────────────────────────────
  async triggerSync(integrationId: string): Promise<{ jobId: string }> {
    const { tenantId } = getTenantContext();

    // Verifieer dat integratie van deze tenant is
    const row = await db.query(
      `SELECT platform_slug FROM tenant_integrations WHERE id = $1 AND tenant_id = $2`,
      [integrationId, tenantId]
    );
    if (!row.rows[0]) {
      throw Object.assign(new Error('Integratie niet gevonden'), { httpStatus: 404 });
    }

    // Rate limit: max 1 handmatige sync per 15 minuten
    const rateLimitKey = `sync:manual:${integrationId}`;
    const existing = await cache.get(rateLimitKey);
    if (existing) {
      throw Object.assign(
        new Error('Sync al bezig of recentelijk uitgevoerd. Wacht 15 minuten.'),
        { httpStatus: 429 }
      );
    }
    await cache.set(rateLimitKey, '1', 900);

    const jobId = await this.enqueueSyncJob(
      integrationId,
      tenantId,
      row.rows[0].platform_slug,
      'incremental'
    );

    return { jobId };
  }

  // ── Integratie verwijderen ────────────────────────────────
  async disconnect(integrationId: string): Promise<void> {
    const { tenantId } = getTenantContext();

    await db.query(
      `UPDATE tenant_integrations
       SET status = 'disconnected', updated_at = now()
       WHERE id = $1 AND tenant_id = $2`,
      [integrationId, tenantId]
    );

    // Credentials verwijderen
    await db.query(
      `DELETE FROM integration_credentials WHERE integration_id = $1`,
      [integrationId]
    );

    // Cache invalideren
    await cache.invalidateTenant(tenantId);

    logger.info('integration.disconnected', { tenantId, integrationId });
  }

  // ── Sync status ophalen ───────────────────────────────────
  async getSyncStatus(integrationId: string): Promise<SyncStatusResponse> {
    const { tenantId } = getTenantContext();

    const jobRow = await db.query(
      `SELECT * FROM integration_sync_jobs
       WHERE integration_id = $1 AND tenant_id = $2
       ORDER BY created_at DESC LIMIT 1`,
      [integrationId, tenantId]
    );

    const lastCompleted = await db.query(
      `SELECT completed_at, orders_synced FROM integration_sync_jobs
       WHERE integration_id = $1 AND tenant_id = $2 AND status = 'completed'
       ORDER BY completed_at DESC LIMIT 1`,
      [integrationId, tenantId]
    );

    const current = jobRow.rows[0];
    return {
      integrationId,
      currentJob: current && current.status !== 'completed' ? {
        id:           current.id,
        type:         current.job_type,
        status:       current.status,
        orderssynced: current.orders_synced,
        startedAt:    current.started_at,
      } : undefined,
      lastCompletedSync:  lastCompleted.rows[0]?.completed_at,
      totalOrdersSynced:  lastCompleted.rows[0]?.orders_synced,
    };
  }

  // ── Interne helper: job aanmaken ──────────────────────────
  private async enqueueSyncJob(
    integrationId: string,
    tenantId: string,
    platformSlug: string,
    jobType: 'full_sync' | 'incremental'
  ): Promise<string> {
    // Job in database registreren
    const dbResult = await db.query(
      `INSERT INTO integration_sync_jobs (
         integration_id, tenant_id, job_type, status
       ) VALUES ($1, $2, $3, 'queued')
       RETURNING id`,
      [integrationId, tenantId, jobType],
      { allowNoTenant: true }
    );
    const syncJobDbId = dbResult.rows[0].id;

    // Job in BullMQ queue plaatsen
    const job = await syncQueue.add(
      `${platformSlug}:${jobType}`,
      {
        integrationId,
        tenantId,
        platformSlug: platformSlug as PlatformSlug,
        jobType,
        syncJobDbId,
      },
      {
        attempts:     3,
        backoff: {
          type:  'exponential',
          delay: 5000,        // 5s, 25s, 125s
        },
        removeOnComplete: 100,  // Bewaar laatste 100 completed jobs
        removeOnFail:     50,
      }
    );

    // Queue job ID opslaan voor tracking
    await db.query(
      `UPDATE integration_sync_jobs SET queue_job_id = $1 WHERE id = $2`,
      [job.id, syncJobDbId],
      { allowNoTenant: true }
    );

    return job.id ?? syncJobDbId;
  }
}
