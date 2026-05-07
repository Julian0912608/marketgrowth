// ============================================================
// src/shared/types/tenant.ts
// Core types used across the entire platform
//
// V0 Gap 1 update: countryCode toegevoegd aan TenantContext.
// Tenant interface uitgebreid met country_code, sells_to_countries,
// business_goal, marketing_style.
// ============================================================

export type PlanSlug = 'starter' | 'growth' | 'scale';

export type FeatureSlug =
  | 'sales-dashboard'
  | 'order-analytics'
  | 'ai-recommendations'
  | 'ad-analytics'
  | 'ai-ad-optimization'
  | 'customer-ltv'
  | 'multi-shop'
  | 'report-export'
  | 'api-access'
  | 'white-label'
  | 'team-accounts';

export type FeatureAction = 'view' | 'create' | 'export' | 'delete';

export type BusinessGoal   = 'lifestyle' | 'steady' | 'scale-to-exit' | 'side-project';
export type MarketingStyle = 'paid' | 'organic' | 'mix';

// The tenant context that travels with every request
export interface TenantContext {
  tenantId:         string;
  tenantSlug:       string;
  userId:           string;
  planSlug:         PlanSlug;
  countryCode:      string | null;   // ISO 3166-1 alpha-2, null als niet ingesteld
  traceId:          string;
  requestStartedAt: Date;
}

export interface Tenant {
  id:               string;
  name:             string;
  slug:             string;
  email:            string;
  status:           'active' | 'suspended' | 'cancelled';
  countryCode:      string | null;
  sellsToCountries: string[] | null;
  businessGoal:     BusinessGoal | null;
  marketingStyle:   MarketingStyle | null;
  createdAt:        Date;
  updatedAt:        Date;
}

export interface Plan {
  id:            string;
  slug:          PlanSlug;
  name:          string;
  stripePriceId: string | null;
  isActive:      boolean;
}

export interface TenantSubscription {
  id:                 string;
  tenantId:           string;
  planId:             string;
  planSlug:           PlanSlug;
  status:             'active' | 'trialing' | 'past_due' | 'cancelled';
  currentPeriodStart: Date;
  currentPeriodEnd:   Date;
}

// Permission check request
export interface PermissionCheckRequest {
  tenantId: string;
  feature:  FeatureSlug;
  action?:  FeatureAction;
}

// Permission check result
export interface PermissionCheckResult {
  allowed:         boolean;
  reason?:         string;
  requiredPlan?:   PlanSlug;
  usageRemaining?: number;
}
