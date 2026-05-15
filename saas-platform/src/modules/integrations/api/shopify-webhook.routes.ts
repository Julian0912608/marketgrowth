// ============================================================
// saas-platform/src/modules/integrations/api/shopify-webhook.routes.ts
//
// Shopify GDPR compliance webhooks. Verplicht voor App Store
// approval. Drie topics:
//   - customers/data_request (rapport binnen 30d)
//   - customers/redact       (customer data verwijderen binnen 30d)
//   - shop/redact            (tenant data verwijderen, 48u na uninstall)
//
// Shopify test bij review: stuurt een opzettelijk INVALIDE webhook
// en verwacht HTTP 401. Bij valid HMAC: HTTP 200 binnen 5 sec.
//
// Eis: raw body parser MOET actief zijn op dit pad in src/index.ts
// VOORDAT express.json() draait. Dat staat er al:
//   app.use('/api/integrations/webhook/shopify', express.raw(...))
//
// LET OP: deze router wordt gemount op /api/integrations/webhook
// (niet /api/integrations) zodat de bestaande tenantMiddleware in
// integration.routes.ts geen invloed heeft. Hij overschrijft ook
// de bestaande 501-stub op POST /webhook/:platform.
//
// Echte data deletion wordt asynchroon in een BullMQ worker
// uitgevoerd (TODO post-launch). Voor de App Store review is alleen
// HMAC validatie + 200 OK voldoende.
// ============================================================

import { Router, Request, Response } from 'express';
import { verifyShopifySignature } from '../../../shared/webhooks/webhook-verifier';
import { db } from '../../../infrastructure/database/connection';
import { logger } from '../../../shared/logging/logger';

const router = Router();

// Topics die we expliciet ondersteunen. Andere topics geven 200
// terug maar worden gelogd (Shopify verwacht 2xx voor onbekende).
const GDPR_TOPICS = new Set([
  'customers/data_request',
  'customers/redact',
  'shop/redact',
]);

// Max body size verdediging: Shopify webhooks zijn typisch <10kb.
// Onze raw parser in index.ts limiteert al, maar dubbel check.
const MAX_BODY_BYTES = 1_000_000; // 1 MB

