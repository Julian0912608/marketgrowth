// ============================================================
// src/modules/ai-engine/services/meta-ad-set-generator.ts
//
// Service voor de Full Ad Set generation flow.
//
// PR 3a.3:
//   suggestConcepts() — AI stelt 5 concept-angles voor
//
// PR 3a.4 toevoegingen:
//   suggestEnrichment() — "Help me invullen" knop in modal,
//                         AI doet voorstel voor 5 enrichment velden
//   data_driven blokkeren — alleen voorstellen als er echte
//                           cijfers zijn (sales OF enrichment)
//
// PR 3a.5 (later):
//   generateAdSet() — voor elk concept body+headline+CTA+3 hooks
//                     parallel + 1 image per concept = 9-15 ads
// ============================================================

import { db }     from '../../../infrastructure/database/connection';
import { logger } from '../../../shared/logging/logger';

const Anthropic = require('@anthropic-ai/sdk');
const anthropic = new (Anthropic.default ?? Anthropic)();

// ── Concept angles ────────────────────────────────────────────
export const CONCEPT_ANGLES = [
  'ugc',
  'pain_point',
  'lifestyle',
  'promo',
  'testimonial',
  'social_proof',
  'data_driven',
  'before_after',
] as const;

export type ConceptAngle = typeof CONCEPT_ANGLES[number];

// Threshold voor "echte" sales data — onder dit aantal is het
// statistisch te weinig om als data_driven angle te gebruiken.
const MIN_UNITS_FOR_DATA_DRIVEN = 10;

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
  concepts:           ConceptSuggestion[];
  productHasContext:  boolean;
  warnings:           string[];
  blockedAngles:      string[];  // angles die niet voorgesteld mogen worden
}

export interface SuggestEnrichmentInput {
  tenantId:   string;
  productId:  string;
  language?:  'nl' | 'en';
}

export interface SuggestEnrichmentResult {
  target_audience:  string;
  key_benefits:     string[];
  pain_points:      string[];
  brand_story:      string;
  use_cases:        string[];
  confidence:       'low' | 'medium' | 'high';
  warnings:         string[];
}

// ── Product context loader ────────────────────────────────────
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
  units_sold_30d?:   number;
  revenue_30d?:      number;
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
    logger.error('meta.product.load_failed', {
      tenantId, productId,
      error: (err as Error).message,
    });
    return null;
  }

  if (!row) return null;

  let tags: string[] | undefined;
  if (row.tags) {
    if (Array.isArray(row.tags)) tags = row.tags;
    else if (typeof row.tags === 'string') {
      try { tags = JSON.parse(row.tags); } catch { tags = undefined; }
    }
  }

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

