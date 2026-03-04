// ============================================================
// src/shared/types/tenant.ts
// Core types used across the entire platform
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

// The tenant context that travels with every request
export interface TenantContext {
  tenantId: string;
  tenantSlug: string;
  userId: string;
  planSlug: PlanSlug;
  traceId: string;          // unique per request, for log correlation
  requestStartedAt: Date;
}

export interface Tenant {
  id: string;
  name: string;
  slug: string;
  email: string;
  status: 'active' | 'suspended' | 'cancelled';
  createdAt: Date;
  updatedAt: Date;
}

export interface Plan {
  id: string;
  slug: PlanSlug;
  name: string;
  stripePriceId: string | null;
  isActive: boolean;
}

export interface TenantSubscription {
  id: string;
  tenantId: string;
  planId: string;
  planSlug: PlanSlug;
  status: 'active' | 'trialing' | 'past_due' | 'cancelled';
  currentPeriodStart: Date;
  currentPeriodEnd: Date;
}

// Permission check request
export interface PermissionCheckRequest {
  tenantId: string;
  feature: FeatureSlug;
  action?: FeatureAction;
}

// Permission check result
export interface PermissionCheckResult {
  allowed: boolean;
  reason?: string;
  requiredPlan?: PlanSlug;   // set when denied — for upgrade prompts
  usageRemaining?: number;   // set for metered features
}