// ─────────────────────────────────────────────────────────────
// POST /api/integrations/webhook/shopify
//
// Verwachte headers van Shopify:
//   x-shopify-topic            bv: customers/redact
//   x-shopify-hmac-sha256      base64-encoded HMAC van raw body
//   x-shopify-shop-domain      bv: marketgrow-test.myshopify.com
//   x-shopify-webhook-id       unieke webhook ID (idempotency)
//   x-shopify-api-version      bv: 2026-01
// ─────────────────────────────────────────────────────────────
router.post('/shopify', async (req: Request, res: Response) => {
  const startTime = Date.now();

  // Headers extraheren. Shopify gebruikt lowercase headers.
  const topic         = headerValue(req, 'x-shopify-topic');
  const hmacHeader    = headerValue(req, 'x-shopify-hmac-sha256');
  const shopDomain    = headerValue(req, 'x-shopify-shop-domain');
  const webhookId     = headerValue(req, 'x-shopify-webhook-id');

  // Raw body. Door express.raw() in index.ts is req.body een Buffer.
  // Bij verkeerde mount is het mogelijk een object: dat is een fail.
  if (!Buffer.isBuffer(req.body)) {
    logger.error('shopify.webhook.raw_body_missing', {
      topic,
      shopDomain,
      bodyType: typeof req.body,
      note: 'express.raw() niet actief op deze route; check index.ts',
    });
    res.status(500).type('text/plain').send('Webhook handler misconfigured');
    return;
  }

  const rawBody = req.body as Buffer;

  if (rawBody.length > MAX_BODY_BYTES) {
    logger.warn('shopify.webhook.body_too_large', {
      topic,
      shopDomain,
      bytes: rawBody.length,
    });
    res.status(413).type('text/plain').send('Payload too large');
    return;
  }

  // ── HMAC validatie ─────────────────────────────────────────
  // KRITIEK: Shopify test bij review met een opzettelijk ongeldige
  // signature en verwacht HTTP 401. Hier geen logging van de
  // signature zelf, dat zou security-sensitive zijn.
  const secret = process.env.SHOPIFY_CLIENT_SECRET;
  if (!secret) {
    logger.error('shopify.webhook.secret_missing', { topic });
    res.status(500).type('text/plain').send('Server configuration error');
    return;
  }

  const isValid = verifyShopifySignature(rawBody, hmacHeader, secret);

  if (!isValid) {
    logger.warn('shopify.webhook.invalid_hmac', {
      topic,
      shopDomain,
      webhookId,
      durationMs: Date.now() - startTime,
    });
    // Shopify review eis: 401 op ongeldige HMAC.
    res.status(401).type('text/plain').send('Invalid HMAC signature');
    return;
  }

  // Vanaf hier weten we dat het bericht van Shopify komt.

  // ── Parse + validate ──────────────────────────────────────
  if (!topic || !shopDomain || !webhookId) {
    logger.warn('shopify.webhook.missing_headers', {
      hasTopic:      !!topic,
      hasShopDomain: !!shopDomain,
      hasWebhookId:  !!webhookId,
    });
    res.status(400).type('text/plain').send('Missing required Shopify headers');
    return;
  }

  let payload: Record<string, unknown> = {};
  try {
    payload = JSON.parse(rawBody.toString('utf8')) as Record<string, unknown>;
  } catch {
    logger.warn('shopify.webhook.invalid_json', { topic, shopDomain });
    // 200 OK want HMAC was valide; we falen achteraf in audit log.
    // Shopify verwacht 2xx en zou anders gaan retryen.
    res.status(200).type('text/plain').send('OK');
    return;
  }

  // ── Idempotency check via webhook_id ──────────────────────
  // Shopify retryt webhooks. Wij dedupliceren op webhook_id.
  try {
    const existing = await db.query<{ id: string }>(
      `SELECT id FROM shopify_webhook_log WHERE webhook_id = $1 LIMIT 1`,
      [webhookId],
      { allowNoTenant: true }
    );
    if (existing.rows[0]) {
      logger.info('shopify.webhook.duplicate', { topic, shopDomain, webhookId });
      // 200 OK zodat Shopify niet blijft retryen.
      res.status(200).type('text/plain').send('OK');
      return;
    }
  } catch (err: any) {
    logger.error('shopify.webhook.idempotency_check_failed', {
      topic,
      shopDomain,
      error: err.message,
    });
    // Niet kritiek: we gaan door. Worst case verwerken we hetzelfde
    // bericht twee keer; de echte deletion logica moet idempotent zijn.
  }

  // ── Tenant lookup ─────────────────────────────────────────
  // Niet kritiek voor 200 OK; bij shop/redact kan de tenant al
  // verwijderd zijn. We zoeken hem op voor de audit log.
  let tenantId: string | null = null;
  try {
    const tenantRow = await db.query<{ tenant_id: string }>(
      `SELECT tenant_id FROM tenant_integrations
       WHERE platform_slug = 'shopify' AND shop_domain = $1
       LIMIT 1`,
      [shopDomain],
      { allowNoTenant: true }
    );
    tenantId = tenantRow.rows[0]?.tenant_id ?? null;
  } catch (err: any) {
    logger.warn('shopify.webhook.tenant_lookup_failed', {
      shopDomain,
      error: err.message,
    });
  }

  // ── Audit log insert ──────────────────────────────────────
  try {
    await db.query(
      `INSERT INTO shopify_webhook_log
         (webhook_id, topic, shop_domain, tenant_id, payload, signature_valid, status, received_at)
       VALUES ($1, $2, $3, $4, $5::jsonb, true, 'received', now())
       ON CONFLICT (webhook_id) DO NOTHING`,
      [webhookId, topic, shopDomain, tenantId, JSON.stringify(payload)],
      { allowNoTenant: true }
    );
  } catch (err: any) {
    logger.error('shopify.webhook.audit_log_failed', {
      topic,
      shopDomain,
      webhookId,
      error: err.message,
    });
    // We sturen alsnog 200 zodat Shopify niet retryt. Onze audit log
    // ontbreekt dan; dat is een te onderzoeken DB issue, niet een
    // reden om de webhook te falen.
  }

  // ── Topic-specifieke acties ───────────────────────────────
  // Voor V0: alleen loggen + audit. Echte data deletion is TODO
  // voor V1 via een BullMQ worker (GDPR window is 30 dagen).
  if (GDPR_TOPICS.has(topic)) {
    logger.info('shopify.webhook.gdpr_received', {
      topic,
      shopDomain,
      tenantId,
      webhookId,
      // TODO V1: queue async deletion job via BullMQ
      pendingAction: topic === 'customers/data_request'
        ? 'data_export_email_to_shop_owner'
        : topic === 'customers/redact'
          ? 'delete_customer_data'
          : 'delete_full_tenant',
    });
  } else {
    logger.info('shopify.webhook.received', {
      topic,
      shopDomain,
      tenantId,
      webhookId,
    });
  }

  // ── 200 OK binnen Shopify's 5-sec timeout ─────────────────
  res.status(200).type('text/plain').send('OK');
});

// ─────────────────────────────────────────────────────────────
// Helper: header value als string (Shopify headers zijn altijd
// case-insensitive). Express maakt headers lowercase.
// ─────────────────────────────────────────────────────────────
function headerValue(req: Request, name: string): string | undefined {
  const v = req.headers[name.toLowerCase()];
  if (typeof v === 'string') return v;
  if (Array.isArray(v) && v.length > 0) return v[0];
  return undefined;
}

export { router as shopifyWebhookRouter };
