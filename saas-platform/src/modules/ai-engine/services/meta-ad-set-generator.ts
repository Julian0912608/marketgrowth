// ============================================================
// src/modules/ai-engine/services/meta-ad-set-generator.ts
//
// Service voor de Full Ad Set generation flow.
//
// PR 3a.3 — alleen suggestConcepts() geïmplementeerd:
//   AI stelt 5 concept-angles voor op basis van product context
//   (Shopify body_html, product enrichment, sales data) + brief.
//
// PR 3a.5 — generateAdSet() volgt later:
//   Voor elk gekozen concept: body+headline+CTA+3 hooks parallel,
//   plus 1 image per concept. Totaal 9-15 ads als één Campaign.
// ============================================================

import { db }     from '../../../infrastructure/database/connection';
import { logger } from '../../../shared/logging/logger';

const Anthropic = require('@anthropic-ai/sdk');
const anthropic = new (Anthropic.default ?? Anthropic)();

// ── Concept angles ────────────────────────────────────────────
// 8 mogelijke angles. AI kiest de 5 die het beste passen voor
// dit specifieke product en deze campaign brief.

export const CONCEPT_ANGLES = [
  'ugc',          // User-generated content / authentic feel
  'pain_point',   // Probleem dat product oplost
  'lifestyle',    // Aspirational, hoe leven met product
  'promo',        // Sale, korting, urgency
  'testimonial',  // Quote van klant
  'social_proof', // "1000+ klanten", reviews, populariteit
  'data_driven',  // Specifiek getal of statistiek
  'before_after', // Transformation
] as const;

export type ConceptAngle = typeof CONCEPT_ANGLES[number];

// ── Types ─────────────────────────────────────────────────────

export interface SuggestConceptsInput {
  tenantId:        string;
  productId:       string;
  campaignBrief:   string;
  funnelStage?:    'cold' | 'warm' | 'hot';
  audienceHint?:   string;
  urgencyContext?: string;
  promoContext?:   string;
  language?:       'nl' | 'en';
  tone?:           string;
}

export interface ConceptSuggestion {
  angle:  ConceptAngle;
  title:  string;
  reason: string;
}

export interface SuggestConceptsResult {
  concepts:    ConceptSuggestion[];
  productHasContext: boolean;  // false als product nog enrichment nodig heeft
  warnings:    string[];
}

// ── Product context loader ────────────────────────────────────
// Laadt zoveel mogelijk over een product: basis data + Shopify
// description + product_enrichment + sales data.

interface RichProductContext {
  id:                string;
  title:             string;
  platform:          string;
  price?:            number;
  description?:      string;
  images?:           Array<{ src: string; alt?: string }>;
  variants_summary?: any;
  seo_description?:  string;
  ean?:              string;
  product_type?:     string;
  tags?:             string[];
  vendor?:           string;
  // Sales data
  units_sold_30d?:   number;
  revenue_30d?:      number;
  // Enrichment data
  enrichment?: {
    target_audience?: string;
    key_benefits?:    string[];
    pain_points?:     string[];
    brand_story?:     string;
    use_cases?:       string[];
  };
}

