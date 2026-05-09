// ============================================================
// src/modules/day-zero/types/baseline-plan.types.ts
//
// Typed shapes voor Day Zero AI output (stages 2, 3, 4).
//
// Alle JSONB velden in baseline_marketing_plans matchen 1-op-1
// met deze interfaces. Bij uitbreiding: hier eerst aanpassen,
// dan de service prompts updaten.
// ============================================================

// ── Stage 2: brand voice ─────────────────────────────────────

export type BrandVoiceStyle =
  | 'casual'
  | 'professional'
  | 'playful'
  | 'authoritative'
  | 'mixed';

export type BrandVoiceRegister = 'informal' | 'formal' | 'mixed';

export type Confidence = 'low' | 'medium' | 'high';

export interface BrandVoice {
  tone:                  string[];           // 3 to 5 short adjectives
  personality:           string;              // 1 to 2 sentences
  style:                 BrandVoiceStyle;
  signature_phrases:     string[];            // 0 to 5 recurring phrases
  taboos:                string[];            // 0 to 3 things to avoid
  target_audience_hint:  string;              // 1 sentence
  language_register:     BrandVoiceRegister;
  confidence:            Confidence;
  source_note:           string;              // 1 sentence on data basis
}

// ── Stage 3: patterns ────────────────────────────────────────

export interface TopSku {
  product_id:        string | null;
  title:             string;
  revenue_excl_vat:  number;
  units_sold:        number;
  contribution_pct:  number;     // share of total revenue, 0 to 100
  reason:            string;     // why this is a top sku
}

export interface SeasonalityMonth {
  month:    number;       // 1 to 12
  index:    number;       // 1.0 = year average
  notable:  boolean;      // true if peak or trough worth flagging
}

export interface CustomerSegment {
  label:                string;        // short name
  description:          string;        // 1 to 2 sentences
  estimated_share_pct:  number;        // 0 to 100
  signals:              string[];      // bullets
}

export interface ChannelMix {
  channel:            string;     // 'shopify', 'bolcom', 'meta_ads', etc.
  revenue_share_pct:  number;     // 0 to 100
  orders_share_pct:   number;     // 0 to 100
  trend:              'up' | 'down' | 'stable' | 'unknown';
}

export interface Patterns {
  top_skus:             TopSku[];              // up to 10
  seasonality:          SeasonalityMonth[];    // up to 12
  seasonality_summary:  string;                // 1 to 2 sentences
  customer_segments:    CustomerSegment[];     // up to 3
  channel_mix:          ChannelMix[];
  key_insights:         string[];              // 3 to 5 bullets
  data_quality:         Confidence;            // overall confidence
}

// ── Stage 4: marketing plan ──────────────────────────────────

export interface TargetAudience {
  name:         string;
  description:  string;
  key_message:  string;
}

export interface ChannelPriority {
  channel:        string;     // 'meta_ads' | 'organic_social' | 'email' | 'seo' | 'bolcom_ads' | etc.
  priority_rank:  number;     // 1 = highest
  rationale:      string;
  weekly_action:  string;     // concrete next step
}

export interface ContentAngle {
  angle:         string;
  example_hook:  string;
  best_channel:  string;
}

export interface MarketingPlan {
  positioning:           string;             // 1 to 2 sentences
  value_propositions:    string[];           // 3 to 5 bullets
  target_audiences:      TargetAudience[];   // up to 3
  channel_priorities:    ChannelPriority[];  // ranked
  content_angles:        ContentAngle[];     // up to 5
  weekly_cadence:        string[];           // 3 to 5 actions
  next_30_days_focus:    string;             // 1 to 2 sentences
  warnings:              string[];           // data gaps or risks
}

// ── DB row ───────────────────────────────────────────────────

export interface BaselineMarketingPlanRow {
  id:                          string;
  tenant_id:                   string;
  brand_voice:                 BrandVoice | Record<string, never>;
  brand_voice_model:           string | null;
  brand_voice_input_tokens:    number;
  brand_voice_output_tokens:   number;
  brand_voice_generated_at:    Date | null;
  patterns:                    Patterns | Record<string, never>;
  patterns_model:              string | null;
  patterns_input_tokens:       number;
  patterns_output_tokens:      number;
  patterns_generated_at:       Date | null;
  marketing_plan:              MarketingPlan | Record<string, never>;
  plan_model:                  string | null;
  plan_input_tokens:           number;
  plan_output_tokens:          number;
  plan_generated_at:           Date | null;
  created_at:                  Date;
  updated_at:                  Date;
}

// ── Onboarding context (uit tenants tabel) ──────────────────

export type BusinessGoal =
  | 'lifestyle'
  | 'steady'
  | 'scale-to-exit'
  | 'side-project'
  | string;     // future-proof voor extra waarden

export type MarketingStyle = 'paid' | 'organic' | 'mix' | string;

export interface OnboardingContext {
  countryCode:       string | null;
  sellsToCountries:  string[] | null;
  businessGoal:      BusinessGoal | null;
  marketingStyle:    MarketingStyle | null;
}

// ── Stage runner result (gemeenschappelijk) ─────────────────

export interface StageRunResult {
  ok:           boolean;
  stage:        2 | 3 | 4;
  model:        string;
  inputTokens:  number;
  outputTokens: number;
  fallback:     boolean;       // true als neutral fallback gebruikt
  notes?:       string;        // korte status voor stage_data en logs
}
