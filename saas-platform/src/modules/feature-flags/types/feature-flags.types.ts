// ============================================================
// src/modules/feature-flags/types/feature-flags.types.ts
//
// Types voor country-aware feature flags (V0 Gap 1).
// Architecture Plan v1.0 sectie 5.
// ============================================================

// Alle bekende feature keys.
// Bij toevoegen van een nieuwe flag: hier registreren EN
// een seed migration draaien.
export type FeatureFlagKey =
  // V0 core
  | 'daily_briefing'
  | 'sales_dashboard'
  | 'multi_store_overview'
  | 'ai_memory'
  | 'knowledge_base'
  | 'day_zero_setup'
  | 'onboarding_wizard'
  // Integrations
  | 'integration_shopify'
  | 'integration_meta_ads'
  | 'integration_google_ads'
  | 'integration_woocommerce'
  | 'integration_bol'
  // V0 deferred (in code, default OFF)
  | 'products_page'
  | 'social_content_studio'
  | 'team_accounts'
  // V1 features
  | 'weekly_opportunity_engine'
  | 'multi_store_advanced'
  // KB country-specific
  | 'kb_nl_btw_kvk'
  | 'kb_de_impressum'
  | 'kb_fr_cnil';

// Raw row uit de feature_flags tabel
export interface FeatureFlagRow {
  feature_key:     string;
  country_code:    string | null;
  enabled:         boolean;
  default_enabled: boolean;
  description:     string | null;
}

// Resolved flags voor 1 country, klaar voor frontend consumption
export type FeatureFlagsMap = Record<string, boolean>;

export interface FeatureFlagsResponse {
  countryCode: string | null;
  flags:       FeatureFlagsMap;
  fetchedAt:   string;  // ISO timestamp voor cache debugging
}
