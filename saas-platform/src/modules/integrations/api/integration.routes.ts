// ============================================================
// src/modules/integrations/api/integration.routes.ts
// ============================================================

import { Router, Request, Response, NextFunction } from 'express';
import { v4 as uuidv4 }                            from 'uuid';
import { IntegrationService }                       from '../service/integration.service';
import { tenantMiddleware }                         from '../../../shared/middleware/tenant.middleware';
import { getTenantContext }                         from '../../../shared/middleware/tenant-context';
import { db }                                       from '../../../infrastructure/database/connection';
import { logger }                                   from '../../../shared/logging/logger';
import { PlatformSlug, IntegrationCredentials }     from '../types/integration.types';
import { syncBolcomAdvertisingData }                from '../connectors/bolcom-advertising.connector';
import {
  buildGoogleAuthUrl,
  exchangeGoogleCode,
  refreshGoogleToken,
  syncGoogleAdsData,
} from '../connectors/google-ads.connector';

const router             = Router();
const integrationService = new IntegrationService();

// Webhooks en OAuth callbacks slaan auth over
router.use((req, res, next) => {
  if (req.path.startsWith('/webhook') || req.path.startsWith('/callback')) {
    return next();
  }
  return tenantMiddleware()(req, res, next);
});

// ── GET /api/integrations/platforms ──────────────────────────
router.get('/platforms', (_req: Request, res: Response) => {
  res.json([
    { slug: 'shopify',     name: 'Shopify',     authType: 'oauth',  logo: '/logos/shopify.svg' },
    { slug: 'woocommerce', name: 'WooCommerce', authType: 'apikey', logo: '/logos/woocommerce.svg' },
    { slug: 'lightspeed',  name: 'Lightspeed',  authType: 'apikey', logo: '/logos/lightspeed.svg' },
    { slug: 'bigcommerce', name: 'BigCommerce', authType: 'apikey', logo: '/logos/bigcommerce.svg' },
    { slug: 'bolcom',      name: 'Bol.com',     authType: 'apikey', logo: '/logos/bolcom.svg' },
    { slug: 'magento',     name: 'Magento',     authType: 'apikey', logo: '/logos/magento.svg' },
    { slug: 'amazon',      name: 'Amazon',      authType: 'oauth',  logo: '/logos/amazon.svg' },
    { slug: 'etsy',        name: 'Etsy',        authType: 'oauth',  logo: '/logos/etsy.svg' },
    { slug: 'google_ads',  name: 'Google Ads',  authType: 'oauth',  logo: '/logos/google-ads.svg' },
  ]);
});

// ── GET /api/integrations ─────────────────────────────────────
router.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const integrations = await integrationService.listIntegrations();
    res.json(integrations);
  } catch (err) { next(err); }
});

// ── POST /api/integrations/connect ───────────────────────────
router.post('/connect', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const result = await integrationService.connect(req.body);
    if (result.authUrl) {
      res.json({ status: 'oauth_required', authUrl: result.authUrl });
      return;
    }
    res.status(201).json(result);
  } catch (err) { next(err); }
});

// ── POST /api/integrations/shopify/install ───────────────────
router.post('/shopify/install', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { shopDomain } = req.body;
    if (!shopDomain) {
      res.status(400).json({ error: 'shopDomain is verplicht' });
      return;
    }
    const result = await integrationService.connect({
      platformSlug: 'shopify',
      shopDomain,
    });
    res.json({ installUrl: result.authUrl, status: result.status });
  } catch (err) { next(err); }
});

