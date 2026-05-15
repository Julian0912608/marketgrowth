// ============================================================
// src/modules/knowledge-base/types/kb.types.ts
//
// Knowledge Base types voor V0 Gap 4.
// Architecture Plan v1.0 sectie 6, Gap 4.
//
// Hybride preview model:
//   - KbArticlePreview: non-auth users, alleen excerpt + metadata
//   - KbArticleFull:    auth users, volledige body
//   - KbArticleAdmin:   admin UI, incl unpublished drafts
//
// Schema verifiable via:
//   SELECT column_name, data_type FROM information_schema.columns
//   WHERE table_schema = 'public' AND table_name = 'kb_articles';
// ============================================================

export type KbCategory =
  | 'foundation'
  | 'conversion'
  | 'advertising'
  | 'retention'
  | 'product'
  | 'analytics';

export const KB_CATEGORIES: KbCategory[] = [
  'foundation',
  'conversion',
  'advertising',
  'retention',
  'product',
  'analytics',
];

export const KB_CATEGORY_LABELS: Record<KbCategory, string> = {
  foundation:  'Foundation',
  conversion:  'Conversion',
  advertising: 'Advertising',
  retention:   'Retention',
  product:     'Product',
  analytics:   'Analytics',
};

// Raw row uit kb_articles tabel
export interface KbArticleRow {
  id:                    string;
  slug:                  string;
  title:                 string;
  description:           string;
  excerpt_markdown:      string;
  body_markdown:         string;
  category:              KbCategory;
  tags:                  string[];
  country_code:          string | null;
  reading_time_minutes:  number;
  published:             boolean;
  display_order:         number;
  created_at:            Date;
  updated_at:            Date;
}

// List item voor zowel public als admin list endpoints.
// Bevat GEEN body_markdown (te zwaar voor lijsten).
export interface KbArticleListItem {
  id:                  string;
  slug:                string;
  title:               string;
  description:         string;
  excerpt:             string;    // Stripped markdown, eerste 200 chars
  category:            KbCategory;
  categoryLabel:       string;
  tags:                string[];
  countryCode:         string | null;
  readingTimeMinutes:  number;
  published:           boolean;
  displayOrder:        number;
  updatedAt:           string;
}

// Public read response (non-auth users).
// Geen body, wel excerpt_markdown voor SEO rendering.
export interface KbArticlePreview {
  id:                  string;
  slug:                string;
  title:               string;
  description:         string;
  excerptMarkdown:     string;
  category:            KbCategory;
  categoryLabel:       string;
  tags:                string[];
  countryCode:         string | null;
  readingTimeMinutes:  number;
  publishedAt:         string;
  requiresAuth:        true;
}

// Authenticated read response.
export interface KbArticleFull {
  id:                  string;
  slug:                string;
  title:               string;
  description:         string;
  excerptMarkdown:     string;
  bodyMarkdown:        string;
  category:            KbCategory;
  categoryLabel:       string;
  tags:                string[];
  countryCode:         string | null;
  readingTimeMinutes:  number;
  publishedAt:         string;
  requiresAuth:        false;
}

// Admin view (incl drafts + write fields)
export interface KbArticleAdmin extends KbArticleFull {
  published:           boolean;
  displayOrder:        number;
  createdAt:           string;
  updatedAt:           string;
}

// Filters voor public list
export interface KbListFilters {
  category?:    KbCategory;
  countryCode?: string | null;
  tag?:         string;
}

// Create/update payload
export interface KbArticleUpsertInput {
  slug:                string;
  title:               string;
  description:         string;
  excerptMarkdown:     string;
  bodyMarkdown:        string;
  category:            KbCategory;
  tags?:               string[];
  countryCode?:        string | null;
  readingTimeMinutes?: number;
  published?:          boolean;
  displayOrder?:       number;
}
