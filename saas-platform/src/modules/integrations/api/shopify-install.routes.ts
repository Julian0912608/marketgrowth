// ============================================================
// saas-platform/src/modules/integrations/api/shopify-install.routes.ts
//
// Shopify App Store install endpoints. Gemount op
// /api/shopify in src/index.ts.
//
// Geen globale tenantMiddleware: /install en /install/callback
// komen vóór de MarketGrow login. Alleen /install/finalize zit
// achter tenantMiddleware (lokaal toegepast).
//
// Routes:
//   GET  /install              entry point voor Shopify App Store
//   GET  /install/callback     OAuth code -> handoff token
//   GET  /install/preview      shop info ophalen (geen consume)
//   POST /install/finalize     handoff -> tenant_integrations row
// ============================================================

import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { shopifyInstallService } from '../service/shopify-install.service';
import { tenantMiddleware }      from '../../../shared/middleware/tenant.middleware';
import { getTenantContext }      from '../../../shared/middleware/tenant-context';
import { logger }                from '../../../shared/logging/logger';

const router = Router();

// ─────────────────────────────────────────────────────────────
// GET /install
// Entry point voor Shopify App Store / install link. Eis:
// onmiddellijke 302 naar OAuth, geen HTML, geen tussenstap.
// ─────────────────────────────────────────────────────────────
router.get('/install', async (req: Request, res: Response) => {
  try {
    const query: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.query)) {
      if (typeof v === 'string') query[k] = v;
    }

    const { authUrl } = await shopifyInstallService.startInstall(query);

    res.setHeader('Cache-Control', 'no-store');
    res.redirect(302, authUrl);
  } catch (err: any) {
    const status = err.httpStatus ?? 500;
    logger.warn('shopify.install.start_failed', {
      message: err.message,
      status,
    });
    res.status(status).type('text/plain').send(
      'Shopify install error: ' + (err.message || 'unknown')
    );
  }
});

// ─────────────────────────────────────────────────────────────
// GET /install/callback
// OAuth redirect target. Wisselt code in voor offline token,
// detecteert re-install vs nieuwe install, redirect daarna naar
// frontend.
// ─────────────────────────────────────────────────────────────
router.get('/install/callback', async (req: Request, res: Response) => {
  try {
    const query: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.query)) {
      if (typeof v === 'string') query[k] = v;
    }

    const { redirectTo } = await shopifyInstallService.handleCallback(query);

    res.setHeader('Cache-Control', 'no-store');
    res.redirect(302, redirectTo);
  } catch (err: any) {
    const status = err.httpStatus ?? 500;
    logger.warn('shopify.install.callback_failed', {
      message: err.message,
      status,
    });
    res.status(status).type('text/plain').send(
      'Shopify install callback error: ' + (err.message || 'unknown')
    );
  }
});

// ─────────────────────────────────────────────────────────────
// GET /install/preview?handoff=...
// Niet-consumerende lookup voor de frontend connect page.
// ─────────────────────────────────────────────────────────────

const PreviewSchema = z.object({
  handoff: z.string().min(64).max(128),
});

router.get('/install/preview', async (req: Request, res: Response) => {
  try {
    const parsed = PreviewSchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid handoff parameter' });
      return;
    }
    const data = await shopifyInstallService.previewHandoff(parsed.data.handoff);
    res.json(data);
  } catch (err: any) {
    const status = err.httpStatus ?? 500;
    res.status(status).json({ error: err.message || 'Internal error' });
  }
});

// ─────────────────────────────────────────────────────────────
// POST /install/finalize
// Ingelogde user koppelt de Shopify shop aan zijn tenant.
// ─────────────────────────────────────────────────────────────

const FinalizeSchema = z.object({
  handoff: z.string().min(64).max(128),
});

router.post(
  '/install/finalize',
  tenantMiddleware(),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = FinalizeSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'Invalid handoff parameter' });
        return;
      }
      const { tenantId } = getTenantContext();
      const result = await shopifyInstallService.finalize(
        tenantId,
        parsed.data.handoff
      );
      res.json({ success: true, ...result });
    } catch (err: any) {
      const status = err.httpStatus ?? 500;
      res.status(status).json({ error: err.message || 'Internal error' });
    }
  }
);

export { router as shopifyInstallRouter };
