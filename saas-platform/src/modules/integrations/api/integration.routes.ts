// ============================================================
// src/modules/integrations/api/integration.routes.ts
// ============================================================

import { Router, Request, Response, NextFunction } from 'express';
import { IntegrationService } from '../service/integration.service';
import { tenantMiddleware }   from '../../../shared/middleware/tenant.middleware';
import { PlatformSlug }       from '../types/integration.types';

const router           = Router();
const integrationService = new IntegrationService();

// Alle routes vereisen een ingelogde gebruiker, behalve webhooks en OAuth callbacks
router.use((req, res, next) => {
  // Webhooks en OAuth callbacks slaan auth over
  if (req.path.startsWith('/webhook') || req.path.startsWith('/callback')) {
    return next();
  }
  return tenantMiddleware()(req, res, next);
});

// ── GET /api/integrations/platforms ──────────────────────────
// Lijst van beschikbare platforms
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
// Lijst van gekoppelde integraties van de tenant
router.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const integrations = await integrationService.listIntegrations();
    res.json(integrations);
  } catch (err) { next(err); }
});

// ── POST /api/integrations/connect ───────────────────────────
// Start een nieuwe koppeling (OAuth redirect of API key)
router.post('/connect', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const result = await integrationService.connect(req.body);

    // OAuth platforms: redirect de klant naar het platform
    if (result.authUrl) {
      res.json({ status: 'oauth_required', authUrl: result.authUrl });
      return;
    }

    res.status(201).json(result);
  } catch (err) { next(err); }
});

// ── GET /api/integrations/callback/:platform ─────────────────
// OAuth callback — wordt aangeroepen door het externe platform
router.get('/callback/:platform', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const platform = req.params.platform as PlatformSlug;
    const { code, state } = req.query as { code: string; state: string };

    if (!code || !state) {
      res.status(400).json({ error: 'Missende code of state parameter' });
      return;
    }

    const result = await integrationService.handleOAuthCallback(platform, code, state);
    const frontendUrl = process.env.FRONTEND_URL ?? 'https://app.marketgrowth.io';

    // Redirect terug naar de frontend met succes
    res.redirect(`${frontendUrl}/onboarding?step=connected&integrationId=${result.integrationId}`);
  } catch (err) {
    const frontendUrl = process.env.FRONTEND_URL ?? 'https://app.marketgrowth.io';
    res.redirect(`${frontendUrl}/onboarding?step=error&message=${encodeURIComponent((err as Error).message)}`);
  }
});

// ── POST /api/integrations/:id/sync ──────────────────────────
// Trigger een handmatige sync
router.post('/:id/sync', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { jobType = 'incremental' } = req.body as { jobType?: 'full_sync' | 'incremental' };
    const result = await integrationService.triggerSync(req.params.id, jobType);
    res.json({ syncJobId: result.syncJobId });
  } catch (err) { next(err); }
});

// ── GET /api/integrations/:id/status ─────────────────────────
// Sync status opvragen
router.get('/:id/status', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const status = await integrationService.getSyncStatus(req.params.id);
    res.json(status);
  } catch (err) { next(err); }
});

// ── DELETE /api/integrations/:id ─────────────────────────────
// Integratie ontkoppelen
router.delete('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    await integrationService.disconnect(req.params.id);
    res.json({ success: true });
  } catch (err) { next(err); }
});

// ── POST /api/integrations/webhook/:platform ─────────────────
// Webhook endpoint voor inkomende platform events
router.post('/webhook/:platform', async (req: Request, res: Response) => {
  // Altijd 200 teruggeven zodat het platform weet dat we de webhook ontvangen hebben
  // Verwerking gebeurt asynchroon via de queue
  res.sendStatus(200);
});

export { router as integrationRouter };
