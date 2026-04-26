// ============================================================
// src/modules/ai-engine/services/meta-creative-generator.ts
//
// Genereert Meta-advertentie content (copy + optioneel image)
// via Claude + Gemini, en slaat op als 'draft' in meta_creatives.
//
// Wordt aangeroepen vanuit:
//   POST /api/ai/meta-creative/generate (zie meta-creative.routes.ts)
//
// PR 3a.2: 4 image-modi ondersteund:
//   1. ai_generated  — Gemini genereert vanaf nul
//   2. product_image — gebruik productfoto uit Shopify products tabel
//   3. uploaded      — gebruik door klant geüploade foto (base64)
//   4. none          — geen image, alleen copy
//
// Architectuur:
//   1. Claude Sonnet 4 → genereert primary_text, headline,
//      description, call_to_action, targeting_hints
//   2. Image bron bepalen op basis van imageMode:
//      - ai_generated: Gemini call
//      - product_image: haal image_url op uit products tabel
//      - uploaded: gebruik direct de meegegeven base64 data URL
//      - none: skip image
//   3. Schrijft naar meta_creatives met status='draft'
// ============================================================

import { db }                from '../../../infrastructure/database/connection';
import { logger }            from '../../../shared/logging/logger';
import { generateAdCreative } from './nano-banana.service';

const Anthropic = require('@anthropic-ai/sdk');
const anthropic = new (Anthropic.default ?? Anthropic)();

// ── Types ─────────────────────────────────────────────────────

export type MetaFormat   = 'single_image' | 'carousel' | 'video' | 'story';
export type MetaPlacement = 'feed' | 'stories' | 'reels';
export type ImageMode    = 'ai_generated' | 'product_image' | 'uploaded' | 'none';

export interface GenerateMetaCreativeInput {
  tenantId:         string;
  integrationId:    string;
  adAccountDbId:    string;
  format:           MetaFormat;
  prompt:           string;                 // user prompt
  productId?:       string;                 // optioneel: koppel aan bestaand product
  language?:        'nl' | 'en';
  tone?:            string;
  imageMode?:       ImageMode;              // PR 3a.2: 4 modi
  uploadedImage?:   string;                 // base64 data URL (voor imageMode='uploaded')
  brandContext?:    string;
  callToAction?:    string;
}

export interface GeneratedMetaCreative {
  creativeId:      string;
  primaryText:     string;
  headline:        string;
  description:     string;
  callToAction:    string;
  targetingHints?: string[];
  imageUrl?:       string;
  imageSource?:    string;                  // 'ai_generated' | 'product_image' | 'uploaded' | 'none'
  format:          MetaFormat;
  status:          'draft';
}

interface ProductContext {
  id:           string;
  title:        string;
  price?:       number;
  description?: string;
  platform:     string;
  imageUrl?:    string;
  revenue30d?:  number;
  unitsSold30d?: number;
}

// ── Lijst van geldige Meta CTA-knoppen ────────────────────────
export const META_CTA_OPTIONS = [
  'SHOP_NOW',      'LEARN_MORE',  'SIGN_UP',     'GET_OFFER',
  'BOOK_TRAVEL',   'CONTACT_US',  'DOWNLOAD',    'DONATE_NOW',
  'APPLY_NOW',     'GET_QUOTE',   'SUBSCRIBE',   'WATCH_MORE',
  'GET_DIRECTIONS',
] as const;

export type MetaCTA = typeof META_CTA_OPTIONS[number];

// ── Helper: ophalen product context als productId is meegegeven ─
async function loadProductContext(
  tenantId:  string,
  productId: string,
): Promise<ProductContext | null> {
  const result = await db.query(
    `SELECT p.id, p.title, p.price_min,
            COALESCE(ti.platform_slug, 'unknown') AS platform,
            p.image_url,
            COALESCE(SUM(li.quantity), 0)    AS units_sold,
            COALESCE(SUM(li.total_price), 0) AS total_revenue
     FROM products p
     LEFT JOIN tenant_integrations ti ON ti.id = p.integration_id
     LEFT JOIN order_line_items li
       ON li.product_id = p.id::text
       AND li.tenant_id = p.tenant_id
       AND li.created_at >= NOW() - INTERVAL '30 days'
     WHERE p.id = $1 AND p.tenant_id = $2
     GROUP BY p.id, ti.platform_slug`,
    [productId, tenantId],
    { allowNoTenant: true },
  );

  const row = result.rows[0];
  if (!row) return null;

  return {
    id:           row.id,
    title:        row.title,
    price:        row.price_min ?? undefined,
    platform:     row.platform,
    imageUrl:     row.image_url ?? undefined,
    revenue30d:   parseFloat(row.total_revenue ?? '0'),
    unitsSold30d: parseInt(row.units_sold ?? '0', 10),
  };
}

