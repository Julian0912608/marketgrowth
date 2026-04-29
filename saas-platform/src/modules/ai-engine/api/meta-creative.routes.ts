// ============================================================
// src/modules/ai-engine/api/meta-creative.routes.ts
//
// API endpoints voor Meta Ad Creative Studio.
//
// PR 3a.4 toevoegingen:
//   POST /api/ai/meta-creative/products/:id/enrichment-suggest
//   (AI assist — "Help me invullen" knop in modal)
//
// PR 3a.3:
//   POST /api/ai/meta-creative/suggest-concepts
//   GET  /api/ai/meta-creative/products/:id/enrichment
//   PUT  /api/ai/meta-creative/products/:id/enrichment
//
// PR 3a (basis, blijven werken):
//   POST /api/ai/meta-creative/generate
//   GET  /api/ai/meta-creative/list
//   PATCH/DELETE /api/ai/meta-creative/:id
//   POST /api/ai/meta-creative/:id/regenerate-image
// ============================================================

import { Router, Request, Response, NextFunction } from 'express';
import { z }                          from 'zod';
import { tenantMiddleware }           from '../../../shared/middleware/tenant.middleware';
import { featureGate }                from '../../../shared/middleware/feature-gate.middleware';
import { getTenantContext }           from '../../../shared/middleware/tenant-context';
import { db }                         from '../../../infrastructure/database/connection';
import { logger }                     from '../../../shared/logging/logger';
import {
  generateMetaCreative,
  regenerateCreativeImage,
  META_CTA_OPTIONS,
  MetaFormat,
  ImageMode,
} from '../services/meta-creative-generator';
import {
  suggestConcepts,
  suggestEnrichment,
  CONCEPT_ANGLES,
} from '../services/meta-ad-set-generator';

const router = Router();
router.use(tenantMiddleware());

function validate<T>(schema: z.ZodSchema<T>, data: unknown): T {
  const result = schema.safeParse(data);
  if (!result.success) {
    const messages = result.error.errors.map(e => `${e.path.join('.')}: ${e.message}`).join(', ');
    throw Object.assign(new Error(messages), { httpStatus: 400 });
  }
  return result.data;
}

function validateUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

function requireGrowthOrAbove(planSlug: string, res: Response): boolean {
  if (planSlug === 'starter') {
    res.status(403).json({
      error:           'plan_insufficient',
      message:         'Meta Creative Studio is available from the Growth plan.',
      upgradeRequired: true,
      requiredPlan:    'growth',
    });
    return false;
  }
  return true;
}

async function trackCreditUsage(
  tenantId: string,
  count:    number,
): Promise<void> {
  try {
    await db.query(
      `INSERT INTO feature_usage (tenant_id, feature_id, period_start, period_end, usage_count)
       SELECT $1, f.id, date_trunc('month', now()),
              (date_trunc('month', now()) + interval '1 month - 1 day')::date, $2
       FROM features f WHERE f.slug = 'ai-recommendations'
       ON CONFLICT (tenant_id, feature_id, period_start)
       DO UPDATE SET usage_count = feature_usage.usage_count + $2, updated_at = now()`,
      [tenantId, count],
      { allowNoTenant: true },
    );
  } catch (err) {
    logger.warn('meta.creative.usage.track_failed', {
      tenantId,
      error: (err as Error).message,
    });
  }
}

// ── Schemas ───────────────────────────────────────────────────

const FORMATS = ['single_image', 'carousel', 'video', 'story'] as const;
const IMAGE_MODES = ['ai_generated', 'product_image', 'uploaded', 'none'] as const;

const GenerateSchema = z.object({
  format:         z.enum(FORMATS),
  prompt:         z.string().min(5).max(1000),
  productId:      z.string().uuid().optional(),
  language:       z.enum(['nl', 'en']).default('nl'),
  tone:           z.string().max(50).default('lifestyle'),
  imageMode:      z.enum(IMAGE_MODES).default('ai_generated'),
  uploadedImage:  z.string()
                    .max(7_000_000)
                    .regex(/^data:image\/(jpeg|jpg|png|webp);base64,/, 'Moet een data:image base64 URL zijn')
                    .optional(),
  brandContext:   z.string().max(500).optional(),
  callToAction:   z.enum(META_CTA_OPTIONS).optional(),
});

const UpdateSchema = z.object({
  primary_text:    z.string().max(500).optional(),
  headline:        z.string().max(100).optional(),
  description:     z.string().max(100).optional(),
  call_to_action:  z.enum(META_CTA_OPTIONS).optional(),
  link_url:        z.string().url().max(500).nullable().optional(),
});

