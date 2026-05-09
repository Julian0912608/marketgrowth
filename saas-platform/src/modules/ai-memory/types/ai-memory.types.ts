// ============================================================
// src/modules/ai-memory/types/ai-memory.types.ts
//
// Types voor de AI Memory v1 laag (Gap 3c).
// Master Plan v3.1 §9 + Architecture Plan §AI Pipeline Layer 1.
// ============================================================

export type MemoryKind =
  | 'brand_voice'
  | 'pattern_insight'
  | 'plan_positioning'
  | 'plan_focus'
  | 'target_audience'
  | 'channel_priority'
  | 'content_angle'
  | 'onboarding_fact'
  | 'briefing_outcome';     // V1: briefing -> action -> outcome tracking

// Input voor insert (zonder embedding, die wordt extern berekend)
export interface AiMemoryInput {
  tenantId:   string;
  kind:       MemoryKind;
  content:    string;
  metadata?:  Record<string, unknown>;
  sourceRef?: string;
}

// DB row shape (1:1 met ai_memories tabel)
export interface AiMemoryRow {
  id:         string;
  tenant_id:  string;
  kind:       MemoryKind;
  content:    string;
  metadata:   Record<string, unknown>;
  source_ref: string | null;
  created_at: Date;
  updated_at: Date;
}

// Search result voor memory injection (geen embedding meegestuurd om payload klein te houden)
export interface MemorySearchResult {
  id:         string;
  kind:       MemoryKind;
  content:    string;
  metadata:   Record<string, unknown>;
  source_ref: string | null;
  similarity: number;     // cosine similarity, 0..1, hoger = relevanter
}