// ── GET /api/integrations/callback/google-ads ────────────────
// LET OP: staat VOOR /callback/:platform — anders vangt Express google-ads als :platform
router.get('/callback/google-ads', async (req: Request, res: Response) => {
  const { code, state, error } = req.query as { code?: string; state?: string; error?: string };
  const frontendUrl = process.env.FRONTEND_URL || 'https://marketgrow.ai';

  logger.info('google.ads.callback.received', { hasCode: !!code, hasState: !!state, error });

  if (error || !code || !state) {
    return res.redirect(`${frontendUrl}/dashboard/integrations?error=google_auth_failed`);
  }

  try {
    const { tenantId } = JSON.parse(Buffer.from(state, 'base64').toString());

    logger.info('google.ads.callback.processing', { tenantId });

    const { accessToken, refreshToken, expiresAt } = await exchangeGoogleCode(code);

    const integrationId = uuidv4();
    await db.query(
      `INSERT INTO tenant_integrations
         (id, tenant_id, platform_slug, shop_domain, shop_name, status, created_at, updated_at)
       VALUES ($1, $2, 'google_ads', NULL, 'Google Ads', 'active', now(), now())
       ON CONFLICT (tenant_id, platform_slug, shop_domain)
       DO UPDATE SET status = 'active', shop_name = 'Google Ads', updated_at = now()`,
      [integrationId, tenantId],
      { allowNoTenant: true }
    );

    const existing = await db.query(
      `SELECT id FROM tenant_integrations WHERE tenant_id = $1 AND platform_slug = 'google_ads' LIMIT 1`,
      [tenantId],
      { allowNoTenant: true }
    );
    const actualId = existing.rows[0]?.id || integrationId;

    await db.query(
      `INSERT INTO integration_credentials
         (integration_id, access_token, refresh_token, token_expires_at, updated_at)
       VALUES ($1, $2, $3, $4, now())
       ON CONFLICT (integration_id)
       DO UPDATE SET
         access_token     = EXCLUDED.access_token,
         refresh_token    = EXCLUDED.refresh_token,
         token_expires_at = EXCLUDED.token_expires_at,
         updated_at       = now()`,
      [actualId, accessToken, refreshToken, expiresAt],
      { allowNoTenant: true }
    );

    logger.info('google.ads.callback.saved', { tenantId, integrationId: actualId });

    // Start sync op achtergrond
    syncGoogleAdsData(tenantId, actualId, accessToken).catch(err =>
      logger.error('google.ads.initial_sync.failed', { tenantId, error: (err as Error).message })
    );

    res.redirect(`${frontendUrl}/dashboard/integrations?connected=${actualId}`);
  } catch (err: any) {
    logger.error('google.ads.callback.error', { error: err.message });
    res.redirect(`${frontendUrl}/dashboard/integrations?error=${encodeURIComponent(err.message)}`);
  }
});

// ── GET /api/integrations/callback/:platform ─────────────────
// LET OP: staat NA /callback/google-ads
router.get('/callback/:platform', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const platform        = req.params.platform as PlatformSlug;
    const { code, state } = req.query as { code: string; state: string };

    if (!code || !state) {
      res.status(400).json({ error: 'Missende code of state parameter' });
      return;
    }

    const result      = await integrationService.handleOAuthCallback(platform, code, state);
    const frontendUrl = process.env.FRONTEND_URL || 'https://marketgrow.ai';
    res.redirect(frontendUrl + '/dashboard/integrations?connected=' + result.integrationId);
  } catch (err) {
    const frontendUrl = process.env.FRONTEND_URL || 'https://marketgrow.ai';
    res.redirect(frontendUrl + '/dashboard/integrations?error=' + encodeURIComponent((err as Error).message));
  }
});

// ── POST /api/integrations/advertising/bolcom/connect ────────
router.post('/advertising/bolcom/connect', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { tenantId } = getTenantContext();
    const { clientId, clientSecret } = req.body as { clientId: string; clientSecret: string };

    if (!clientId || !clientSecret) {
      res.status(400).json({ error: 'Client ID en Client Secret zijn verplicht' });
      return;
    }

    const encoded  = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
    const tokenRes = await fetch('https://login.bol.com/token?grant_type=client_credentials', {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${encoded}`,
        'Content-Type':  'application/x-www-form-urlencoded',
      },
    });

    if (!tokenRes.ok) {
      res.status(400).json({ error: 'Bol.com Advertising verbinding mislukt — controleer Client ID en Secret' });
      return;
    }

    const { access_token } = await tokenRes.json() as { access_token: string };
    const integrationId    = uuidv4();

    await db.query(
      `INSERT INTO tenant_integrations
         (id, tenant_id, platform_slug, shop_domain, shop_name, status, created_at, updated_at)
       VALUES ($1, $2, 'bolcom_ads', NULL, 'Bol.com Advertising', 'active', now(), now())
       ON CONFLICT (tenant_id, platform_slug, shop_domain)
       DO UPDATE SET status = 'active', updated_at = now()`,
      [integrationId, tenantId],
      { allowNoTenant: true }
    );

    const existing = await db.query(
      `SELECT id FROM tenant_integrations WHERE tenant_id = $1 AND platform_slug = 'bolcom_ads' LIMIT 1`,
      [tenantId],
      { allowNoTenant: true }
    );
    const actualId = existing.rows[0]?.id || integrationId;

    await db.query(
      `INSERT INTO integration_credentials (integration_id, api_key, api_secret, updated_at)
       VALUES ($1, $2, $3, now())
       ON CONFLICT (integration_id)
       DO UPDATE SET api_key = EXCLUDED.api_key, api_secret = EXCLUDED.api_secret, updated_at = now()`,
      [actualId, clientId, clientSecret],
      { allowNoTenant: true }
    );

    const creds: IntegrationCredentials = {
      integrationId: actualId,
      platform:      'bolcom',
      apiKey:        clientId,
      apiSecret:     clientSecret,
    };

    await syncBolcomAdvertisingData(creds, tenantId, access_token);

    res.json({
      success:       true,
      integrationId: actualId,
      message:       'Bol.com Advertising gekoppeld en campagnes gesynchroniseerd',
    });
  } catch (err) { next(err); }
});

// ── POST /api/integrations/advertising/bolcom/sync ───────────
router.post('/advertising/bolcom/sync', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { tenantId } = getTenantContext();

    const result = await db.query(
      `SELECT ti.id, ic.api_key, ic.api_secret
       FROM tenant_integrations ti
       JOIN integration_credentials ic ON ic.integration_id = ti.id
       WHERE ti.tenant_id = $1 AND ti.platform_slug = 'bolcom_ads' AND ti.status = 'active'
       LIMIT 1`,
      [tenantId],
      { allowNoTenant: true }
    );

    if (!result.rows[0]) {
      res.status(404).json({ error: 'Geen Bol.com Advertising koppeling gevonden' });
      return;
    }

    const { id: integrationId, api_key: clientId, api_secret: clientSecret } = result.rows[0];

    const encoded  = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
    const tokenRes = await fetch('https://login.bol.com/token?grant_type=client_credentials', {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${encoded}`,
        'Content-Type':  'application/x-www-form-urlencoded',
      },
    });

    if (!tokenRes.ok) {
      res.status(502).json({ error: 'Bol.com token ophalen mislukt' });
      return;
    }

    const { access_token } = await tokenRes.json() as { access_token: string };

    const creds: IntegrationCredentials = {
      integrationId,
      platform:  'bolcom',
      apiKey:    clientId,
      apiSecret: clientSecret,
    };

    await syncBolcomAdvertisingData(creds, tenantId, access_token);

    const statsResult = await db.query(
      `SELECT COUNT(*)::int AS campaigns, COALESCE(SUM(spend), 0) AS total_spend
       FROM ad_campaigns WHERE tenant_id = $1 AND integration_id = $2`,
      [tenantId, integrationId],
      { allowNoTenant: true }
    );

    const stats = statsResult.rows[0];
    res.json({ success: true, campaigns: stats.campaigns ?? 0, totalSpend: stats.total_spend ?? 0 });
  } catch (err) { next(err); }
});