// ── Helper: Claude prompt voor Meta ad copy ───────────────────
function buildCopyPrompt(args: {
  userPrompt:    string;
  format:        MetaFormat;
  language:      'nl' | 'en';
  tone:          string;
  product?:      ProductContext;
  brandContext?: string;
  ctaOverride?:  string;
}): string {
  const { userPrompt, format, language, tone, product, brandContext, ctaOverride } = args;

  const langInstr = language === 'nl'
    ? 'Schrijf alle copy in het Nederlands. Gebruik natuurlijk Nederlands, geen letterlijke vertalingen.'
    : 'Write all copy in English. Use natural English suitable for English-speaking markets.';

  const productSection = product
    ? `
PRODUCT CONTEXT:
- Title: ${product.title}
${product.price ? `- Price: €${product.price.toFixed(2)}` : ''}
${product.platform ? `- Sold on: ${product.platform}` : ''}
${product.revenue30d && product.revenue30d > 0 ? `- Revenue last 30 days: €${product.revenue30d.toFixed(0)}` : ''}
${product.unitsSold30d && product.unitsSold30d > 0 ? `- Units sold last 30 days: ${product.unitsSold30d}` : ''}
`
    : '';

  const brandSection = brandContext
    ? `\nBRAND/CAMPAIGN CONTEXT:\n${brandContext}\n`
    : '';

  const formatGuide: Record<MetaFormat, string> = {
    single_image: 'Single image ad. Static image with overlay-friendly copy. Max 125 char primary text recommended.',
    carousel:     'Carousel ad. Multiple cards. Each card has its own image — copy must work as opener for the whole set.',
    video:        'Video ad. Copy displays alongside video. Hook MUST be in first sentence — viewers see copy before video plays.',
    story:        'Story/Reels ad. Vertical 9:16. Copy should be punchy, max ~80 chars to fit story format.',
  };

  const ctaInstruction = ctaOverride
    ? `Use this exact CTA: "${ctaOverride}"`
    : `Choose ONE CTA from this list (this is the Meta button): ${META_CTA_OPTIONS.join(', ')}`;

  return `You are an expert Meta Ads copywriter for ecommerce brands.
Generate Meta advertising copy based on the user's brief.

USER BRIEF: ${userPrompt}
${productSection}${brandSection}
FORMAT: ${formatGuide[format]}
TONE: ${tone}
LANGUAGE: ${langInstr}

REQUIREMENTS:
- primary_text: The main ad copy shown above the image. 90-125 characters ideal.
  Lead with a hook in the first sentence (people scroll fast).
  Avoid superlatives like "best ever", "amazing" — they trigger Meta's policy filters.
- headline: Short bold text under the image. Max 27 characters. Punchy.
- description: Sub-headline below headline. Max 30 characters.
- call_to_action: ${ctaInstruction}
- targeting_hints: 3-5 short bullet points (each max 10 words) suggesting who this ad targets.
  Examples: "Women 25-45 interested in sustainable fashion", "Parents with young children", "Premium product buyers in NL/BE"

Return ONLY valid JSON, no markdown, no commentary:
{
  "primary_text": "...",
  "headline": "...",
  "description": "...",
  "call_to_action": "SHOP_NOW",
  "targeting_hints": ["...", "...", "..."]
}`;
}

// ── Helper: bepaal aspect ratio op basis van format ───────────
function aspectRatioForFormat(format: MetaFormat): string {
  if (format === 'story') return '9:16';
  if (format === 'video') return '16:9';
  return '1:1';
}

