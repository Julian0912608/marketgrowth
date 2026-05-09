// ============================================================
// src/modules/briefings/types/briefings.types.ts
//
// Types voor de daily briefing module. Briefings worden
// gepersisteerd in tenant_briefings (migration 026) en
// gegenereerd door briefings.service.ts met memory injection.
// ============================================================

export type BriefingActionPriority = 'high' | 'medium' | 'low';
export type BriefingActionChannel  =
  | 'meta_ads'
  | 'google_ads'
  | 'organic_social'
  | 'email'
  | 'seo'
  | 'general';

export type BriefingGeneratedVia =
  | 'on_demand'
  | 'email_cron'
  | 'day_zero_seed'
  | 'admin';

export interface BriefingAction {
  priority:    BriefingActionPriority;
  title:       string;
  description: string;
  channel:     string;     // free-form maar gevalideerd waar mogelijk tegen channels lijst
}

// Pure AI output payload
export interface BriefingPayload {
  briefing: string;
  actions:  BriefingAction[];
  alerts:   string[];
}

// DB row shape (1:1 met tenant_briefings tabel)
export interface BriefingRow {
  id:            string;
  tenant_id:     string;
  briefing_date: string;     // YYYY-MM-DD via ::text cast
  briefing_text: string;
  actions:       BriefingAction[];
  alerts:        string[];
  model:         string;
  input_tokens:  number;
  output_tokens: number;
  memories_used: number;
  generated_via: BriefingGeneratedVia;
  created_at:    Date;
  updated_at:    Date;
}

export interface UpsertBriefingInput {
  tenantId:     string;
  briefingDate: string;         // YYYY-MM-DD
  briefingText: string;
  actions:      BriefingAction[];
  alerts:       string[];
  model:        string;
  inputTokens:  number;
  outputTokens: number;
  memoriesUsed: number;
  generatedVia: BriefingGeneratedVia;
}

// Service result voor /api/ai/insights en email cron
export interface GenerateBriefingResult extends BriefingPayload {
  briefingDate: string;
  model:        string;
  inputTokens:  number;
  outputTokens: number;
  memoriesUsed: number;
  generatedVia: BriefingGeneratedVia;
  fromCache:    boolean;        // true = uit DB gehaald (vandaag al gegenereerd)
}