// ── GET /api/integrations/advertising/google/connect ─────────
router.get('/advertising/google/connect', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { tenantId } = getTenantContext();
    const state   = Buffer.from(JSON.stringify({ tenantId })).toString('base64');
    const authUrl = buildGoogleAuthUrl(state);
    res.json({ authUrl });
  } catch (err) { next(err); }
});

// ── POST /api/integrations/advertising/google/sync ───────────
router.post('/advertising/google/sync', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { tenantId } = getTenantContext();

    const result = await db.query(
      `SELECT ti.id, ic.access_token, ic.refresh_token, ic.token_expires_at
       FROM tenant_integrations ti
       JOIN integration_credentials ic ON ic.integration_id = ti.id
       WHERE ti.tenant_id = $1 AND ti.platform_slug = 'google_ads' AND ti.status = 'active'
       LIMIT 1`,
      [tenantId],
      { allowNoTenant: true }
    );

    if (!result.rows[0]) {
      res.status(404).json({ error: 'Geen Google Ads koppeling gevonden' });
      return;
    }

    let { id: integrationId, access_token: accessToken, refresh_token: refreshToken, token_expires_at: tokenExpiresAt } = result.rows[0];

    if (tokenExpiresAt && new Date(tokenExpiresAt) < new Date()) {
      const refreshed = await refreshGoogleToken(refreshToken);
      accessToken = refreshed.accessToken;
      await db.query(
        `UPDATE integration_credentials
         SET access_token = $1, token_expires_at = $2, updated_at = now()
         WHERE integration_id = $3`,
        [refreshed.accessToken, refreshed.expiresAt, integrationId],
        { allowNoTenant: true }
      );
    }

    const syncResult = await syncGoogleAdsData(tenantId, integrationId, accessToken);
    res.json({ success: true, campaignCount: syncResult.campaignCount });
  } catch (err) { next(err); }
});

// ── POST /api/integrations/:id/sync ──────────────────────────
// LET OP: altijd NA de /advertising/* routes
router.post('/:id/sync', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { jobType = 'incremental' } = req.body as { jobType?: 'full_sync' | 'incremental' };
    const result = await integrationService.triggerSync(req.params.id, jobType);
    res.json({ syncJobId: result.syncJobId });
  } catch (err) { next(err); }
});

// ── GET /api/integrations/:id/status ─────────────────────────
router.get('/:id/status', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const status = await integrationService.getSyncStatus(req.params.id);
    res.json(status);
  } catch (err) { next(err); }
});

// ── DELETE /api/integrations/:id ─────────────────────────────
router.delete('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    await integrationService.disconnect(req.params.id);
    res.json({ success: true });
  } catch (err) { next(err); }
});

// ── POST /api/integrations/webhook/:platform ─────────────────
router.post('/webhook/:platform', async (_req: Request, res: Response) => {
  res.sendStatus(200);
});

export { router as integrationRouter };
