// ============================================================
// src/modules/admin/api/admin-kb.routes.ts
//
// Admin CRUD voor knowledge base artikelen.
// Pattern overgenomen van admin-day-zero.routes.ts: lokale
// adminAuth middleware via adminSessionService.
//
// Mount in index.ts vóór generieke adminRouter:
//   app.use('/api/admin/kb', adminKbRouter);
//
// Endpoints:
//   GET    /admin/kb              — list alle artikelen (incl drafts)
//   GET    /admin/kb/:id          — single article voor edit
//   POST   /admin/kb              — create
//   PUT    /admin/kb/:id          — update
//   PATCH  /admin/kb/:id/publish  — toggle published
//   DELETE /admin/kb/:id          — delete (hard)
// ============================================================

import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { kbService, SlugConflictError } from '../../knowledge-base/service/kb.service';
import { adminSessionService } from '../service/admin-session.service';
import { logger } from '../../../shared/logging/logger';

interface AuthedRequest extends Request {
  adminSession?: { id: string };
}

const router = Router();

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ── Admin auth middleware ────────────────────────────────────

async function adminAuth(req: AuthedRequest, res: Response, next: NextFunction): Promise<void> {
  const token = req.headers['x-admin-session'];

  if (typeof token !== 'string') {
    res.status(401).json({ error: 'Onbevoegd' });
    return;
  }

  const session = await adminSessionService.verify(token);
  if (!session) {
    res.status(401).json({ error: 'Sessie verlopen of ongeldig' });
    return;
  }

  req.adminSession = session;
  next();
}

router.use(adminAuth);

// ── Validation schemas ────────────────────────────────────────

const UpsertSchema = z.object({
  slug:                z.string().min(1).max(200).regex(
    /^[a-z0-9-]+$/,
    'Gebruik alleen kleine letters, cijfers en streepjes'
  ),
  title:               z.string().min(1).max(300),
  description:         z.string().min(1).max(500),
  excerptMarkdown:     z.string().min(1).max(5000),
  bodyMarkdown:        z.string().min(1).max(50000),
  category:            z.enum(['foundation','conversion','advertising','retention','product','analytics']),
  tags:                z.array(z.string().max(50)).max(10).optional(),
  countryCode:         z.string().length(2).nullable().optional(),
  readingTimeMinutes:  z.number().int().min(1).max(60).optional(),
  published:           z.boolean().optional(),
  displayOrder:        z.number().int().min(0).max(9999).optional(),
});

const PublishSchema = z.object({
  published: z.boolean(),
});

// ── GET /admin/kb ─────────────────────────────────────────────

router.get('/', async (_req: AuthedRequest, res: Response, next: NextFunction) => {
  try {
    const items = await kbService.adminList();
    res.json({ items, total: items.length });
  } catch (err) {
    next(err);
  }
});

// ── GET /admin/kb/:id ─────────────────────────────────────────

router.get('/:id', async (req: AuthedRequest, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;
    if (!UUID_REGEX.test(id)) {
      res.status(400).json({ error: 'Ongeldig id' });
      return;
    }

    const article = await kbService.adminGet(id);
    if (!article) {
      res.status(404).json({ error: 'not_found' });
      return;
    }

    res.json({ article });
  } catch (err) {
    next(err);
  }
});

// ── POST /admin/kb ────────────────────────────────────────────

router.post('/', async (req: AuthedRequest, res: Response, next: NextFunction) => {
  try {
    const parsed = UpsertSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(422).json({
        error:  'validation_failed',
        issues: parsed.error.errors,
      });
      return;
    }

    const article = await kbService.adminCreate(parsed.data);

    logger.info('admin.kb.created', {
      sessionId: req.adminSession?.id,
      articleId: article.id,
      slug:      article.slug,
    });

    res.status(201).json({ article });
  } catch (err) {
    if (err instanceof SlugConflictError) {
      res.status(409).json({ error: 'slug_conflict', message: err.message });
      return;
    }
    next(err);
  }
});

// ── PUT /admin/kb/:id ─────────────────────────────────────────

router.put('/:id', async (req: AuthedRequest, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;
    if (!UUID_REGEX.test(id)) {
      res.status(400).json({ error: 'Ongeldig id' });
      return;
    }

    const parsed = UpsertSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(422).json({
        error:  'validation_failed',
        issues: parsed.error.errors,
      });
      return;
    }

    const article = await kbService.adminUpdate(id, parsed.data);
    if (!article) {
      res.status(404).json({ error: 'not_found' });
      return;
    }

    logger.info('admin.kb.updated', {
      sessionId: req.adminSession?.id,
      articleId: id,
      slug:      article.slug,
    });

    res.json({ article });
  } catch (err) {
    if (err instanceof SlugConflictError) {
      res.status(409).json({ error: 'slug_conflict', message: err.message });
      return;
    }
    next(err);
  }
});

// ── PATCH /admin/kb/:id/publish ───────────────────────────────

router.patch('/:id/publish', async (req: AuthedRequest, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;
    if (!UUID_REGEX.test(id)) {
      res.status(400).json({ error: 'Ongeldig id' });
      return;
    }

    const parsed = PublishSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(422).json({ error: 'validation_failed', issues: parsed.error.errors });
      return;
    }

    const article = await kbService.adminTogglePublish(id, parsed.data.published);
    if (!article) {
      res.status(404).json({ error: 'not_found' });
      return;
    }

    logger.info('admin.kb.publish_toggled', {
      sessionId: req.adminSession?.id,
      articleId: id,
      published: parsed.data.published,
    });

    res.json({ article });
  } catch (err) {
    next(err);
  }
});

// ── DELETE /admin/kb/:id ──────────────────────────────────────

router.delete('/:id', async (req: AuthedRequest, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;
    if (!UUID_REGEX.test(id)) {
      res.status(400).json({ error: 'Ongeldig id' });
      return;
    }

    const ok = await kbService.adminDelete(id);
    if (!ok) {
      res.status(404).json({ error: 'not_found' });
      return;
    }

    logger.info('admin.kb.deleted', {
      sessionId: req.adminSession?.id,
      articleId: id,
    });

    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

export { router as adminKbRouter };
