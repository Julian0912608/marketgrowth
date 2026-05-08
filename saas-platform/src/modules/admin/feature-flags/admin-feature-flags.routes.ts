// ============================================================
// src/modules/admin/feature-flags/admin-feature-flags.routes.ts
//
// Admin-only endpoints voor het beheren van country-aware feature flags.
//
// Endpoints:
//   GET    /api/admin/feature-flags
//     -> { rows: FeatureFlagRow[], countries: string[] }
//
//   PUT    /api/admin/feature-flags
//     body: { feature_key, country_code | null, enabled, description? }
//     -> upsert + cache invalidate
//
//   DELETE /api/admin/feature-flags
//     body: { feature_key, country_code | null }
//     -> delete + cache invalidate
//
// Schrijf-acties roepen featureFlagsService.invalidateAll() aan zodat
// changes binnen ~1s zichtbaar zijn op het platform (geen 5 min TTL wait).
// ============================================================

import { Router, Request, Response, NextFunction } from 'express';
import { z, ZodError }            from 'zod';
import { db }                     from '../../../infrastructure/database/connection';
import { logger }                 from '../../../shared/logging/logger';
import { requireAdminSession }    from '../../../shared/middleware/admin-session.middleware';
import { featureFlagsService }    from '../../feature-flags/service/feature-flags.service';
import { FeatureFlagRow }         from '../../feature-flags/types/feature-flags.types';

const router = Router();
router.use(requireAdminSession());

// ── Validation schemas ────────────────────────────────────────
const CountryCodeSchema = z
  .string()
  .regex(/^[A-Z]{2}$/, 'country_code must be ISO 3166-1 alpha-2 (e.g. NL)')
  .nullable();

const UpsertSchema = z.object({
  feature_key:  z.string().min(1).max(100).regex(/^[a-z0-9_]+$/, 'feature_key must be snake_case'),
  country_code: CountryCodeSchema,
  enabled:      z.boolean(),
  description:  z.string().max(500).optional().nullable(),
});

const DeleteSchema = z.object({
  feature_key:  z.string().min(1).max(100),
  country_code: CountryCodeSchema,
});

function handleValidationError(err: unknown, res: Response): boolean {
  if (err instanceof ZodError) {
    res.status(422).json({
      error: 'validation_failed',
      issues: err.errors.map(e => ({ path: e.path.join('.'), message: e.message })),
    });
    return true;
  }
  return false;
}

// ── GET /api/admin/feature-flags ─────────────────────────────
router.get('/', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const result = await db.query<FeatureFlagRow & { id: string; updated_at: string }>(
      `SELECT id, feature_key, country_code, enabled, default_enabled, description, updated_at
       FROM feature_flags
       ORDER BY feature_key, country_code NULLS FIRST`,
      [],
      { allowNoTenant: true }
    );

    // Verzamel ook de unique countries die al een override hebben,
    // zodat de UI de matrix kolommen kan opbouwen.
    const countries = Array.from(
      new Set(result.rows.map(r => r.country_code).filter((c): c is string => c !== null))
    ).sort();

    res.json({
      rows:      result.rows,
      countries,
      fetchedAt: new Date().toISOString(),
    });
  } catch (err) {
    next(err);
  }
});

// ── PUT /api/admin/feature-flags (upsert) ────────────────────
router.put('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const data = UpsertSchema.parse(req.body);

    // ON CONFLICT op (feature_key, country_code) — let op dat country_code NULL
    // wordt door de UNIQUE constraint behandeld omdat onze constraint dat expliciet
    // toelaat (feature_flags_unique_key_country uit de migration).
    //
    // Postgres gotcha: NULL is niet equal to NULL in een unique constraint by default.
    // Onze constraint UNIQUE (feature_key, country_code) compenseert dit niet vanzelf.
    // Daarom: insert+conflict alleen waar country_code NOT NULL; voor NULL doen we
    // een handmatige upsert (UPDATE first, INSERT als 0 rows).
    if (data.country_code === null) {
      const updateResult = await db.query(
        `UPDATE feature_flags
         SET enabled = $1, description = COALESCE($2, description), updated_at = NOW()
         WHERE feature_key = $3 AND country_code IS NULL`,
        [data.enabled, data.description ?? null, data.feature_key],
        { allowNoTenant: true }
      );

      if (updateResult.rowCount === 0) {
        await db.query(
          `INSERT INTO feature_flags (feature_key, country_code, enabled, default_enabled, description)
           VALUES ($1, NULL, $2, $2, $3)`,
          [data.feature_key, data.enabled, data.description ?? null],
          { allowNoTenant: true }
        );
      }
    } else {
      await db.query(
        `INSERT INTO feature_flags (feature_key, country_code, enabled, default_enabled, description)
         VALUES ($1, $2, $3, $3, $4)
         ON CONFLICT (feature_key, country_code)
         DO UPDATE SET
           enabled     = EXCLUDED.enabled,
           description = COALESCE(EXCLUDED.description, feature_flags.description),
           updated_at  = NOW()`,
        [data.feature_key, data.country_code, data.enabled, data.description ?? null],
        { allowNoTenant: true }
      );
    }

    await featureFlagsService.invalidateAll();

    logger.info('admin.feature_flags.upsert', {
      feature_key:  data.feature_key,
      country_code: data.country_code,
      enabled:      data.enabled,
    });

    res.json({ ok: true });
  } catch (err) {
    if (handleValidationError(err, res)) return;
    next(err);
  }
});

// ── DELETE /api/admin/feature-flags ──────────────────────────
router.delete('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const data = DeleteSchema.parse(req.body);

    let deleteResult;
    if (data.country_code === null) {
      deleteResult = await db.query(
        `DELETE FROM feature_flags WHERE feature_key = $1 AND country_code IS NULL`,
        [data.feature_key],
        { allowNoTenant: true }
      );
    } else {
      deleteResult = await db.query(
        `DELETE FROM feature_flags WHERE feature_key = $1 AND country_code = $2`,
        [data.feature_key, data.country_code],
        { allowNoTenant: true }
      );
    }

    await featureFlagsService.invalidateAll();

    logger.info('admin.feature_flags.delete', {
      feature_key:  data.feature_key,
      country_code: data.country_code,
      removed:      deleteResult.rowCount,
    });

    res.json({ ok: true, removed: deleteResult.rowCount ?? 0 });
  } catch (err) {
    if (handleValidationError(err, res)) return;
    next(err);
  }
});

export { router as adminFeatureFlagsRouter };