async function loadRichProductContext(
  tenantId: string,
  productId: string,
): Promise<RichProductContext | null> {

  // Stap 1: basis product + sales data + enrichment in 1 query
  // Defensive: try/catch zodat een schema-issue ons niet doodt.
  let row: any;
  try {
    const result = await db.query(
      `SELECT
         p.id, p.title, p.price_min,
         COALESCE(ti.platform_slug, 'unknown') AS platform,
         p.description, p.images, p.variants_summary, p.seo_description,
         p.ean, p.product_type, p.tags, p.vendor,
         COALESCE(SUM(li.quantity), 0)    AS units_sold_30d,
         COALESCE(SUM(li.total_price), 0) AS revenue_30d,
         pe.target_audience,
         pe.key_benefits,
         pe.pain_points,
         pe.brand_story,
         pe.use_cases
       FROM products p
       LEFT JOIN tenant_integrations ti ON ti.id = p.integration_id
       LEFT JOIN order_line_items li
         ON li.product_id = p.id::text
         AND li.tenant_id = p.tenant_id
       LEFT JOIN orders o
         ON o.id = li.order_id
         AND o.ordered_at >= NOW() - INTERVAL '30 days'
         AND o.status NOT IN ('cancelled','refunded')
       LEFT JOIN product_enrichment pe
         ON pe.product_id = p.id
         AND pe.tenant_id = p.tenant_id
       WHERE p.id = $1 AND p.tenant_id = $2
       GROUP BY p.id, ti.platform_slug,
                pe.target_audience, pe.key_benefits, pe.pain_points,
                pe.brand_story, pe.use_cases`,
      [productId, tenantId],
      { allowNoTenant: true },
    );
    row = result.rows[0];
  } catch (err) {
    logger.error('meta.suggest.product_load_failed', {
      tenantId, productId,
      error: (err as Error).message,
    });
    return null;
  }

  if (!row) return null;

  // tags is JSONB stored as JSON string in some columns — parse defensively
  let tags: string[] | undefined;
  if (row.tags) {
    if (Array.isArray(row.tags)) tags = row.tags;
    else if (typeof row.tags === 'string') {
      try { tags = JSON.parse(row.tags); } catch { tags = undefined; }
    }
  }

  // images en variants_summary zijn JSONB — pg driver geeft ze al als objects terug
  const images = Array.isArray(row.images) ? row.images : undefined;

  const hasEnrichment = !!(
    row.target_audience || row.key_benefits || row.pain_points ||
    row.brand_story || row.use_cases
  );

  return {
    id:               row.id,
    title:            row.title,
    platform:         row.platform,
    price:            row.price_min !== null ? parseFloat(String(row.price_min)) : undefined,
    description:      row.description ?? undefined,
    images,
    variants_summary: row.variants_summary ?? undefined,
    seo_description:  row.seo_description ?? undefined,
    ean:              row.ean ?? undefined,
    product_type:     row.product_type ?? undefined,
    tags,
    vendor:           row.vendor ?? undefined,
    units_sold_30d:   parseInt(String(row.units_sold_30d ?? '0'), 10),
    revenue_30d:      parseFloat(String(row.revenue_30d ?? '0')),
    enrichment: hasEnrichment ? {
      target_audience: row.target_audience ?? undefined,
      key_benefits:    row.key_benefits ?? undefined,
      pain_points:     row.pain_points ?? undefined,
      brand_story:     row.brand_story ?? undefined,
      use_cases:       row.use_cases ?? undefined,
    } : undefined,
  };
}

// ── HTML strippen voor Shopify body_html ─────────────────────
// body_html bevat HTML. Voor de Claude prompt willen we platte tekst,
// maar wel met behoud van structuur (paragrafen, lijsten).

function stripHtml(html: string): string {
  if (!html) return '';
  return html
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/li>/gi, '\n')
    .replace(/<li[^>]*>/gi, '• ')
    .replace(/<\/h[1-6]>/gi, '\n\n')
    .replace(/<[^>]+>/g, '')          // strip alle overige tags
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/\n{3,}/g, '\n\n')        // collapse meerdere lege regels
    .trim();
}

// ── Prompt builder voor concept suggestion ───────────────────

