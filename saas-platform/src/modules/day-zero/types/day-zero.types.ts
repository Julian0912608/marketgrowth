// ============================================================
// src/modules/day-zero/types/day-zero.types.ts
//
// Types voor Day Zero AI setup (Architecture Plan §6 Gap 3).
// 5 stages, 15 minuten background job, draait via BullMQ.
// ============================================================

export type DayZeroStatus = 'pending' | 'running' | 'completed' | 'failed';

export type DayZeroStage = 0 | 1 | 2 | 3 | 4 | 5;

export const STAGE_NAMES: Record<DayZeroStage, string> = {
  0: 'pending',
  1: 'ingestion',
  2: 'brand_voice',
  3: 'pattern_detection',
  4: 'plan_generation',
  5: 'finalize',
};

export const STAGE_DURATIONS_SEC: Record<DayZeroStage, number> = {
  0: 0,
  1: 120,   // 0:00 -> 0:02
  2: 300,   // 0:02 -> 0:07
  3: 300,   // 0:07 -> 0:12
  4: 180,   // 0:12 -> 0:15
  5: 30,    // finalize
};

// ----------------------------------------------------------------
// Stage outputs (opgeslagen in stage_data JSONB)
// ----------------------------------------------------------------

export interface Stage1IngestionOutput {
  integrations: Array<{
    id:           string;
    platform:     string;       // 'shopify' | 'bol' | etc
    shop_name:    string | null;
    shop_country: string;
    synced_at:    string | null;
  }>;
  orders_12m: {
    count:              number;
    revenue_excl_vat:   number;
    revenue_incl_vat:   number;
    first_order_at:     string | null;
    last_order_at:      string | null;
    by_status:          Record<string, number>;
    by_platform:        Record<string, number>;
    avg_order_value:    number | null;
  };
  products: {
    count:              number;
    active:             number;
    with_description:   number;
    with_image:         number;
    avg_price_excl_vat: number | null;
  };
  customers: {
    count:           number;
    with_orders:     number;
    high_ltv_count:  number;     // top 10% by total_spent
    repeat_count:    number;     // order_count > 1
  };
  ingestion_completed_at: string;
  warnings:               string[];
}

export interface Stage2BrandVoiceOutput { /* sprint 3b */ }
export interface Stage3PatternsOutput   { /* sprint 3b */ }
export interface Stage4PlanOutput       { /* sprint 3b */ }
export interface Stage5FinalizeOutput   { /* sprint 3b */ }

export interface DayZeroStageData {
  stage_1?: Stage1IngestionOutput;
  stage_2?: Stage2BrandVoiceOutput;
  stage_3?: Stage3PatternsOutput;
  stage_4?: Stage4PlanOutput;
  stage_5?: Stage5FinalizeOutput;
}

// ----------------------------------------------------------------
// DB row shape
// ----------------------------------------------------------------

export interface DayZeroProgressRow {
  tenant_id:      string;
  status:         DayZeroStatus;
  current_stage:  DayZeroStage;
  stage_data:     DayZeroStageData;
  error_message:  string | null;
  error_stage:    DayZeroStage | null;
  error_count:    number;
  started_at:     string | null;
  completed_at:   string | null;
  created_at:     string;
  updated_at:     string;
}

// ----------------------------------------------------------------
// Public API DTOs (voor /dashboard/setup polling)
// ----------------------------------------------------------------

export interface DayZeroStatusDTO {
  status:           DayZeroStatus;
  current_stage:    DayZeroStage;
  current_stage_name: string;
  progress_percent: number;          // 0-100
  eta_seconds:      number | null;
  started_at:       string | null;
  completed_at:     string | null;
  error_message:    string | null;
}

// ----------------------------------------------------------------
// Queue job payload
// ----------------------------------------------------------------

export interface DayZeroJobData {
  tenantId:  string;
  stage:     DayZeroStage;     // welke stage te runnen (1..5)
  attempt?:  number;
}

export type TenantPlan = 'starter' | 'growth' | 'scale';

// BullMQ priority: lager getal = hogere prio
export const PLAN_PRIORITY: Record<TenantPlan, number> = {
  scale:   1,
  growth:  2,
  starter: 3,
};
