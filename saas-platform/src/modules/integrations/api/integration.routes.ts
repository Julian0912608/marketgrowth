import { Router, Request, Response, NextFunction } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { IntegrationService }         from '../service/integration.service';
import { tenantMiddleware }           from '../../../shared/middleware/tenant.middleware';
import { getTenantContext }           from '../../../shared/middleware/tenant-context';
import { db }                         from '../../../infrastructure/database/connection';
import { PlatformSlug }               from '../types/integration.types';
import { bolcomAdvertisingConnector } from '../connectors/bolcom-advertising.connector';

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

// ── GET /api/integrations/callback/:platform ─────────────────
router.get('/callback/:platform', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const platform = req.params.platform as PlatformSlug;
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

// ── POST /api/integrations/advertising/bolcom/connect ─────────
// Koppel Bol.com Advertising API — let op: VOOR de /:id routes!
router.post('/advertising/bolcom/connect', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { tenantId } = getTenantContext();
    const { clientId, clientSecret } = req.body;

    if (!clientId || !clientSecret) {
      res.status(400).json({ error: 'Client ID en Client Secret zijn verplicht' });
      return;
    }

    // Test verbinding
    const test = await bolcomAdvertisingConnector.testConnection(clientId, clientSecret);
    if (!test.success) {
      res.status(400).json({ error: 'Verbinding mislukt: ' + test.error });
      return;
    }

    // Sla op als aparte integratie
    const integrationId = uuidv4();

    await db.query(
      `INSERT INTO tenant_integrations
         (id, tenant_id, platform_slug, shop_domain, shop_name, status, created_at, updated_at)
       VALUES ($1, $2, 'bolcom_ads', NULL, 'Bol.com Advertising', 'active', now(), now())
       ON CONFLICT (tenant_id, platform_slug, shop_domain)
       DO UPDATE SET status = 'active', updated_at = now()`,
      [integrationId, tenantId],
      { allowNoTenant: true }
    );

    // Haal het werkelijke id op (bij ON CONFLICT is het het bestaande)
    const existing = await db.query(
      `SELECT id FROM tenant_integrations WHERE tenant_id = $1 AND platform_slug = 'bolcom_ads' LIMIT 1`,
      [tenantId],
      { allowNoTenant: true }
    );
    const actualId = existing.rows[0]?.id || integrationId;

    // Sla credentials op
    await db.query(
      `INSERT INTO integration_credentials (integration_id, api_key, api_secret, updated_at)
       VALUES ($1, $2, $3, now())
       ON CONFLICT (integration_id)
       DO UPDATE SET api_key = EXCLUDED.api_key, api_secret = EXCLUDED.api_secret, updated_at = now()`,
      [actualId, clientId, clientSecret],
      { allowNoTenant: true }
    );

    // Start initiële sync
    const campaigns = await bolcomAdvertisingConnector.syncAdvertisingData(
      tenantId, actualId, clientId, clientSecret
    );

    res.json({
      success:       true,
      integrationId: actualId,
      campaigns:     campaigns.length,
      message:       'Bol.com Advertising gekoppeld en ' + campaigns.length + ' campagnes gesynchroniseerd',
    });
  } catch (err) { next(err); }
});

// ── POST /api/integrations/advertising/bolcom/sync ────────────
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

    const campaigns = await bolcomAdvertisingConnector.syncAdvertisingData(
      tenantId, integrationId, clientId, clientSecret
    );

    res.json({
      success:    true,
      campaigns:  campaigns.length,
      totalSpend: campaigns.reduce((s, c) => s + c.spend, 0),
    });
  } catch (err) { next(err); }
});

// ── POST /api/integrations/:id/sync ──────────────────────────
// Let op: ALTIJD NA de specifieke /advertising/* routes!
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
router.post('/webhook/:platform', async (req: Request, res: Response) => {
  res.sendStatus(200);
});

export { router as integrationRouter };