function buildSuggestPrompt(args: {
  product:        RichProductContext;
  campaignBrief:  string;
  funnelStage:    string;
  audienceHint?:  string;
  urgencyContext?: string;
  promoContext?:  string;
  language:       'nl' | 'en';
  tone?:          string;
}): string {

  const { product, campaignBrief, funnelStage, audienceHint, urgencyContext, promoContext, language, tone } = args;

  // Product context section
  const productLines: string[] = [
    `- Titel: ${product.title}`,
    product.price ? `- Prijs: €${product.price.toFixed(2)}` : '',
    product.platform ? `- Verkoopkanaal: ${product.platform}` : '',
    product.product_type ? `- Categorie: ${product.product_type}` : '',
    product.vendor ? `- Merk: ${product.vendor}` : '',
    product.tags && product.tags.length > 0 ? `- Tags: ${product.tags.join(', ')}` : '',
  ].filter(Boolean);

  // Description
  if (product.description) {
    const stripped = stripHtml(product.description);
    if (stripped.length > 0) {
      // Limit to ~1500 chars zodat de prompt niet ontploft
      const truncated = stripped.length > 1500 ? stripped.slice(0, 1500) + '…' : stripped;
      productLines.push(`- Productbeschrijving: ${truncated}`);
    }
  }

  if (product.seo_description) {
    productLines.push(`- SEO beschrijving: ${product.seo_description}`);
  }

  // Variants
  if (product.variants_summary?.options) {
    const opts = Object.entries(product.variants_summary.options as Record<string, string[]>)
      .map(([k, v]) => `${k}: ${v.join(', ')}`)
      .join('; ');
    if (opts) productLines.push(`- Varianten: ${opts}`);
  }

  // Sales data
  if (product.units_sold_30d && product.units_sold_30d > 0) {
    productLines.push(`- Verkocht laatste 30 dagen: ${product.units_sold_30d} stuks`);
  }
  if (product.revenue_30d && product.revenue_30d > 0) {
    productLines.push(`- Omzet laatste 30 dagen: €${product.revenue_30d.toFixed(0)}`);
  }

  const productSection = productLines.join('\n');

  // Enrichment section (alleen als ingevuld)
  let enrichmentSection = '';
  if (product.enrichment) {
    const e = product.enrichment;
    const lines: string[] = [];
    if (e.target_audience) lines.push(`- Doelgroep: ${e.target_audience}`);
    if (e.key_benefits && e.key_benefits.length > 0) {
      lines.push(`- USPs / voordelen: ${e.key_benefits.join('; ')}`);
    }
    if (e.pain_points && e.pain_points.length > 0) {
      lines.push(`- Pain points van klant: ${e.pain_points.join('; ')}`);
    }
    if (e.brand_story) lines.push(`- Brand story: ${e.brand_story}`);
    if (e.use_cases && e.use_cases.length > 0) {
      lines.push(`- Use cases: ${e.use_cases.join(', ')}`);
    }
    if (lines.length > 0) {
      enrichmentSection = `\n\nDOOR EIGENAAR INGEVOERDE CONTEXT:\n${lines.join('\n')}`;
    }
  }

  // Campaign context
  const campaignLines: string[] = [
    `- Campaign brief van de adverteerder: "${campaignBrief}"`,
    `- Funnel stage: ${funnelStage} (${funnelStageDescription(funnelStage, language)})`,
  ];
  if (audienceHint) campaignLines.push(`- Doelgroep hint: ${audienceHint}`);
  if (urgencyContext) campaignLines.push(`- Urgentie context: ${urgencyContext}`);
  if (promoContext) campaignLines.push(`- Promo context: ${promoContext}`);
  if (tone) campaignLines.push(`- Gewenste toon: ${tone}`);

  const campaignSection = campaignLines.join('\n');

  // Language instruction
  const langInstr = language === 'nl'
    ? 'Schrijf alle voorgestelde titels en redenen in het Nederlands.'
    : 'Write all proposed titles and reasons in English.';

  // Concept angle uitleg voor de AI
  const angleDescriptions = `
BESCHIKBARE CONCEPT ANGLES (kies 5):
- ugc: User-generated content stijl, authentic feel, klant in beeld
- pain_point: Adresseert een specifiek probleem dat dit product oplost
- lifestyle: Aspirational, toont hoe leven met product eruitziet
- promo: Sale-driven, korting/deadline/urgentie centraal
- testimonial: Quote of review van bestaande klant
- social_proof: "1000+ klanten", populariteit, best-seller status
- data_driven: Specifiek getal of statistiek als hook
- before_after: Transformation, vóór/na effect`;

  return `You are an expert Meta Ads strategist for ecommerce brands.
Your task: propose 5 distinct creative concept angles for this product's ad campaign.

PRODUCT INFO:
${productSection}${enrichmentSection}

CAMPAIGN INFO:
${campaignSection}

${angleDescriptions}

INSTRUCTIES:
- Kies precies 5 angles uit bovenstaande 8.
- De 5 moeten echt verschillend zijn — niet 3× variaties op promo.
- Houd rekening met funnel stage: cold audiences hebben andere angles nodig dan warm/hot.
- Houd rekening met productcategorie en prijs: een €10 commodity heeft andere angles dan een €200 lifestyle item.
- Als urgentie/promo context is gegeven, neem promo of social_proof zeker op.
- ${langInstr}

PER ANGLE GEEF JE:
- angle: één van de 8 slugs hierboven
- title: korte titel voor in de UI (max 35 chars), bijv. "Cold winter solution"
- reason: 1-2 zinnen waarom DEZE angle werkt voor DIT specifieke product en context

Return ONLY valid JSON, no markdown, no commentary:
{
  "concepts": [
    {"angle": "lifestyle", "title": "...", "reason": "..."},
    {"angle": "ugc", "title": "...", "reason": "..."},
    {"angle": "promo", "title": "...", "reason": "..."},
    {"angle": "pain_point", "title": "...", "reason": "..."},
    {"angle": "social_proof", "title": "...", "reason": "..."}
  ]
}`;
}

