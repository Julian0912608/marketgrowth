// ============================================================
// src/modules/integrations/api/integration.routes.ts
//
// REST API endpoints voor platform integraties.
// Alle routes zijn tenant-geïsoleerd via tenantMiddleware.
// ============================================================

import { Router, Request, Response, NextFunction } from 'express';
import { IntegrationService } from '../service/integration.service';
import { tenantMiddleware }   from '../../../shared/middleware/tenant.middleware';
import { PlatformSlug }       from '../types/integration.types';

const router  = Router();
const service = new IntegrationService();

// ── GET /api/integrations ─────────────────────────────────────
// Alle verbonden winkels van de huidige tenant
router.get('/', tenantMiddleware(), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const integrations = await service.listIntegrations();
    res.json({ integrations });
  } catch (err) { next(err); }
});

// ── GET /api/integrations/platforms ──────────────────────────
// Lijst van beschikbare platformen (publiek)
router.get('/platforms', async (_req: Request, res: Response) => {
  res.json({
    platforms: [
      { slug: 'shopify',     name: 'Shopify',     authType: 'oauth2',   requiresShopDomain: true  },
      { slug: 'woocommerce', name: 'WooCommerce', authType: 'api_key',  requiresShopDomain: false },
      { slug: 'lightspeed',  name: 'Lightspeed',  authType: 'oauth2',   requiresShopDomain: true  },
      { slug: 'magento',     name: 'Magento',     authType: 'api_key',  requiresShopDomain: false },
      { slug: 'bigcommerce', name: 'BigCommerce', authType: 'api_key',  requiresShopDomain: false },
      { slug: 'bolcom',      name: 'Bol.com',     authType: 'api_key',  requiresShopDomain: false },
    ],
  });
});

// ── POST /api/integrations/connect ───────────────────────────
// Verbind een nieuw verkoopplatform
// Body: { platformSlug, shopDomain?, apiKey?, apiSecret?, storeUrl? }
router.post('/connect', tenantMiddleware(), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { platformSlug, shopDomain, apiKey, apiSecret, storeUrl } = req.body;

    if (!platformSlug) {
      res.status(400).json({ error: 'platformSlug is verplicht' });
      return;
    }

    const result = await service.connect({
      platformSlug: platformSlug as PlatformSlug,
      shopDomain,
      apiKey,
      apiSecret,
      storeUrl,
    });

    // OAuth2: stuur klant door naar het platform
    if (result.authUrl) {
      res.json({ status: 'pending', authUrl: result.authUrl, integrationId: result.integrationId });
      return;
    }

    res.status(201).json(result);
  } catch (err) { next(err); }
});

// ── GET /api/integrations/callback/:platform ─────────────────
// OAuth2 callback — het platform stuurt de klant hier naartoe
// Na succesvolle OAuth sturen we door naar het dashboard
router.get('/callback/:platform', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { platform } = req.params;
    const { code, state, shop } = req.query as Record<string, string>;

    if (!code || !state) {
      res.status(400).send('Ontbrekende OAuth parameters');
      return;
    }

    const { integrationId, tenantId } = await service.handleOAuthCallback(
      platform as PlatformSlug,
      code,
      state,
      shop   // Shopify geeft shop domain mee in callback
    );

    // Stuur klant door naar dashboard met success melding
    const redirectUrl = `${process.env.FRONTEND_URL}/dashboard?integration=connected&id=${integrationId}`;
    res.redirect(redirectUrl);
  } catch (err) {
    // Bij OAuth fouten: redirect naar error pagina
    const frontendUrl = process.env.FRONTEND_URL ?? '';
    res.redirect(`${frontendUrl}/dashboard?integration=error`);
  }
});

// ── POST /api/integrations/:id/sync ──────────────────────────
// Handmatige sync starten
router.post('/:id/sync', tenantMiddleware(), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const result = await service.triggerSync(req.params.id);
    res.json({ message: 'Synchronisatie gestart', jobId: result.jobId });
  } catch (err) { next(err); }
});

// ── GET /api/integrations/:id/status ─────────────────────────
// Huidige sync status ophalen
router.get('/:id/status', tenantMiddleware(), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const status = await service.getSyncStatus(req.params.id);
    res.json(status);
  } catch (err) { next(err); }
});

// ── DELETE /api/integrations/:id ─────────────────────────────
// Verbinding verbreken
router.delete('/:id', tenantMiddleware(), async (req: Request, res: Response, next: NextFunction) => {
  try {
    await service.disconnect(req.params.id);
    res.json({ message: 'Integratie verbroken. Gegevens worden 30 dagen bewaard.' });
  } catch (err) { next(err); }
});

// ── POST /api/integrations/webhook/:platform ─────────────────
// Inkomende webhooks van platforms (GEEN tenantMiddleware — verificatie via HMAC)
router.post('/webhook/:platform', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { platform } = req.params;

    // Webhook verificatie per platform
    const isValid = await verifyIncomingWebhook(platform as PlatformSlug, req);
    if (!isValid) {
      res.status(401).json({ error: 'Webhook verificatie mislukt' });
      return;
    }

    // Direct 200 terugsturen (platforms verwachten snelle response)
    res.json({ received: true });

    // Async verwerken via queue (niet blokkeren)
    const { webhookQueue } = await import('../workers/sync.worker');
    const integrationId    = req.headers['x-integration-id'] as string;
    const tenantId         = req.headers['x-tenant-id'] as string;
    const topic            = req.headers['x-shopify-topic'] as string
                          ?? req.headers['x-wc-webhook-topic'] as string
                          ?? 'unknown';

    if (integrationId && tenantId) {
      await webhookQueue.add('webhook', {
        integrationId,
        tenantId,
        platformSlug: platform as PlatformSlug,
        topic,
        body: req.body,
      });
    }
  } catch (err) { next(err); }
});

// ── Webhook verificatie helper ────────────────────────────────
async function verifyIncomingWebhook(
  platform: PlatformSlug,
  req: Request
): Promise<boolean> {
  // In productie: haal het secret op uit de database op basis van integration ID
  // Voor nu: altijd true (implementeer per platform bij go-live)
  const integrationId = req.headers['x-integration-id'] as string;
  if (!integrationId) return false;

  // Hier zou je het secret ophalen en HMAC verificatie uitvoeren:
  // const { db } = await import('../../../infrastructure/database/connection');
  // const row = await db.query(...)
  // const connector = getConnector(platform);
  // return connector.verifyWebhook(rawBody, signature, row.secret);

  return true;  // TODO: implementeer per platform bij go-live
}

export { router as integrationRouter };
