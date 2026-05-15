// ============================================================
// src/modules/knowledge-base/api/kb.routes.ts
//
// Publieke Knowledge Base endpoints.
// Mount in index.ts: app.use('/api/kb', kbRouter);
//
// Auth model: OPTIONEEL. Endpoints werken zonder JWT (voor SEO
// crawlers en niet-ingelogde bezoekers), maar laten meer content
// zien als er een geldige JWT meegestuurd wordt.
//
// Endpoints:
//   GET /api/kb/list             — lijst van published artikelen
//   GET /api/kb/article/:slug    — single article (preview of full)
//   GET /api/kb/categories       — lijst van category enum waarden
// ============================================================

import { Router, Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import { kbService } from '../service/kb.service';
import { KB_CATEGORIES, KB_CATEGORY_LABELS, KbCategory } from '../types/kb.types';
import { logger } from '../../../shared/logging/logger';

const router = Router();

// ── Optional auth helper ─────────────────────────────────────
// Probeert JWT te decoden uit Authorization Bearer header.
// Bij ontbreken of foute token: gewoon door, isAuthenticated=false.
// Voor SEO is het cruciaal dat deze routes ZONDER auth ook werken.

interface JwtPayload {
  userId:     string;
  tenantId:   string;
  tenantSlug?: string;
}

function tryDecodeJwt(req: Request): JwtPayload | null {
  const secret = process.env.JWT_SECRET;
  if (!secret) return null;

  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) return null;

  const token = auth.slice(7);

  try {
    const decoded = jwt.verify(token, secret) as JwtPayload;
    if (decoded && typeof decoded === 'object' && decoded.tenantId) {
      return decoded;
    }
    return null;
  } catch {
    return null;
  }
}

// ── Validation schemas ────────────────────────────────────────

const ListQuerySchema = z.object({
  category:    z.enum(['foundation','conversion','advertising','retention','product','analytics']).optional(),
  tag:         z.string().max(50).optional(),
  countryCode: z.string().length(2).optional(),
});

const SlugSchema = z.string().min(1).max(200).regex(/^[a-z0-9-]+$/);

// ── GET /api/kb/list ──────────────────────────────────────────

router.get('/list', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const parsed = ListQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({
        error:  'invalid_query',
        issues: parsed.error.errors,
      });
      return;
    }

    const auth = tryDecodeJwt(req);

    // Country filter:
    //   1. Query param wint (explicit override)
    //   2. Anders null (toont alleen universal artikelen)
    //
    // V1.2 voegt tenant country lookup toe wanneer er multiple
    // country-specific artikelen bestaan. Voor V0 zijn alle 20
    // artikelen universal dus filter is no-op.
    const countryCode: string | null = parsed.data.countryCode ?? null;

    const items = await kbService.list({
      category:    parsed.data.category as KbCategory | undefined,
      tag:         parsed.data.tag,
      countryCode,
    });

    res.json({
      items,
      categories:      KB_CATEGORIES,
      categoryLabels:  KB_CATEGORY_LABELS,
      isAuthenticated: !!auth,
    });
  } catch (err) {
    logger.error('kb.list_failed', { error: (err as Error).message });
    next(err);
  }
});

// ── GET /api/kb/categories ────────────────────────────────────

router.get('/categories', (_req: Request, res: Response) => {
  res.json({
    categories:     KB_CATEGORIES,
    categoryLabels: KB_CATEGORY_LABELS,
  });
});

// ── GET /api/kb/article/:slug ─────────────────────────────────

router.get('/article/:slug', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const parsed = SlugSchema.safeParse(req.params.slug);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_slug' });
      return;
    }

    const auth = tryDecodeJwt(req);
    const article = await kbService.getBySlug(parsed.data, !!auth);

    if (!article) {
      res.status(404).json({ error: 'not_found' });
      return;
    }

    res.json({
      article,
      isAuthenticated: !!auth,
    });
  } catch (err) {
    logger.error('kb.article_failed', {
      slug:  req.params.slug,
      error: (err as Error).message,
    });
    next(err);
  }
});

export { router as kbRouter };