const SuggestConceptsSchema = z.object({
  productId:       z.string().uuid(),
  campaignBrief:   z.string().min(5).max(1000),
  funnelStage:     z.enum(['cold', 'warm', 'hot']).optional(),
  audienceHint:    z.string().max(300).optional(),
  urgencyContext:  z.string().max(300).optional(),
  promoContext:    z.string().max(300).optional(),
  language:        z.enum(['nl', 'en']).default('nl'),
  tone:            z.string().max(50).optional(),
});

const EnrichmentSchema = z.object({
  target_audience: z.string().max(500).optional().nullable(),
  key_benefits:    z.array(z.string().max(200)).max(10).optional(),
  pain_points:     z.array(z.string().max(200)).max(10).optional(),
  brand_story:     z.string().max(1000).optional().nullable(),
  use_cases:       z.array(z.string().max(150)).max(10).optional(),
});

const SuggestEnrichmentSchema = z.object({
  language: z.enum(['nl', 'en']).default('nl'),
});

// ── GET /api/ai/meta-creative/ad-accounts ────────────────────
router.get('/ad-accounts', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { tenantId, planSlug } = getTenantContext();
    if (!requireGrowthOrAbove(planSlug, res)) return;

    const result = await db.query(
      `SELECT ma.id, ma.external_id, ma.account_name, ma.currency, ma.is_primary,
              ti.id AS integration_id
       FROM meta_ad_accounts ma
       JOIN tenant_integrations ti ON ti.id = ma.integration_id
       WHERE ma.tenant_id = $1
         AND ti.status = 'active'
       ORDER BY ma.is_primary DESC, ma.account_name ASC`,
      [tenantId],
    );

    res.json({
      adAccounts: result.rows.map(r => ({
        id:            r.id,
        externalId:    r.external_id,
        name:          r.account_name,
        currency:      r.currency,
        isPrimary:     r.is_primary,
        integrationId: r.integration_id,
      })),
    });
  } catch (err) { next(err); }
});

// ── GET /api/ai/meta-creative/list ───────────────────────────
router.get('/list', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { tenantId, planSlug } = getTenantContext();
    if (!requireGrowthOrAbove(planSlug, res)) return;

    const result = await db.query(
      `SELECT mc.id, mc.format, mc.primary_text, mc.headline, mc.description,
              mc.call_to_action, mc.asset_urls, mc.status, mc.source,
              mc.generation_prompt, mc.image_aspect_ratio, mc.meta,
              mc.created_at, mc.updated_at,
              p.title AS product_title
       FROM meta_creatives mc
       LEFT JOIN products p ON p.id = mc.source_product_id
       WHERE mc.tenant_id = $1
         AND mc.is_archived = false
         AND mc.ad_set_id IS NULL
       ORDER BY mc.created_at DESC
       LIMIT 100`,
      [tenantId],
    );

    res.json({
      creatives: result.rows.map(r => ({
        id:                r.id,
        format:            r.format,
        primaryText:       r.primary_text,
        headline:          r.headline,
        description:       r.description,
        callToAction:      r.call_to_action,
        assetUrls:         r.asset_urls ?? [],
        status:            r.status,
        source:            r.source,
        generationPrompt:  r.generation_prompt,
        imageAspectRatio:  r.image_aspect_ratio,
        imageSource:       r.meta?.image_source ?? null,
        productTitle:      r.product_title,
        createdAt:         r.created_at,
        updatedAt:         r.updated_at,
      })),
    });
  } catch (err) { next(err); }
});

// ── POST /api/ai/meta-creative/generate ──────────────────────
router.post('/generate', featureGate('ai-recommendations'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { tenantId, planSlug } = getTenantContext();
    if (!requireGrowthOrAbove(planSlug, res)) return;

    const input = validate(GenerateSchema, req.body);

    const accountResult = await db.query(
      `SELECT ma.id, ma.integration_id
       FROM meta_ad_accounts ma
       JOIN tenant_integrations ti ON ti.id = ma.integration_id
       WHERE ma.tenant_id = $1 AND ti.status = 'active'
       ORDER BY ma.is_primary DESC, ma.created_at ASC
       LIMIT 1`,
      [tenantId],
    );

    if (!accountResult.rows[0]) {
      res.status(400).json({
        error:   'no_meta_account',
        message: 'Koppel eerst een Meta ad account via Integraties.',
      });
      return;
    }

    const { id: adAccountDbId, integration_id: integrationId } = accountResult.rows[0];

    const generated = await generateMetaCreative({
      tenantId,
      integrationId,
      adAccountDbId,
      format:        input.format as MetaFormat,
      prompt:        input.prompt,
      productId:     input.productId,
      language:      input.language,
      tone:          input.tone,
      imageMode:     input.imageMode as ImageMode,
      uploadedImage: input.uploadedImage,
      brandContext:  input.brandContext,
      callToAction:  input.callToAction,
    });

    const creditCost = input.imageMode === 'ai_generated' ? 3 : 1;
    await trackCreditUsage(tenantId, creditCost);

    res.status(201).json({
      creative: generated,
      creditsUsed: creditCost,
    });
  } catch (err) {
    logger.error('meta.creative.generate.error', {
      error: (err as Error).message,
      stack: (err as Error).stack?.slice(0, 300),
    });
    next(err);
  }
});

