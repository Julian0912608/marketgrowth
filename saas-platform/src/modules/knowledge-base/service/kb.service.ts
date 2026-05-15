// ============================================================
// src/modules/knowledge-base/service/kb.service.ts
//
// Business logic voor Knowledge Base.
// Mapt repository rows naar de juiste DTO afhankelijk van caller:
//   - non-auth user:  KbArticlePreview  (excerpt only)
//   - auth user:      KbArticleFull     (excerpt + body)
//   - admin:          KbArticleAdmin    (alles + draft fields)
// ============================================================

import { kbRepository } from '../repository/kb.repository';
import {
  KbArticleRow,
  KbArticleListItem,
  KbArticlePreview,
  KbArticleFull,
  KbArticleAdmin,
  KbArticleUpsertInput,
  KbCategory,
  KB_CATEGORY_LABELS,
  KbListFilters,
} from '../types/kb.types';

export class KbService {

  // ── PUBLIC: list ────────────────────────────────────────────

  async list(filters: KbListFilters): Promise<KbArticleListItem[]> {
    const rows = await kbRepository.listPublished({
      category:    filters.category,
      countryCode: filters.countryCode ?? null,
      tag:         filters.tag,
    });

    return rows.map(r => this.toListItem(r));
  }

  // ── PUBLIC: single article ──────────────────────────────────

  // isAuthenticated=true geeft KbArticleFull (incl body).
  // isAuthenticated=false geeft KbArticlePreview (excerpt only).
  async getBySlug(
    slug: string,
    isAuthenticated: boolean,
  ): Promise<KbArticlePreview | KbArticleFull | null> {
    const row = await kbRepository.getPublishedBySlug(slug);
    if (!row) return null;

    return isAuthenticated ? this.toFull(row) : this.toPreview(row);
  }

  // ── ADMIN ───────────────────────────────────────────────────

  async adminList(): Promise<KbArticleAdmin[]> {
    const rows = await kbRepository.listAllForAdmin();
    return rows.map(r => this.toAdmin(r));
  }

  async adminGet(id: string): Promise<KbArticleAdmin | null> {
    const row = await kbRepository.getByIdForAdmin(id);
    return row ? this.toAdmin(row) : null;
  }

  async adminCreate(input: KbArticleUpsertInput): Promise<KbArticleAdmin> {
    const existing = await kbRepository.getBySlugForAdmin(input.slug);
    if (existing) {
      throw new SlugConflictError(input.slug);
    }

    const row = await kbRepository.create(input);
    return this.toAdmin(row);
  }

  async adminUpdate(id: string, input: KbArticleUpsertInput): Promise<KbArticleAdmin | null> {
    const existing = await kbRepository.getBySlugForAdmin(input.slug);
    if (existing && existing.id !== id) {
      throw new SlugConflictError(input.slug);
    }

    const row = await kbRepository.update(id, input);
    return row ? this.toAdmin(row) : null;
  }

  async adminTogglePublish(id: string, published: boolean): Promise<KbArticleAdmin | null> {
    const row = await kbRepository.togglePublish(id, published);
    return row ? this.toAdmin(row) : null;
  }

  async adminDelete(id: string): Promise<boolean> {
    return kbRepository.delete(id);
  }

  // ── DTO mappers ─────────────────────────────────────────────

  private toListItem(row: KbArticleRow): KbArticleListItem {
    return {
      id:                 row.id,
      slug:               row.slug,
      title:              row.title,
      description:        row.description,
      excerpt:            this.stripMarkdown(row.excerpt_markdown).slice(0, 200),
      category:           row.category,
      categoryLabel:      KB_CATEGORY_LABELS[row.category],
      tags:               row.tags,
      countryCode:        row.country_code,
      readingTimeMinutes: row.reading_time_minutes,
      published:          row.published,
      displayOrder:       row.display_order,
      updatedAt:          row.updated_at.toISOString(),
    };
  }

  private toPreview(row: KbArticleRow): KbArticlePreview {
    return {
      id:                 row.id,
      slug:               row.slug,
      title:              row.title,
      description:        row.description,
      excerptMarkdown:    row.excerpt_markdown,
      category:           row.category,
      categoryLabel:      KB_CATEGORY_LABELS[row.category],
      tags:               row.tags,
      countryCode:        row.country_code,
      readingTimeMinutes: row.reading_time_minutes,
      publishedAt:        row.created_at.toISOString(),
      requiresAuth:       true,
    };
  }

  private toFull(row: KbArticleRow): KbArticleFull {
    return {
      id:                 row.id,
      slug:               row.slug,
      title:              row.title,
      description:        row.description,
      excerptMarkdown:    row.excerpt_markdown,
      bodyMarkdown:       row.body_markdown,
      category:           row.category,
      categoryLabel:      KB_CATEGORY_LABELS[row.category],
      tags:               row.tags,
      countryCode:        row.country_code,
      readingTimeMinutes: row.reading_time_minutes,
      publishedAt:        row.created_at.toISOString(),
      requiresAuth:       false,
    };
  }

  private toAdmin(row: KbArticleRow): KbArticleAdmin {
    return {
      ...this.toFull(row),
      published:    row.published,
      displayOrder: row.display_order,
      createdAt:    row.created_at.toISOString(),
      updatedAt:    row.updated_at.toISOString(),
    };
  }

  // Simpele markdown stripper voor list excerpts.
  // Niet pijnvloeiend, gewoon de meest voorkomende syntax verwijderen.
  private stripMarkdown(md: string): string {
    return md
      .replace(/^#{1,6}\s+/gm, '')
      .replace(/\*\*(.*?)\*\*/g, '$1')
      .replace(/\*(.*?)\*/g, '$1')
      .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
      .replace(/`([^`]+)`/g, '$1')
      .replace(/^[-*+]\s+/gm, '')
      .replace(/\n{2,}/g, ' ')
      .replace(/\n/g, ' ')
      .trim();
  }
}

// ── Errors ───────────────────────────────────────────────────

export class SlugConflictError extends Error {
  readonly code = 'SLUG_CONFLICT';
  constructor(slug: string) {
    super(`Article met slug "${slug}" bestaat al`);
    this.name = 'SlugConflictError';
  }
}

export const kbService = new KbService();
