// saas-platform/src/modules/integrations/api/integration.routes.ts
//
// SECURITY UPDATE: Zod validatie op alle POST endpoints

import { Router, Request, Response, NextFunction } from 'express';
import { z }                                        from 'zod';
import { v4 as uuidv4 }                            from 'uuid';
import { IntegrationService }                       from '../service/integration.service';
import { tenantMiddleware }                         from '../../../shared/middleware/tenant.middleware';
import { getTenantContext }                         from '../../../shared/middleware/tenant-context';
import { db }                                       from '../../../infrastructure/database/connection';
import { PlatformSlug, IntegrationCredentials }     from '../types/integration.types';
import { syncBolcomAdvertisingData }                from '../connectors/bolcom-advertising.connector';
import { encryptToken, decryptToken }               from '../../../shared/crypto/token-encryption';

const router             = Router();
const integrationService = new IntegrationService();

// ── Zod schemas ───────────────────────────────────────────────

const PLATFORM_SLUGS = [
  'shopify','woocommerce','lightspeed','bigcommerce',
  'bolcom','magento','amazon','etsy',
] as const;

const ConnectSchema = z.object({
  platformSlug: z.enum(PLATFORM_SLUGS),
  shopDomain:   z.string().max(253).optional(),
  apiKey:       z.string().max(500).optional(),
  apiSecret:    z.string().max(500).optional(),
  storeUrl:     z.string().url().max(500).optional(),
});

const ShopifyInstallSchema = z.object({
  shopDomain: z.string().min(1).max(253),
});

const BolcomConnectSchema = z.object({
  clientId:     z.string().min(1).max(200),
  clientSecret: z.string().min(1).max(200),
});

const SyncSchema = z.object({
  jobType: z.enum(['full_sync', 'incremental']).optional().default('incremental'),
});

// ── Validate helper ───────────────────────────────────────────
function validate<T>(schema: z.ZodSchema<T>, data: unknown): T {
  const result = schema.safeParse(data);
  if (!result.success) {
    const messages = result.error.errors.map(e => `${e.path.join('.')}: ${e.message}`).join(', ');
    throw Object.assign(new Error(messages), { httpStatus: 400 });
  }
  return result.data;
}

// ── UUID param guard ──────────────────────────────────────────
function validateUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

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
    const input  = validate(ConnectSchema, req.body);
    const result = await integrationService.connect(input);
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
    const { shopDomain } = validate(ShopifyInstallSchema, req.body);
    const result = await integrationService.connect({ platformSlug: 'shopify', shopDomain });
    res.json({ installUrl: result.authUrl, status: result.status });
  } catch (err) { next(err); }
});

// ── GET /api/integrations/callback/:platform ─────────────────
router.get('/callback/:platform', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const platform        = req.params.platform as PlatformSlug;
    const { code, state } = req.query as { code: string; state: string };

    if (!code || !state) {
      res.status(400).json({ error: 'Missende code of state parameter' });
      return;
    }
    if (typeof code !== 'string' || code.length > 512) {
      res.status(400).json({ error: 'Ongeldige code parameter' });
      return;
    }
    if (typeof state !== 'string' || state.length > 128) {
      res.status(400).json({ error: 'Ongeldige state parameter' });
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
    const { tenantId }               = getTenantContext();
    const { clientId, clientSecret } = validate(BolcomConnectSchema, req.body);

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

    const existing = await db.query(
      `SELECT id FROM tenant_integrations WHERE tenant_id = $1 AND platform_slug = 'bolcom_ads' LIMIT 1`,
      [tenantId],
      { allowNoTenant: true }
    );
    const actualId = existing.rows[0]?.id || integrationId;

    await db.query(
      `INSERT INTO integration_credentials (integration_id, api_key, api_secret, updated_at, encrypted_at)
       VALUES ($1, $2, $3, now(), now())
       ON CONFLICT (integration_id)
       DO UPDATE SET
         api_key      = EXCLUDED.api_key,
         api_secret   = EXCLUDED.api_secret,
         updated_at   = now(),
         encrypted_at = now()`,
      [actualId, encryptToken(clientId), encryptToken(clientSecret)],
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

    const { id: integrationId, api_key: storedApiKey, api_secret: storedApiSecret } = result.rows[0];

    const clientId     = decryptToken(storedApiKey)    ?? '';
    const clientSecret = decryptToken(storedApiSecret) ?? '';

    if (!clientId || !clientSecret) {
      res.status(500).json({ error: 'Credentials konden niet worden opgehaald' });
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
       FROM ad_campaigns
       WHERE tenant_id = $1 AND integration_id = $2`,
      [tenantId, integrationId],
      { allowNoTenant: true }
    );

    const stats = statsResult.rows[0];

    res.json({
      success:    true,
      campaigns:  stats.campaigns   ?? 0,
      totalSpend: stats.total_spend ?? 0,
    });
  } catch (err) { next(err); }
});

// ── POST /api/integrations/:id/sync ──────────────────────────
router.post('/:id/sync', async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!validateUuid(req.params.id)) {
      res.status(400).json({ error: 'Ongeldig integration ID' });
      return;
    }
    const { jobType } = validate(SyncSchema, req.body);
    const result = await integrationService.triggerSync(req.params.id, jobType);
    res.json(result);
  } catch (err) { next(err); }
});

// ── GET /api/integrations/:id/sync-status ────────────────────
router.get('/:id/sync-status', async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!validateUuid(req.params.id)) {
      res.status(400).json({ error: 'Ongeldig integration ID' });
      return;
    }
    const status = await integrationService.getSyncStatus(req.params.id);
    res.json(status);
  } catch (err) { next(err); }
});

// ── DELETE /api/integrations/:id ─────────────────────────────
router.delete('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!validateUuid(req.params.id)) {
      res.status(400).json({ error: 'Ongeldig integration ID' });
      return;
    }
    await integrationService.disconnect(req.params.id);
    res.json({ success: true });
  } catch (err) { next(err); }
});

// ── POST /api/integrations/webhook/:platform ─────────────────
router.post('/webhook/:platform', async (_req: Request, res: Response) => {
  res.sendStatus(200);
});

export { router as integrationRouter };