function funnelStageDescription(stage: string, language: 'nl' | 'en'): string {
  if (language === 'nl') {
    if (stage === 'cold')  return 'mensen die het merk nog niet kennen';
    if (stage === 'warm')  return 'mensen die het merk al kennen of website bezochten';
    if (stage === 'hot')   return 'eerdere klanten of cart abandoners';
    return 'algemeen publiek';
  }
  if (stage === 'cold')  return 'people unfamiliar with the brand';
  if (stage === 'warm')  return 'people who know the brand or visited the site';
  if (stage === 'hot')   return 'past customers or cart abandoners';
  return 'general audience';
}

// ── Public function: suggestConcepts ──────────────────────────

export async function suggestConcepts(
  input: SuggestConceptsInput,
): Promise<SuggestConceptsResult> {

  const {
    tenantId, productId, campaignBrief,
    funnelStage   = 'cold',
    audienceHint,
    urgencyContext,
    promoContext,
    language      = 'nl',
    tone,
  } = input;

  logger.info('meta.suggest_concepts.start', {
    tenantId, productId,
    briefLength: campaignBrief.length,
    funnelStage,
  });

  // Stap 1: laad rich product context
  const product = await loadRichProductContext(tenantId, productId);

  if (!product) {
    throw Object.assign(
      new Error('Product niet gevonden'),
      { httpStatus: 404 },
    );
  }

  const warnings: string[] = [];
  const productHasContext = !!(
    (product.description && product.description.length > 50) ||
    product.enrichment
  );

  if (!productHasContext) {
    warnings.push(
      product.platform === 'bolcom'
        ? 'Dit product heeft geen Shopify-beschrijving en geen handmatige enrichment. AI werkt met beperkte context — vul Product Context in voor betere resultaten.'
        : 'Geen productbeschrijving beschikbaar. AI werkt met beperkte context.'
    );
  }

  // Stap 2: bouw prompt en roep Claude aan
  const prompt = buildSuggestPrompt({
    product,
    campaignBrief,
    funnelStage,
    audienceHint,
    urgencyContext,
    promoContext,
    language,
    tone,
  });

  const claudeRes = await anthropic.messages.create({
    model:      'claude-sonnet-4-20250514',
    max_tokens: 1500,
    messages:   [{ role: 'user', content: prompt }],
  });

  const text  = claudeRes.content[0]?.type === 'text' ? claudeRes.content[0].text : '{}';
  const clean = text.replace(/```json|```/g, '').trim();

  let parsed: { concepts: ConceptSuggestion[] };
  try {
    parsed = JSON.parse(clean);
  } catch (err) {
    logger.error('meta.suggest_concepts.parse_failed', {
      tenantId, productId,
      raw: text.slice(0, 300),
      error: (err as Error).message,
    });
    throw new Error('AI concept-suggestie genereren mislukt — onverwacht antwoord');
  }

  // Validate: precies 5 unieke angles uit de toegestane lijst
  if (!Array.isArray(parsed.concepts) || parsed.concepts.length === 0) {
    throw new Error('AI heeft geen concepten gegenereerd');
  }

  const validated: ConceptSuggestion[] = [];
  const seenAngles = new Set<string>();

  for (const c of parsed.concepts) {
    if (!c.angle || !CONCEPT_ANGLES.includes(c.angle as ConceptAngle)) {
      logger.warn('meta.suggest_concepts.invalid_angle', { tenantId, angle: c.angle });
      continue;
    }
    if (seenAngles.has(c.angle)) continue;  // de-dup
    seenAngles.add(c.angle);

    validated.push({
      angle:  c.angle as ConceptAngle,
      title:  String(c.title ?? '').slice(0, 60),
      reason: String(c.reason ?? '').slice(0, 300),
    });

    if (validated.length >= 5) break;
  }

  if (validated.length === 0) {
    throw new Error('AI gaf geen geldige concept-angles terug');
  }

  if (validated.length < 5) {
    warnings.push(`AI gaf maar ${validated.length} geldige concepten in plaats van 5.`);
  }

  logger.info('meta.suggest_concepts.complete', {
    tenantId, productId,
    conceptCount: validated.length,
    productHasContext,
  });

  return {
    concepts:    validated,
    productHasContext,
    warnings,
  };
}
