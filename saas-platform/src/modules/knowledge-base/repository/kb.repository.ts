// ============================================================
// src/modules/knowledge-base/repository/kb.repository.ts
//
// Enige plek die kb_articles leest/schrijft.
// kb_articles is GLOBAL lookup (niet tenant-scoped), dus
// alle queries gebruiken { allowNoTenant: true }.
//
// Public reads filteren op published=true in application-laag.
// Admin reads zien alles (incl drafts).
// ============================================================

import { db } from '../../../infrastructure/database/connection';
import {
  KbArticleRow,
  KbArticleUpsertInput,
  KbCategory,
} from '../types/kb.types';

export class KbRepository {

  // ── PUBLIC reads ────────────────────────────────────────────

  // Country filter pattern:
  //   - countryCode null/undefined: alleen universal (country_code IS NULL)
  //   - countryCode 'NL': universal PLUS country_code = 'NL'
  // V0: alle artikelen zijn universal, dus filter is een no-op nu.
  // V1.2 voegt country-specific toe zonder code changes hier.
  async listPublished(filters: {
    category?:    KbCategory;
    countryCode?: string | null;
    tag?:         string;
  }): Promise<KbArticleRow[]> {
    const params: unknown[] = [];
    const where:  string[]  = ['published = true'];

    if (filters.countryCode) {
      params.push(filters.countryCode);
      where.push(`(country_code IS NULL OR country_code = $${params.length})`);
    } else {
      where.push(`country_code IS NULL`);
    }

    if (filters.category) {
      params.push(filters.category);
      where.push(`category = $${params.length}`);
    }

    if (filters.tag) {
      params.push(filters.tag);
      where.push(`$${params.length} = ANY(tags)`);
    }

    const result = await db.query<KbArticleRow>(
      `SELECT
         id, slug, title, description, excerpt_markdown, body_markdown,
         category, tags, country_code, reading_time_minutes, published,
         display_order, created_at, updated_at
       FROM kb_articles
       WHERE ${where.join(' AND ')}
       ORDER BY display_order ASC, created_at DESC`,
      params,
      { allowNoTenant: true }
    );

    return result.rows;
  }

  async getPublishedBySlug(slug: string): Promise<KbArticleRow | null> {
    const result = await db.query<KbArticleRow>(
      `SELECT
         id, slug, title, description, excerpt_markdown, body_markdown,
         category, tags, country_code, reading_time_minutes, published,
         display_order, created_at, updated_at
       FROM kb_articles
       WHERE slug = $1 AND published = true
       LIMIT 1`,
      [slug],
      { allowNoTenant: true }
    );

    return result.rows[0] ?? null;
  }

  // ── ADMIN reads (incl drafts) ───────────────────────────────

  async listAllForAdmin(): Promise<KbArticleRow[]> {
    const result = await db.query<KbArticleRow>(
      `SELECT
         id, slug, title, description, excerpt_markdown, body_markdown,
         category, tags, country_code, reading_time_minutes, published,
         display_order, created_at, updated_at
       FROM kb_articles
       ORDER BY published DESC, display_order ASC, created_at DESC`,
      [],
      { allowNoTenant: true }
    );

    return result.rows;
  }

  async getByIdForAdmin(id: string): Promise<KbArticleRow | null> {
    const result = await db.query<KbArticleRow>(
      `SELECT
         id, slug, title, description, excerpt_markdown, body_markdown,
         category, tags, country_code, reading_time_minutes, published,
         display_order, created_at, updated_at
       FROM kb_articles
       WHERE id = $1
       LIMIT 1`,
      [id],
      { allowNoTenant: true }
    );

    return result.rows[0] ?? null;
  }

  async getBySlugForAdmin(slug: string): Promise<KbArticleRow | null> {
    const result = await db.query<KbArticleRow>(
      `SELECT
         id, slug, title, description, excerpt_markdown, body_markdown,
         category, tags, country_code, reading_time_minutes, published,
         display_order, created_at, updated_at
       FROM kb_articles
       WHERE slug = $1
       LIMIT 1`,
      [slug],
      { allowNoTenant: true }
    );

    return result.rows[0] ?? null;
  }

  // ── ADMIN writes ────────────────────────────────────────────

  async create(input: KbArticleUpsertInput): Promise<KbArticleRow> {
    const result = await db.query<KbArticleRow>(
      `INSERT INTO kb_articles (
         slug, title, description, excerpt_markdown, body_markdown,
         category, tags, country_code, reading_time_minutes,
         published, display_order
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       RETURNING
         id, slug, title, description, excerpt_markdown, body_markdown,
         category, tags, country_code, reading_time_minutes, published,
         display_order, created_at, updated_at`,
      [
        input.slug,
        input.title,
        input.description,
        input.excerptMarkdown,
        input.bodyMarkdown,
        input.category,
        input.tags ?? [],
        input.countryCode ?? null,
        input.readingTimeMinutes ?? 5,
        input.published ?? true,
        input.displayOrder ?? 0,
      ],
      { allowNoTenant: true }
    );

    return result.rows[0];
  }

  async update(id: string, input: KbArticleUpsertInput): Promise<KbArticleRow | null> {
    const result = await db.query<KbArticleRow>(
      `UPDATE kb_articles SET
         slug                 = $2,
         title                = $3,
         description          = $4,
         excerpt_markdown     = $5,
         body_markdown        = $6,
         category             = $7,
         tags                 = $8,
         country_code         = $9,
         reading_time_minutes = $10,
         published            = $11,
         display_order        = $12,
         updated_at           = now()
       WHERE id = $1
       RETURNING
         id, slug, title, description, excerpt_markdown, body_markdown,
         category, tags, country_code, reading_time_minutes, published,
         display_order, created_at, updated_at`,
      [
        id,
        input.slug,
        input.title,
        input.description,
        input.excerptMarkdown,
        input.bodyMarkdown,
        input.category,
        input.tags ?? [],
        input.countryCode ?? null,
        input.readingTimeMinutes ?? 5,
        input.published ?? true,
        input.displayOrder ?? 0,
      ],
      { allowNoTenant: true }
    );

    return result.rows[0] ?? null;
  }

  async togglePublish(id: string, published: boolean): Promise<KbArticleRow | null> {
    const result = await db.query<KbArticleRow>(
      `UPDATE kb_articles SET
         published   = $2,
         updated_at  = now()
       WHERE id = $1
       RETURNING
         id, slug, title, description, excerpt_markdown, body_markdown,
         category, tags, country_code, reading_time_minutes, published,
         display_order, created_at, updated_at`,
      [id, published],
      { allowNoTenant: true }
    );

    return result.rows[0] ?? null;
  }

  async delete(id: string): Promise<boolean> {
    const result = await db.query(
      `DELETE FROM kb_articles WHERE id = $1`,
      [id],
      { allowNoTenant: true }
    );

    return (result.rowCount ?? 0) > 0;
  }
}

export const kbRepository = new KbRepository();
