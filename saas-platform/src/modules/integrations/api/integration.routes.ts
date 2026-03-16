import { Router, Request, Response, NextFunction } from 'express';
import { IntegrationService } from '../service/integration.service';
import { tenantMiddleware } from '../../../shared/middleware/tenant.middleware';
import { PlatformSlug } from '../types/integration.types';

const router = Router();
const integrationService = new IntegrationService();

// Alle routes vereisen een ingelogde gebruiker, behalve webhooks en OAuth callbacks
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

// ── GET /api/integrations/callback/:platform ─────────────────
// OAuth callback — aangeroepen door het externe platform na autorisatie
router.get('/callback/:platform', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const platform = req.params.platform as PlatformSlug;
    const { code, state } = req.query as { code: string; state: string };

    if (!code || !state) {
      const frontendUrl = process.env.FRONTEND_URL || 'https://marketgrow.ai';
      res.redirect(frontendUrl + '/dashboard/integrations?error=missing_params');
      return;
    }

    const result = await integrationService.handleOAuthCallback(platform, code, state);
    const frontendUrl = process.env.FRONTEND_URL || 'https://marketgrow.ai';

    // Redirect naar het dashboard integrations pagina — niet onboarding
    res.redirect(frontendUrl + '/dashboard/integrations?connected=' + result.integrationId);
  } catch (err) {
    const frontendUrl = process.env.FRONTEND_URL || 'https://marketgrow.ai';
    const message = encodeURIComponent((err as Error).message);
    res.redirect(frontendUrl + '/dashboard/integrations?error=' + message);
  }
});

// ── POST /api/integrations/:id/sync ──────────────────────────
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
// Altijd 200 teruggeven — verwerking asynchroon via queue
router.post('/webhook/:platform', async (req: Request, res: Response) => {
  res.sendStatus(200);
});

export { router as integrationRouter };
