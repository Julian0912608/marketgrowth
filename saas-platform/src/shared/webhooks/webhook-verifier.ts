// ============================================================
// src/shared/webhooks/webhook-verifier.ts
//
// HMAC signature verification for incoming webhooks.
// Use this for ANY webhook handler — Meta, Shopify, Bol, custom.
//
// Each platform has slightly different conventions:
//  - Header name (X-Hub-Signature-256, X-Shopify-Hmac-Sha256, ...)
//  - Encoding (base64 / hex)
//  - Prefix ("sha256=" or none)
//
// All verifiers use crypto.timingSafeEqual to prevent timing attacks.
// ============================================================

import crypto from 'crypto';
import { logger } from '../logging/logger';

export type WebhookPlatform = 'meta' | 'shopify' | 'bolcom' | 'generic';

/**
 * Verify a Meta (Facebook/Instagram) webhook signature.
 * Header: X-Hub-Signature-256 with format "sha256=<hex>"
 */
export function verifyMetaSignature(
  rawBody: Buffer,
  signatureHeader: string | undefined,
  appSecret: string
): boolean {
  if (!signatureHeader || !signatureHeader.startsWith('sha256=')) {
    return false;
  }

  const provided = signatureHeader.substring(7); // strip "sha256="
  const expected = crypto
    .createHmac('sha256', appSecret)
    .update(rawBody)
    .digest('hex');

  return safeCompare(provided, expected);
}

/**
 * Verify a Shopify webhook signature.
 * Header: X-Shopify-Hmac-Sha256 with format base64
 */
export function verifyShopifySignature(
  rawBody: Buffer,
  signatureHeader: string | undefined,
  secret: string
): boolean {
  if (!signatureHeader) return false;

  const expected = crypto
    .createHmac('sha256', secret)
    .update(rawBody)
    .digest('base64');

  return safeCompare(signatureHeader, expected);
}

/**
 * Verify a Bol.com webhook signature.
 * Bol does not currently sign webhooks; this is a placeholder for if/when
 * they introduce signing. For now use IP allow-listing or shared secret in URL path.
 */
export function verifyBolSignature(): boolean {
  logger.warn('webhook.bolcom.no_signature_scheme', {
    note: 'Bol.com webhooks are not signed; use an unguessable URL path as defense-in-depth',
  });
  return true; // Caller must use URL path secret
}

/**
 * Generic HMAC-SHA256 verification.
 * Use for custom webhook integrations.
 */
export function verifyGenericHmac(
  rawBody: Buffer,
  providedSignature: string | undefined,
  secret: string,
  encoding: 'hex' | 'base64' = 'hex'
): boolean {
  if (!providedSignature) return false;

  const expected = crypto
    .createHmac('sha256', secret)
    .update(rawBody)
    .digest(encoding);

  return safeCompare(providedSignature, expected);
}

/**
 * Verify webhook by platform — main entrypoint for routes.
 */
export function verifyWebhookSignature(params: {
  platform: WebhookPlatform;
  rawBody:  Buffer;
  signature: string | undefined;
  secret:   string;
}): boolean {
  switch (params.platform) {
    case 'meta':
      return verifyMetaSignature(params.rawBody, params.signature, params.secret);
    case 'shopify':
      return verifyShopifySignature(params.rawBody, params.signature, params.secret);
    case 'bolcom':
      return verifyBolSignature();
    case 'generic':
      return verifyGenericHmac(params.rawBody, params.signature, params.secret);
    default:
      logger.error('webhook.verify.unknown_platform', { platform: params.platform });
      return false;
  }
}

/**
 * Constant-time string comparison.
 * Returns false on length mismatch without leaking which.
 */
function safeCompare(a: string, b: string): boolean {
  try {
    const bufA = Buffer.from(a);
    const bufB = Buffer.from(b);

    if (bufA.length !== bufB.length) {
      // Still call timingSafeEqual on equal-length buffers to keep timing constant
      crypto.timingSafeEqual(bufA, Buffer.alloc(bufA.length));
      return false;
    }

    return crypto.timingSafeEqual(bufA, bufB);
  } catch {
    return false;
  }
}
