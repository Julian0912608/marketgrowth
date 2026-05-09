// ============================================================
// src/modules/day-zero/repository/baseline-plan.repository.ts
//
// Datalaag voor baseline_marketing_plans. Drie verantwoordelijkheden:
//
//   1. UPSERT per stage (brand voice, patterns, marketing plan)
//      zodat re-runs en partial completions schoon werken.
//   2. Read methods voor stage 4 (heeft brand voice + patterns nodig)
//      en voor de dashboard / API surface.
//   3. Onboarding context loader (uit tenants tabel) als helper.
//
// Alle queries draaien met allowNoTenant: true want Day Zero is
// een cross-tenant worker context (geen AsyncLocalStorage scope).
// RLS wordt op service_role-niveau gepasseerd.
// ============================================================

import { db } from '../../../infrastructure/database/connection';
import { logger } from '../../../shared/logging/logger';
import {
  BaselineMarketingPlanRow,
  BrandVoice,
  Patterns,
  MarketingPlan,
  OnboardingContext,
} from '../types/baseline-plan.types';

// ── UPSERT helpers ───────────────────────────────────────────

export interface UpsertBrandVoiceInput {
  tenantId:     string;
  brandVoice:   BrandVoice;
  model:        string;
  inputTokens:  number;
  outputTokens: number;
}

export async function upsertBrandVoice(input: UpsertBrandVoiceInput): Promise<void> {
  await db.query(
    `INSERT INTO baseline_marketing_plans (
       tenant_id,
       brand_voice, brand_voice_model,
       brand_voice_input_tokens, brand_voice_output_tokens,
       brand_voice_generated_at
     ) VALUES ($1, $2::jsonb, $3, $4, $5, now())
     ON CONFLICT (tenant_id) DO UPDATE SET
       brand_voice               = EXCLUDED.brand_voice,
       brand_voice_model         = EXCLUDED.brand_voice_model,
       brand_voice_input_tokens  = EXCLUDED.brand_voice_input_tokens,
       brand_voice_output_tokens = EXCLUDED.brand_voice_output_tokens,
       brand_voice_generated_at  = now(),
       updated_at                = now()`,
    [
      input.tenantId,
      JSON.stringify(input.brandVoice),
      input.model,
      input.inputTokens,
      input.outputTokens,
    ],
    { allowNoTenant: true }
  );
}

export interface UpsertPatternsInput {
  tenantId:     string;
  patterns:     Patterns;
  model:        string;
  inputTokens:  number;
  outputTokens: number;
}

export async function upsertPatterns(input: UpsertPatternsInput): Promise<void> {
  await db.query(
    `INSERT INTO baseline_marketing_plans (
       tenant_id,
       patterns, patterns_model,
       patterns_input_tokens, patterns_output_tokens,
       patterns_generated_at
     ) VALUES ($1, $2::jsonb, $3, $4, $5, now())
     ON CONFLICT (tenant_id) DO UPDATE SET
       patterns               = EXCLUDED.patterns,
       patterns_model         = EXCLUDED.patterns_model,
       patterns_input_tokens  = EXCLUDED.patterns_input_tokens,
       patterns_output_tokens = EXCLUDED.patterns_output_tokens,
       patterns_generated_at  = now(),
       updated_at             = now()`,
    [
      input.tenantId,
      JSON.stringify(input.patterns),
      input.model,
      input.inputTokens,
      input.outputTokens,
    ],
    { allowNoTenant: true }
  );
}

export interface UpsertMarketingPlanInput {
  tenantId:       string;
  marketingPlan:  MarketingPlan;
  model:          string;
  inputTokens:    number;
  outputTokens:   number;
}

export async function upsertMarketingPlan(input: UpsertMarketingPlanInput): Promise<void> {
  await db.query(
    `INSERT INTO baseline_marketing_plans (
       tenant_id,
       marketing_plan, plan_model,
       plan_input_tokens, plan_output_tokens,
       plan_generated_at
     ) VALUES ($1, $2::jsonb, $3, $4, $5, now())
     ON CONFLICT (tenant_id) DO UPDATE SET
       marketing_plan      = EXCLUDED.marketing_plan,
       plan_model          = EXCLUDED.plan_model,
       plan_input_tokens   = EXCLUDED.plan_input_tokens,
       plan_output_tokens  = EXCLUDED.plan_output_tokens,
       plan_generated_at   = now(),
       updated_at          = now()`,
    [
      input.tenantId,
      JSON.stringify(input.marketingPlan),
      input.model,
      input.inputTokens,
      input.outputTokens,
    ],
    { allowNoTenant: true }
  );
}

// ── Read helpers ─────────────────────────────────────────────

export async function getBrandVoice(tenantId: string): Promise<BrandVoice | null> {
  const result = await db.query<{ brand_voice: BrandVoice | Record<string, never> }>(
    `SELECT brand_voice FROM baseline_marketing_plans WHERE tenant_id = $1`,
    [tenantId],
    { allowNoTenant: true }
  );
  const row = result.rows[0];
  if (!row || !row.brand_voice || Object.keys(row.brand_voice).length === 0) {
    return null;
  }
  return row.brand_voice as BrandVoice;
}

export async function getPatterns(tenantId: string): Promise<Patterns | null> {
  const result = await db.query<{ patterns: Patterns | Record<string, never> }>(
    `SELECT patterns FROM baseline_marketing_plans WHERE tenant_id = $1`,
    [tenantId],
    { allowNoTenant: true }
  );
  const row = result.rows[0];
  if (!row || !row.patterns || Object.keys(row.patterns).length === 0) {
    return null;
  }
  return row.patterns as Patterns;
}

export async function getFullPlan(tenantId: string): Promise<BaselineMarketingPlanRow | null> {
  const result = await db.query<BaselineMarketingPlanRow>(
    `SELECT * FROM baseline_marketing_plans WHERE tenant_id = $1`,
    [tenantId],
    { allowNoTenant: true }
  );
  return result.rows[0] ?? null;
}

// ── Onboarding context loader ────────────────────────────────
// Hoort technisch niet hier, maar voor V0 simpel: alle DB reads
// die Day Zero nodig heeft staan in deze repository.

export async function loadOnboardingContext(tenantId: string): Promise<OnboardingContext> {
  const result = await db.query<{
    country_code:        string | null;
    sells_to_countries:  string[] | null;
    business_goal:       string | null;
    marketing_style:     string | null;
  }>(
    `SELECT country_code, sells_to_countries, business_goal, marketing_style
     FROM tenants
     WHERE id = $1`,
    [tenantId],
    { allowNoTenant: true }
  );

  const row = result.rows[0];
  if (!row) {
    logger.warn('day_zero.onboarding_context.tenant_not_found', { tenantId });
    return {
      countryCode:      null,
      sellsToCountries: null,
      businessGoal:     null,
      marketingStyle:   null,
    };
  }

  return {
    countryCode:      row.country_code,
    sellsToCountries: row.sells_to_countries,
    businessGoal:     row.business_goal,
    marketingStyle:   row.marketing_style,
  };
}