// ── POST /api/ai/meta-creative/suggest-concepts (PR 3a.3) ────
router.post('/suggest-concepts', featureGate('ai-recommendations'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { tenantId, planSlug } = getTenantContext();
    if (!requireGrowthOrAbove(planSlug, res)) return;

    const input = validate(SuggestConceptsSchema, req.body);

    const result = await suggestConcepts({
      tenantId,
      productId:       input.productId,
      campaignBrief:   input.campaignBrief,
      funnelStage:     input.funnelStage,
      audienceHint:    input.audienceHint,
      urgencyContext:  input.urgencyContext,
      promoContext:    input.promoContext,
      language:        input.language,
      tone:            input.tone,
    });

    await trackCreditUsage(tenantId, 2);

    res.json({
      ...result,
      creditsUsed: 2,
      availableAngles: CONCEPT_ANGLES,
    });
  } catch (err) {
    logger.error('meta.suggest_concepts.error', {
      error: (err as Error).message,
      stack: (err as Error).stack?.slice(0, 300),
    });
    next(err);
  }
});

// ── GET /api/ai/meta-creative/products/:id/enrichment ────────
router.get('/products/:id/enrichment', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { tenantId, planSlug } = getTenantContext();
    if (!requireGrowthOrAbove(planSlug, res)) return;

    if (!validateUuid(req.params.id)) {
      res.status(400).json({ error: 'Ongeldig product ID' });
      return;
    }

    const productCheck = await db.query(
      `SELECT id, title FROM products WHERE id = $1 AND tenant_id = $2`,
      [req.params.id, tenantId],
    );
    if (!productCheck.rows[0]) {
      res.status(404).json({ error: 'Product niet gevonden' });
      return;
    }

    const result = await db.query(
      `SELECT target_audience, key_benefits, pain_points, brand_story, use_cases,
              created_at, updated_at
       FROM product_enrichment
       WHERE tenant_id = $1 AND product_id = $2`,
      [tenantId, req.params.id],
    );

    if (!result.rows[0]) {
      res.json({
        productId: req.params.id,
        productTitle: productCheck.rows[0].title,
        enrichment: null,
      });
      return;
    }

    res.json({
      productId: req.params.id,
      productTitle: productCheck.rows[0].title,
      enrichment: {
        targetAudience: result.rows[0].target_audience,
        keyBenefits:    result.rows[0].key_benefits ?? [],
        painPoints:     result.rows[0].pain_points ?? [],
        brandStory:     result.rows[0].brand_story,
        useCases:       result.rows[0].use_cases ?? [],
        createdAt:      result.rows[0].created_at,
        updatedAt:      result.rows[0].updated_at,
      },
    });
  } catch (err) { next(err); }
});

// ── PUT /api/ai/meta-creative/products/:id/enrichment ────────
router.put('/products/:id/enrichment', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { tenantId, userId, planSlug } = getTenantContext();
    if (!requireGrowthOrAbove(planSlug, res)) return;

    if (!validateUuid(req.params.id)) {
      res.status(400).json({ error: 'Ongeldig product ID' });
      return;
    }

    const productCheck = await db.query(
      `SELECT id FROM products WHERE id = $1 AND tenant_id = $2`,
      [req.params.id, tenantId],
    );
    if (!productCheck.rows[0]) {
      res.status(404).json({ error: 'Product niet gevonden' });
      return;
    }

    const input = validate(EnrichmentSchema, req.body);

    await db.query(
      `INSERT INTO product_enrichment
         (tenant_id, product_id, target_audience, key_benefits, pain_points,
          brand_story, use_cases, enriched_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (tenant_id, product_id)
       DO UPDATE SET
         target_audience = EXCLUDED.target_audience,
         key_benefits    = EXCLUDED.key_benefits,
         pain_points     = EXCLUDED.pain_points,
         brand_story     = EXCLUDED.brand_story,
         use_cases       = EXCLUDED.use_cases,
         enriched_by     = EXCLUDED.enriched_by,
         updated_at      = now()`,
      [
        tenantId,
        req.params.id,
        input.target_audience ?? null,
        input.key_benefits ?? null,
        input.pain_points ?? null,
        input.brand_story ?? null,
        input.use_cases ?? null,
        userId,
      ],
    );

    logger.info('meta.product_enrichment.saved', {
      tenantId, productId: req.params.id, userId,
    });

    res.json({ success: true });
  } catch (err) { next(err); }
});