// ── Hoofdfunctie ──────────────────────────────────────────────
export async function generateMetaCreative(
  input: GenerateMetaCreativeInput,
): Promise<GeneratedMetaCreative> {

  const {
    tenantId, integrationId, adAccountDbId,
    format, prompt, productId,
    language     = 'nl',
    tone         = 'lifestyle',
    imageMode    = 'ai_generated',
    uploadedImage,
    brandContext,
    callToAction,
  } = input;

  logger.info('meta.creative.generate.start', {
    tenantId, integrationId, format,
    promptLength: prompt.length,
    hasProduct:   !!productId,
    imageMode,
  });

  // Stap 1: optioneel product ophalen
  let product: ProductContext | undefined;
  if (productId) {
    const loaded = await loadProductContext(tenantId, productId);
    product = loaded ?? undefined;
  }

  // Validatie image mode
  if (imageMode === 'product_image' && !product?.imageUrl) {
    throw Object.assign(
      new Error('Product image mode geselecteerd maar product heeft geen image. Selecteer een Shopify product met foto, of kies een andere image-modus.'),
      { httpStatus: 400 }
    );
  }

  if (imageMode === 'uploaded' && !uploadedImage) {
    throw Object.assign(
      new Error('Upload mode geselecteerd maar geen afbeelding meegegeven.'),
      { httpStatus: 400 }
    );
  }

  // Stap 2: Claude → ad copy
  const copyPrompt = buildCopyPrompt({
    userPrompt:   prompt,
    format,
    language,
    tone,
    product,
    brandContext,
    ctaOverride:  callToAction,
  });

  const claudeRes = await anthropic.messages.create({
    model:      'claude-sonnet-4-20250514',
    max_tokens: 800,
    messages:   [{ role: 'user', content: copyPrompt }],
  });

  const text = claudeRes.content[0]?.type === 'text' ? claudeRes.content[0].text : '{}';
  const clean = text.replace(/```json|```/g, '').trim();

  let parsed: {
    primary_text:    string;
    headline:        string;
    description:     string;
    call_to_action:  string;
    targeting_hints: string[];
  };
  try {
    parsed = JSON.parse(clean);
  } catch (err) {
    logger.error('meta.creative.copy_parse_failed', {
      tenantId,
      raw: text.slice(0, 200),
      error: (err as Error).message,
    });
    throw new Error('AI copy genereren mislukt — onverwacht antwoord');
  }

  // Sanitize: enforce max lengths zoals Meta die hanteert
  parsed.primary_text = (parsed.primary_text ?? '').slice(0, 500);
  parsed.headline     = (parsed.headline    ?? '').slice(0, 100);
  parsed.description  = (parsed.description ?? '').slice(0, 100);

  // Valideer CTA
  let cta: string = parsed.call_to_action ?? 'LEARN_MORE';
  if (!META_CTA_OPTIONS.includes(cta as MetaCTA)) {
    logger.warn('meta.creative.invalid_cta', { tenantId, cta });
    cta = 'LEARN_MORE';
  }

  // Stap 3: image bepalen op basis van imageMode
  let imageUrl: string | undefined;
  let imagePrompt: string | undefined;
  let imageSource: ImageMode = imageMode;
  const aspectRatio = aspectRatioForFormat(format);

  if (format === 'video') {
    // Video heeft geen image, alleen copy
    imageSource = 'none';
  } else {
    switch (imageMode) {
      case 'ai_generated': {
        try {
          const nbFormat: 'single' | 'story' | 'carousel' =
            format === 'single_image' ? 'single' :
            format === 'story'        ? 'story'  :
                                        'carousel';

          const imageResult = await generateAdCreative({
            product: {
              title:        product?.title ?? prompt.slice(0, 60),
              description:  product?.description,
              price:        product?.price,
              platform:     'meta',
              revenue30d:   product?.revenue30d,
              sold30d:      product?.unitsSold30d,
              imageUrl:     product?.imageUrl,  // Gemini gebruikt deze als referentie
            },
            format:     nbFormat,
            platform:   'meta',
            style:      'product-focus',
            brandColor: '#4f46e5',
          });

          imageUrl    = imageResult.imageUrl;
          imagePrompt = imageResult.prompt;
        } catch (err) {
          logger.warn('meta.creative.image_gen_failed', {
            tenantId,
            error: (err as Error).message,
          });
          // Best-effort: copy gaat door zonder image
          imageSource = 'none';
        }
        break;
      }

      case 'product_image': {
        // We weten al dat product.imageUrl bestaat (validatie hierboven)
        imageUrl    = product!.imageUrl;
        imagePrompt = `Product image van ${product!.title} (geen AI generatie)`;
        break;
      }

      case 'uploaded': {
        imageUrl    = uploadedImage;
        imagePrompt = `Door gebruiker geüploade afbeelding`;
        break;
      }

      case 'none':
        // Niets te doen
        break;
    }
  }

  // Stap 4: opslaan in meta_creatives als draft
  const insertResult = await db.query<{ id: string }>(
    `INSERT INTO meta_creatives
       (tenant_id, integration_id, ad_account_id,
        source, format, primary_text, headline, description,
        call_to_action, link_url, asset_urls, meta, status,
        source_product_id, generation_prompt, generation_model,
        image_prompt, image_aspect_ratio)
     VALUES ($1, $2, $3,
             'ai_generated', $4, $5, $6, $7,
             $8, NULL, $9, $10, 'draft',
             $11, $12, 'claude-sonnet-4-20250514',
             $13, $14)
     RETURNING id`,
    [
      tenantId,
      integrationId,
      adAccountDbId,
      format,
      parsed.primary_text,
      parsed.headline,
      parsed.description,
      cta,
      imageUrl ? [imageUrl] : null,
      JSON.stringify({
        targeting_hints: parsed.targeting_hints ?? [],
        language,
        tone,
        brand_context:   brandContext ?? null,
        image_source:    imageSource,
      }),
      productId ?? null,
      prompt,
      imagePrompt ?? null,
      imageUrl ? aspectRatio : null,
    ],
    { allowNoTenant: true },
  );

  const creativeId = insertResult.rows[0].id;

  logger.info('meta.creative.generate.complete', {
    tenantId,
    creativeId,
    format,
    imageSource,
    hasImage:        !!imageUrl,
    primaryTextLen:  parsed.primary_text.length,
  });

  return {
    creativeId,
    primaryText:    parsed.primary_text,
    headline:       parsed.headline,
    description:    parsed.description,
    callToAction:   cta,
    targetingHints: parsed.targeting_hints ?? [],
    imageUrl,
    imageSource,
    format,
    status:         'draft',
  };
}

