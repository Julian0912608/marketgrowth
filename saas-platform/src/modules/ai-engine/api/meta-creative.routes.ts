// ============================================================
// src/modules/ai-engine/api/meta-creative.routes.ts
//
// API endpoints voor Meta Ad Creative Studio:
//
//   GET    /api/ai/meta-creative/ad-accounts
//                              — lijst beschikbare Meta ad accounts
//   GET    /api/ai/meta-creative/list
//                              — lijst eerder gegenereerde creatives
//   POST   /api/ai/meta-creative/generate
//                              — genereer nieuwe creative (copy + image)
//   POST   /api/ai/meta-creative/:id/regenerate-image
//                              — genereer nieuwe image voor bestaande creative
//   PATCH  /api/ai/meta-creative/:id
//                              — bewerk copy (primary_text, headline, etc.)
//   DELETE /api/ai/meta-creative/:id
//                              — soft delete (zet is_archived=true)
//
// Plan rules (PR 3a):
//   - Starter:  geen toegang tot Meta Creative Studio
//   - Growth:   toegang, max 50 generations/maand (telt onder
//               'ai-recommendations' credit pool)
//   - Scale:    unlimited
//
// Plan gating wordt afgehandeld door de bestaande featureGate
// middleware op 'ai-recommendations' + extra credit pre-check.
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
} from '../services/meta-creative-generator';

const router = Router();
router.use(tenantMiddleware());

// ── Validation helpers ────────────────────────────────────────
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

// ── Plan gating helper ────────────────────────────────────────
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

// ── Credit usage tracker ──────────────────────────────────────
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

const GenerateSchema = z.object({
  format:        z.enum(FORMATS),
  prompt:        z.string().min(5).max(1000),
  productId:     z.string().uuid().optional(),
  language:      z.enum(['nl', 'en']).default('nl'),
  tone:          z.string().max(50).default('lifestyle'),
  generateImage: z.boolean().optional(),
  brandContext:  z.string().max(500).optional(),
  callToAction:  z.enum(META_CTA_OPTIONS).optional(),
});

const UpdateSchema = z.object({
  primary_text:    z.string().max(500).optional(),
  headline:        z.string().max(100).optional(),
  description:     z.string().max(100).optional(),
  call_to_action:  z.enum(META_CTA_OPTIONS).optional(),
  link_url:        z.string().url().max(500).nullable().optional(),
});

// ── GET /api/ai/meta-creative/ad-accounts ────────────────────
// Lijst alle Meta ad accounts beschikbaar voor deze tenant.
// Gebruikt door de Studio om te weten waar creatives bij horen.
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
// Lijst alle (niet-gearchiveerde) creatives voor deze tenant.
router.get('/list', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { tenantId, planSlug } = getTenantContext();
    if (!requireGrowthOrAbove(planSlug, res)) return;

    const result = await db.query(
      `SELECT mc.id, mc.format, mc.primary_text, mc.headline, mc.description,
              mc.call_to_action, mc.asset_urls, mc.status, mc.source,
              mc.generation_prompt, mc.image_aspect_ratio,
              mc.created_at, mc.updated_at,
              p.title AS product_title
       FROM meta_creatives mc
       LEFT JOIN products p ON p.id = mc.source_product_id
       WHERE mc.tenant_id = $1
         AND mc.is_archived = false
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
        productTitle:      r.product_title,
        createdAt:         r.created_at,
        updatedAt:         r.updated_at,
      })),
    });
  } catch (err) { next(err); }
});

// ── POST /api/ai/meta-creative/generate ──────────────────────
// Genereer een nieuwe Meta creative.
router.post('/generate', featureGate('ai-recommendations'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { tenantId, planSlug } = getTenantContext();
    if (!requireGrowthOrAbove(planSlug, res)) return;

    const input = validate(GenerateSchema, req.body);

    // Vind primair Meta ad account voor deze tenant
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
      generateImage: input.generateImage,
      brandContext:  input.brandContext,
      callToAction:  input.callToAction,
    });

    // 3 credits per generation: 1 voor copy + 2 voor image (image is duurder)
    const creditCost = generated.imageUrl ? 3 : 1;
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

// ── POST /api/ai/meta-creative/:id/regenerate-image ─────────
// Genereer een nieuwe image voor bestaande creative (copy blijft).
router.post('/:id/regenerate-image', featureGate('ai-recommendations'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { tenantId, planSlug } = getTenantContext();
    if (!requireGrowthOrAbove(planSlug, res)) return;

    if (!validateUuid(req.params.id)) {
      res.status(400).json({ error: 'Ongeldig creative ID' });
      return;
    }

    const result = await regenerateCreativeImage(tenantId, req.params.id);
    await trackCreditUsage(tenantId, 2); // alleen image = 2 credits

    res.json(result);
  } catch (err) { next(err); }
});

// ── PATCH /api/ai/meta-creative/:id ──────────────────────────
// Update copy fields. Geen credits — handmatige bewerking is gratis.
router.patch('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { tenantId, planSlug } = getTenantContext();
    if (!requireGrowthOrAbove(planSlug, res)) return;

    if (!validateUuid(req.params.id)) {
      res.status(400).json({ error: 'Ongeldig creative ID' });
      return;
    }

    const updates = validate(UpdateSchema, req.body);

    // Build dynamic SET clause
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
// Soft delete — zet is_archived = true.
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