// ── POST /api/ai/meta-creative/products/:id/enrichment-suggest (PR 3a.4) ──
// AI assist — "Help me invullen" knop in modal.
// AI doet voorstel voor alle 5 enrichment velden.
router.post('/products/:id/enrichment-suggest', featureGate('ai-recommendations'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { tenantId, planSlug } = getTenantContext();
    if (!requireGrowthOrAbove(planSlug, res)) return;

    if (!validateUuid(req.params.id)) {
      res.status(400).json({ error: 'Ongeldig product ID' });
      return;
    }

    const input = validate(SuggestEnrichmentSchema, req.body);

    const result = await suggestEnrichment({
      tenantId,
      productId: req.params.id,
      language:  input.language,
    });

    // Enrichment suggestion = 3 credits (Sonnet call met grote prompt)
    await trackCreditUsage(tenantId, 3);

    res.json({
      ...result,
      creditsUsed: 3,
    });
  } catch (err) {
    logger.error('meta.enrichment_suggest.error', {
      error: (err as Error).message,
      stack: (err as Error).stack?.slice(0, 300),
    });
    next(err);
  }
});

// ── POST /api/ai/meta-creative/:id/regenerate-image ─────────
router.post('/:id/regenerate-image', featureGate('ai-recommendations'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { tenantId, planSlug } = getTenantContext();
    if (!requireGrowthOrAbove(planSlug, res)) return;

    if (!validateUuid(req.params.id)) {
      res.status(400).json({ error: 'Ongeldig creative ID' });
      return;
    }

    const result = await regenerateCreativeImage(tenantId, req.params.id);
    await trackCreditUsage(tenantId, 2);

    res.json(result);
  } catch (err) { next(err); }
});

// ── PATCH /api/ai/meta-creative/:id ──────────────────────────
router.patch('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { tenantId, planSlug } = getTenantContext();
    if (!requireGrowthOrAbove(planSlug, res)) return;

    if (!validateUuid(req.params.id)) {
      res.status(400).json({ error: 'Ongeldig creative ID' });
      return;
    }

    const updates = validate(UpdateSchema, req.body);

    const sets: string[]  = [];
    const params: any[]   = [req.params.id, tenantId];
    let paramIdx = 3;

    if (updates.primary_text !== undefined) {
      sets.push(`primary_text = $${paramIdx++}`);
      params.push(updates.primary_text);
    }
    if (updates.headline !== undefined) {
      sets.push(`headline = $${paramIdx++}`);
      params.push(updates.headline);
    }
    if (updates.description !== undefined) {
      sets.push(`description = $${paramIdx++}`);
      params.push(updates.description);
    }
    if (updates.call_to_action !== undefined) {
      sets.push(`call_to_action = $${paramIdx++}`);
      params.push(updates.call_to_action);
    }
    if (updates.link_url !== undefined) {
      sets.push(`link_url = $${paramIdx++}`);
      params.push(updates.link_url);
    }

    if (sets.length === 0) {
      res.status(400).json({ error: 'Geen velden om te updaten' });
      return;
    }

    sets.push(`updated_at = now()`);

    const result = await db.query<{ id: string }>(
      `UPDATE meta_creatives
       SET ${sets.join(', ')}
       WHERE id = $1 AND tenant_id = $2
       RETURNING id`,
      params,
    );

    if (!result.rows[0]) {
      res.status(404).json({ error: 'Creative niet gevonden' });
      return;
    }

    res.json({ success: true, id: result.rows[0].id });
  } catch (err) { next(err); }
});

// ── DELETE /api/ai/meta-creative/:id ─────────────────────────
router.delete('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { tenantId, planSlug } = getTenantContext();
    if (!requireGrowthOrAbove(planSlug, res)) return;

    if (!validateUuid(req.params.id)) {
      res.status(400).json({ error: 'Ongeldig creative ID' });
      return;
    }

    const result = await db.query(
      `UPDATE meta_creatives
       SET is_archived = true, updated_at = now()
       WHERE id = $1 AND tenant_id = $2
       RETURNING id`,
      [req.params.id, tenantId],
    );

    if (!result.rows[0]) {
      res.status(404).json({ error: 'Creative niet gevonden' });
      return;
    }

    res.json({ success: true });
  } catch (err) { next(err); }
});

export { router as metaCreativeRouter };