// ── Helper: regenereer alleen image voor bestaande creative ──
export async function regenerateCreativeImage(
  tenantId:    string,
  creativeId:  string,
): Promise<{ imageUrl: string; aspectRatio: string }> {

  const result = await db.query(
    `SELECT mc.id, mc.format, mc.headline, mc.primary_text,
            mc.source_product_id, mc.generation_prompt
     FROM meta_creatives mc
     WHERE mc.id = $1 AND mc.tenant_id = $2`,
    [creativeId, tenantId],
    { allowNoTenant: true },
  );

  const row = result.rows[0];
  if (!row) {
    throw Object.assign(new Error('Creative niet gevonden'), { httpStatus: 404 });
  }

  let product: ProductContext | undefined;
  if (row.source_product_id) {
    const loaded = await loadProductContext(tenantId, row.source_product_id);
    product = loaded ?? undefined;
  }

  const nbFormat: 'single' | 'story' | 'carousel' =
    row.format === 'single_image' ? 'single' :
    row.format === 'story'        ? 'story'  :
                                    'carousel';

  const imageResult = await generateAdCreative({
    product: {
      title:    product?.title ?? row.headline ?? row.generation_prompt?.slice(0, 60) ?? 'Ad creative',
      description: product?.description,
      price:    product?.price,
      platform: 'meta',
      revenue30d: product?.revenue30d,
      sold30d:    product?.unitsSold30d,
      imageUrl:   product?.imageUrl,
    },
    format:     nbFormat,
    platform:   'meta',
    style:      'product-focus',
    brandColor: '#4f46e5',
  });

  // Update bestaande creative met nieuwe image
  await db.query(
    `UPDATE meta_creatives
     SET asset_urls         = $2,
         image_prompt       = $3,
         image_aspect_ratio = $4,
         updated_at         = now()
     WHERE id = $1 AND tenant_id = $5`,
    [
      creativeId,
      [imageResult.imageUrl],
      imageResult.prompt,
      imageResult.aspectRatio,
      tenantId,
    ],
    { allowNoTenant: true },
  );

  return {
    imageUrl:    imageResult.imageUrl,
    aspectRatio: imageResult.aspectRatio,
  };
}
