// ============================================================
// src/modules/onboarding/types/onboarding.types.ts
//
// Types en allowed-value lijsten voor de onboarding wizard.
//
// Bron-of-truth voor:
//   - allowed country codes (single en multi-select)
//   - business_goal en marketing_style enums
//   - request/response shapes
//
// Wordt gedeeld door repository, service en routes.
//
// V0 Gap 7 (16 mei 2026): hasActiveSubscription toegevoegd aan
// OnboardingState. Wordt afgeleid uit tenant_subscriptions in de
// repository. Frontend gebruikt dit om visuele step 4 (plan) vs
// 5 (store) te bepalen.
// ============================================================

import { BusinessGoal, MarketingStyle } from '../../../shared/types/tenant';

// ── Status en step ───────────────────────────────────────────

export type OnboardingStatus = 'in_progress' | 'skipped' | 'completed';
export type OnboardingStep   = 1 | 2 | 3 | 4;

// ── Country codes ────────────────────────────────────────────
// EU-27 + UK + NO + CH = 30 codes. ISO 3166-1 alpha-2.

export const ALLOWED_COUNTRY_CODES = [
  'AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR',
  'DE', 'GR', 'HU', 'IE', 'IT', 'LV', 'LT', 'LU', 'MT', 'NL',
  'PL', 'PT', 'RO', 'SK', 'SI', 'ES', 'SE', 'GB', 'NO', 'CH',
] as const;

export type CountryCode = typeof ALLOWED_COUNTRY_CODES[number];

export const ALLOWED_SELLS_TO_CODES = [
  ...ALLOWED_COUNTRY_CODES,
  'GLOBAL',
] as const;

export type SellsToCode = typeof ALLOWED_SELLS_TO_CODES[number];

// ── Enum lijsten voor zod ───────────────────────────────────

export const BUSINESS_GOALS: readonly BusinessGoal[] = [
  'lifestyle', 'steady', 'scale-to-exit', 'side-project',
];

export const MARKETING_STYLES: readonly MarketingStyle[] = [
  'paid', 'organic', 'mix',
];

// ── State response voor frontend hydration ──────────────────

export interface OnboardingState {
  status:                OnboardingStatus;
  step:                  OnboardingStep;
  countryCode:           CountryCode | null;
  sellsToCountries:      SellsToCode[] | null;
  businessGoal:          BusinessGoal | null;
  marketingStyle:        MarketingStyle | null;
  shopConnected:         boolean;
  hasActiveSubscription: boolean;
  completedAt:           string | null;  // ISO 8601
}

// ── Inputs per stap ─────────────────────────────────────────

export interface Step1Input {
  countryCode:      CountryCode;
  sellsToCountries: SellsToCode[];
}

export interface Step2Input {
  businessGoal: BusinessGoal;
}

export interface Step3Input {
  marketingStyle: MarketingStyle;
}

export interface CompleteInput {
  shopConnected: boolean;
}

export interface UpdateProfileInput {
  countryCode?:      CountryCode;
  sellsToCountries?: SellsToCode[];
  businessGoal?:     BusinessGoal;
  marketingStyle?:   MarketingStyle;
}

// ── Resultaten ──────────────────────────────────────────────

export interface StepResult {
  ok:        true;
  status:    OnboardingStatus;
  nextStep?: OnboardingStep;
}

export interface CompleteResult extends StepResult {
  dayZeroJobId?: string;
}