// ── HTML strip helper ────────────────────────────────────────
function stripHtml(html: string): string {
  if (!html) return '';
  return html
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/li>/gi, '\n')
    .replace(/<li[^>]*>/gi, '• ')
    .replace(/<\/h[1-6]>/gi, '\n\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// ── Bepaal welke angles geblokkeerd moeten worden ────────────
// PR 3a.4: data_driven mag alleen als er ECHTE cijfers zijn —
// anders gaat AI getallen verzinnen ("89% bemerkt verschil").
function determineBlockedAngles(product: RichProductContext): string[] {
  const blocked: string[] = [];

  // Heeft het product enige meetbare statistiek?
  const hasRealSalesData = (product.units_sold_30d ?? 0) >= MIN_UNITS_FOR_DATA_DRIVEN;

  // Heeft de enrichment cijfers/statistieken in zich?
  const enrichmentText = product.enrichment ? [
    product.enrichment.brand_story,
    ...(product.enrichment.key_benefits ?? []),
    ...(product.enrichment.pain_points ?? []),
    ...(product.enrichment.use_cases ?? []),
  ].filter(Boolean).join(' ') : '';

  // Cijfers in tekst (>= 10 of percentages of "X jaar" patroon)
  const hasNumericClaims = /\b\d{2,}%|\b\d{2,}\s*(jaar|years|x|times|klanten|reviews|sterren)/i.test(enrichmentText);

  if (!hasRealSalesData && !hasNumericClaims) {
    blocked.push('data_driven');
  }

  return blocked;
}

// ── Prompt voor concept suggestion ────────────────────────────
function buildSuggestPrompt(args: {
  product:        RichProductContext;
  campaignBrief:  string;
  funnelStage:    string;
  audienceHint?:  string;
  urgencyContext?: string;
  promoContext?:  string;
  language:       'nl' | 'en';
  tone?:          string;
  blockedAngles:  string[];
}): string {

  const { product, campaignBrief, funnelStage, audienceHint, urgencyContext, promoContext, language, tone, blockedAngles } = args;

  const productLines: string[] = [
    `- Titel: ${product.title}`,
    product.price ? `- Prijs: €${product.price.toFixed(2)}` : '',
    product.platform ? `- Verkoopkanaal: ${product.platform}` : '',
    product.product_type ? `- Categorie: ${product.product_type}` : '',
    product.vendor ? `- Merk: ${product.vendor}` : '',
    product.tags && product.tags.length > 0 ? `- Tags: ${product.tags.join(', ')}` : '',
  ].filter(Boolean);

  if (product.description) {
    const stripped = stripHtml(product.description);
    if (stripped.length > 0) {
      const truncated = stripped.length > 1500 ? stripped.slice(0, 1500) + '…' : stripped;
      productLines.push(`- Productbeschrijving: ${truncated}`);
    }
  }

  if (product.seo_description) {
    productLines.push(`- SEO beschrijving: ${product.seo_description}`);
  }

  if (product.variants_summary?.options) {
    const opts = Object.entries(product.variants_summary.options as Record<string, string[]>)
      .map(([k, v]) => `${k}: ${v.join(', ')}`)
      .join('; ');
    if (opts) productLines.push(`- Varianten: ${opts}`);
  }

  if (product.units_sold_30d && product.units_sold_30d > 0) {
    productLines.push(`- Verkocht laatste 30 dagen: ${product.units_sold_30d} stuks`);
  }
  if (product.revenue_30d && product.revenue_30d > 0) {
    productLines.push(`- Omzet laatste 30 dagen: €${product.revenue_30d.toFixed(0)}`);
  }

  const productSection = productLines.join('\n');

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

  const campaignLines: string[] = [
    `- Campaign brief van de adverteerder: "${campaignBrief}"`,
    `- Funnel stage: ${funnelStage} (${funnelStageDescription(funnelStage, language)})`,
  ];
  if (audienceHint) campaignLines.push(`- Doelgroep hint: ${audienceHint}`);
  if (urgencyContext) campaignLines.push(`- Urgentie context: ${urgencyContext}`);
  if (promoContext) campaignLines.push(`- Promo context: ${promoContext}`);
  if (tone) campaignLines.push(`- Gewenste toon: ${tone}`);

  const campaignSection = campaignLines.join('\n');

  const langInstr = language === 'nl'
    ? 'Schrijf alle voorgestelde titels en redenen in het Nederlands.'
    : 'Write all proposed titles and reasons in English.';

  // Filter geblokkeerde angles uit de lijst
  const allowedAngles = CONCEPT_ANGLES.filter(a => !blockedAngles.includes(a));
  const angleDescriptions = `
BESCHIKBARE CONCEPT ANGLES (kies 5):
${allowedAngles.map(a => {
  const descs: Record<string, string> = {
    ugc:          '- ugc: User-generated content stijl, authentic feel, klant in beeld',
    pain_point:   '- pain_point: Adresseert een specifiek probleem dat dit product oplost',
    lifestyle:    '- lifestyle: Aspirational, toont hoe leven met product eruitziet',
    promo:        '- promo: Sale-driven, korting/deadline/urgentie centraal',
    testimonial:  '- testimonial: Quote of review van bestaande klant',
    social_proof: '- social_proof: "1000+ klanten", populariteit, best-seller status',
    data_driven:  '- data_driven: Specifiek getal of statistiek als hook',
    before_after: '- before_after: Transformation, vóór/na effect',
  };
  return descs[a];
}).join('\n')}`;

  let blockedNote = '';
  if (blockedAngles.length > 0) {
    blockedNote = `\n\nLET OP — DE VOLGENDE ANGLES ZIJN UITGESLOTEN:
${blockedAngles.map(a => `- ${a}`).join('\n')}
Reden: er zijn niet genoeg echte cijfers/statistieken beschikbaar om deze angle eerlijk te kunnen claimen. Geen verzonnen percentages of bestseller-claims.`;
  }

  return `You are an expert Meta Ads strategist for ecommerce brands.
Your task: propose 5 distinct creative concept angles for this product's ad campaign.

PRODUCT INFO:
${productSection}${enrichmentSection}

CAMPAIGN INFO:
${campaignSection}

${angleDescriptions}${blockedNote}

INSTRUCTIES:
- Kies precies 5 angles uit de toegestane lijst.
- De 5 moeten echt verschillend zijn — niet 3× variaties op promo.
- Houd rekening met funnel stage: cold audiences hebben andere angles nodig dan warm/hot.
- Houd rekening met productcategorie en prijs.
- Als urgentie/promo context is gegeven, neem promo zeker op.
- ${langInstr}
- Verzin GEEN getallen, percentages of statistieken die niet door data zijn onderbouwd.

PER ANGLE GEEF JE:
- angle: één van de toegestane slugs hierboven
- title: korte titel voor in de UI (max 35 chars)
- reason: 1-2 zinnen waarom DEZE angle werkt voor DIT specifieke product en context

Return ONLY valid JSON, no markdown:
{
  "concepts": [
    {"angle": "...", "title": "...", "reason": "..."},
    ...
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

// ── suggestConcepts (PR 3a.3) ─────────────────────────────────
export async function suggestConcepts(
  input: SuggestConceptsInput,
): Promise<SuggestConceptsResult> {

  const {
    tenantId, productId, campaignBrief,
    funnelStage   = 'cold',
    audienceHint, urgencyContext, promoContext,
    language      = 'nl',
    tone,
  } = input;

  logger.info('meta.suggest_concepts.start', {
    tenantId, productId,
    briefLength: campaignBrief.length,
    funnelStage,
  });

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

  // PR 3a.4: bepaal welke angles geblokkeerd moeten worden
  const blockedAngles = determineBlockedAngles(product);

  if (blockedAngles.includes('data_driven')) {
    warnings.push(
      'Data-driven angle is geblokkeerd: er zijn nog te weinig verkochte items of cijfers in de productcontext om eerlijke statistieken te claimen.'
    );
  }

  const prompt = buildSuggestPrompt({
    product,
    campaignBrief,
    funnelStage,
    audienceHint,
    urgencyContext,
    promoContext,
    language,
    tone,
    blockedAngles,
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
    // Defensief: filter ook hier geblokkeerde angles
    if (blockedAngles.includes(c.angle)) {
      logger.warn('meta.suggest_concepts.blocked_angle_returned', { tenantId, angle: c.angle });
      continue;
    }
    if (seenAngles.has(c.angle)) continue;
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
    blockedAngles: blockedAngles.length,
  });

  return {
    concepts:           validated,
    productHasContext,
    warnings,
    blockedAngles,
  };
}

// ── suggestEnrichment (PR 3a.4) ──────────────────────────────
// "Help me invullen" knop in de enrichment modal.
// AI doet voorstel voor alle 5 velden op basis van wat we van het
// product weten (titel, categorie, prijs, sales data, description).

function buildEnrichmentPrompt(product: RichProductContext, language: 'nl' | 'en'): string {

  const productLines: string[] = [
    `- Titel: ${product.title}`,
    product.price ? `- Prijs: €${product.price.toFixed(2)}` : '',
    product.platform ? `- Verkoopkanaal: ${product.platform}` : '',
    product.product_type ? `- Categorie: ${product.product_type}` : '',
    product.vendor ? `- Merk: ${product.vendor}` : '',
    product.tags && product.tags.length > 0 ? `- Tags: ${product.tags.join(', ')}` : '',
    product.ean ? `- EAN: ${product.ean}` : '',
  ].filter(Boolean);

  if (product.description) {
    const stripped = stripHtml(product.description);
    if (stripped.length > 0) {
      const truncated = stripped.length > 2000 ? stripped.slice(0, 2000) + '…' : stripped;
      productLines.push(`- Productbeschrijving: ${truncated}`);
    }
  }

  if (product.units_sold_30d && product.units_sold_30d > 0) {
    productLines.push(`- Verkocht laatste 30 dagen: ${product.units_sold_30d} stuks`);
  }

  const productSection = productLines.join('\n');

  // Bepaal confidence niveau op basis van beschikbare info
  const hasDescription   = !!product.description && product.description.length > 50;
  const hasCategory      = !!product.product_type;
  const hasSales         = (product.units_sold_30d ?? 0) > 0;

  let confidenceHint = 'low';
  if (hasDescription && hasCategory) confidenceHint = 'high';
  else if (hasDescription || (hasCategory && hasSales)) confidenceHint = 'medium';

  if (language === 'nl') {
    return `Je bent een ervaren ecommerce strateeg. De ondernemer wil context toevoegen aan dit product zodat AI betere ad copy kan maken. Doe een bondig voorstel voor 5 velden op basis van wat we weten.

PRODUCT:
${productSection}

INSTRUCTIES:
- Wees CONCREET. "Mensen die kwaliteit waarderen" is te vaag — denk aan demografie, leeftijd, levensstijl.
- Geen verzonnen percentages of cijfers. Schrijf op basis van het product zelf.
- Als je écht niet kunt afleiden uit beschikbare info, schrijf duidelijke placeholder zoals "[Vul aan: ...]" en geef confidence: "low".
- Schrijf in het Nederlands.

Confidence niveau bepaling:
- "high" = je hebt voldoende info uit titel + categorie + beschrijving
- "medium" = je hebt sommige info, je voorstellen zijn redelijk geïnformeerd
- "low" = je werkt met enkel een titel of EAN, voorstellen zijn educated guesses

Return ONLY valid JSON:
{
  "target_audience": "Korte beschrijving van de ideale klant — leeftijd, lifestyle, situatie",
  "key_benefits": ["Voordeel 1", "Voordeel 2", "Voordeel 3"],
  "pain_points": ["Probleem 1 dat product oplost", "Probleem 2"],
  "brand_story": "1-2 zinnen over het merk/product, wat het uniek maakt",
  "use_cases": ["Use case 1", "Use case 2", "Use case 3"],
  "confidence": "${confidenceHint}"
}`;
  }

  return `You are an experienced ecommerce strategist. The merchant wants to add context to this product so AI can generate better ad copy. Make a concise proposal for 5 fields based on available info.

PRODUCT:
${productSection}

INSTRUCTIONS:
- Be CONCRETE. "People who value quality" is too vague — think demographics, age, lifestyle.
- No invented percentages or numbers. Write based on the product itself.
- If you really cannot infer from available info, write clear placeholder like "[Fill in: ...]" with confidence: "low".

Return ONLY valid JSON:
{
  "target_audience": "...",
  "key_benefits": ["...", "...", "..."],
  "pain_points": ["...", "..."],
  "brand_story": "1-2 sentences",
  "use_cases": ["...", "...", "..."],
  "confidence": "${confidenceHint}"
}`;
}

export async function suggestEnrichment(
  input: SuggestEnrichmentInput,
): Promise<SuggestEnrichmentResult> {

  const { tenantId, productId, language = 'nl' } = input;

  logger.info('meta.suggest_enrichment.start', { tenantId, productId });

  const product = await loadRichProductContext(tenantId, productId);

  if (!product) {
    throw Object.assign(
      new Error('Product niet gevonden'),
      { httpStatus: 404 },
    );
  }

  const warnings: string[] = [];

  // Title check — als de titel een EAN is (Bol-only zonder rich data),
  // waarschuwen we vooraf
  if (/^\d{8,14}$/.test(product.title.trim())) {
    warnings.push(
      'Het product heeft alleen een EAN als titel — AI-voorstellen zijn educated guesses. Pas ze waar nodig aan.',
    );
  }

  const prompt = buildEnrichmentPrompt(product, language);

  const claudeRes = await anthropic.messages.create({
    model:      'claude-sonnet-4-20250514',
    max_tokens: 1200,
    messages:   [{ role: 'user', content: prompt }],
  });

  const text  = claudeRes.content[0]?.type === 'text' ? claudeRes.content[0].text : '{}';
  const clean = text.replace(/```json|```/g, '').trim();

  let parsed: any;
  try {
    parsed = JSON.parse(clean);
  } catch (err) {
    logger.error('meta.suggest_enrichment.parse_failed', {
      tenantId, productId,
      raw: text.slice(0, 300),
    });
    throw new Error('AI enrichment-voorstel genereren mislukt — onverwacht antwoord');
  }

  // Validate structure
  const result: SuggestEnrichmentResult = {
    target_audience: String(parsed.target_audience ?? '').slice(0, 500),
    key_benefits:    Array.isArray(parsed.key_benefits)
      ? parsed.key_benefits.slice(0, 10).map((s: any) => String(s).slice(0, 200))
      : [],
    pain_points:     Array.isArray(parsed.pain_points)
      ? parsed.pain_points.slice(0, 10).map((s: any) => String(s).slice(0, 200))
      : [],
    brand_story:     String(parsed.brand_story ?? '').slice(0, 1000),
    use_cases:       Array.isArray(parsed.use_cases)
      ? parsed.use_cases.slice(0, 10).map((s: any) => String(s).slice(0, 150))
      : [],
    confidence:      ['low', 'medium', 'high'].includes(parsed.confidence)
      ? parsed.confidence
      : 'low',
    warnings,
  };

  logger.info('meta.suggest_enrichment.complete', {
    tenantId, productId,
    confidence: result.confidence,
  });

  return result;
}
