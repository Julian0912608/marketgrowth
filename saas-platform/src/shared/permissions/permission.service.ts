// ============================================================
// src/shared/permissions/permission.service.ts
//
// THE single source of truth for feature access control.
// Every module asks here before doing anything feature-gated.
// Never check plan/feature access anywhere else.
// ============================================================

import { db } from '../../infrastructure/database/connection';
import { cache } from '../../infrastructure/cache/redis';
import { logger } from '../logging/logger';
import {
  FeatureSlug,
  FeatureAction,
  PermissionCheckRequest,
  PermissionCheckResult,
  PlanSlug,
} from '../types/tenant';

// Plan hierarchy — higher index = more access
const PLAN_HIERARCHY: PlanSlug[] = ['starter', 'growth', 'scale'];

// Cache TTL for permission results (1 hour)
const PERMISSION_CACHE_TTL = 3600;

class PermissionService {
  // ─── Main Check ─────────────────────────────────────────────
  async check(request: PermissionCheckRequest): Promise<PermissionCheckResult> {
    const { tenantId, feature } = request;

    logger.debug('permission.check', { tenantId, feature, action: request.action });

    // 1. Check for explicit account-level override first
    const override = await this.getOverride(tenantId, feature);
    if (override !== null) {
      logger.info('permission.override_applied', { tenantId, feature, granted: override });
      return { allowed: override, reason: override ? 'account_override_grant' : 'account_override_revoke' };
    }

    // 2. Get tenant's current plan
    const planSlug = await this.getTenantPlan(tenantId);

    // 3. Check if this plan includes the feature
    const planAllows = await this.planIncludesFeature(planSlug, feature);

    if (!planAllows) {
      // Find the minimum plan that grants access (for upgrade prompts)
      const requiredPlan = await this.getMinimumRequiredPlan(feature);
      logger.info('permission.denied', { tenantId, feature, planSlug, requiredPlan });
      return {
        allowed: false,
        reason: 'plan_insufficient',
        requiredPlan,
      };
    }

    // 4. For metered features: check usage limits
    const isMetered = await this.isMeteredFeature(feature);
    if (isMetered) {
      const usageCheck = await this.checkUsageLimit(tenantId, planSlug, feature);
      if (!usageCheck.allowed) {
        return usageCheck;
      }
      return { allowed: true, usageRemaining: usageCheck.usageRemaining };
    }

    return { allowed: true };
  }

  // ─── Increment usage (call after successful metered action) ──
  async incrementUsage(tenantId: string, feature: FeatureSlug): Promise<void> {
    const now = new Date();
    const periodStart = new Date(now.getFullYear(), now.getMonth(), 1);   // first of month
    const periodEnd = new Date(now.getFullYear(), now.getMonth() + 1, 0); // last of month

    await db.query(
      `INSERT INTO feature_usage (tenant_id, feature_id, period_start, period_end, usage_count)
       SELECT $1, f.id, $2, $3, 1
       FROM features f WHERE f.slug = $4
       ON CONFLICT (tenant_id, feature_id, period_start)
       DO UPDATE SET usage_count = feature_usage.usage_count + 1,
                     updated_at  = now()`,
      [tenantId, periodStart, periodEnd, feature]
    );

    // Invalidate the usage cache for this tenant+feature
    await cache.del(`perm:usage:${tenantId}:${feature}`);

    logger.info('permission.usage_incremented', { tenantId, feature });
  }

  // ─── Invalidate cache when plan changes ─────────────────────
  async invalidateTenantCache(tenantId: string): Promise<void> {
    await cache.del(`perm:plan:${tenantId}`);
    logger.info('permission.cache_invalidated', { tenantId });
  }

  // ─── Private helpers ─────────────────────────────────────────

  private async getTenantPlan(tenantId: string): Promise<PlanSlug> {
    const cacheKey = `perm:plan:${tenantId}`;
    const cached = await cache.get(cacheKey);
    if (cached) return cached as PlanSlug;

    const result = await db.query<{ plan_slug: PlanSlug }>(
      `SELECT p.slug AS plan_slug
       FROM tenant_subscriptions ts
       JOIN plans p ON p.id = ts.plan_id
       WHERE ts.tenant_id = $1
         AND ts.status IN ('active', 'trialing')
       ORDER BY ts.created_at DESC
       LIMIT 1`,
      [tenantId],
      { allowNoTenant: true }   // this query uses explicit param, not RLS
    );

    const planSlug = result.rows[0]?.plan_slug ?? 'starter';
    await cache.set(cacheKey, planSlug, PERMISSION_CACHE_TTL);
    return planSlug;
  }

  private async planIncludesFeature(planSlug: PlanSlug, feature: FeatureSlug): Promise<boolean> {
    const cacheKey = `perm:plan_feature:${planSlug}:${feature}`;
    const cached = await cache.get(cacheKey);
    if (cached !== null) return cached === 'true';

    const result = await db.query<{ count: string }>(
      `SELECT COUNT(*) AS count
       FROM plan_features pf
       JOIN plans p ON p.id = pf.plan_id
       JOIN features f ON f.id = pf.feature_id
       WHERE p.slug = $1 AND f.slug = $2`,
      [planSlug, feature],
      { allowNoTenant: true }
    );

    const allowed = parseInt(result.rows[0].count) > 0;
    await cache.set(cacheKey, String(allowed), PERMISSION_CACHE_TTL);
    return allowed;
  }

  private async getOverride(tenantId: string, feature: FeatureSlug): Promise<boolean | null> {
    const result = await db.query<{ granted: boolean; expires_at: Date | null }>(
      `SELECT afo.granted, afo.expires_at
       FROM account_feature_overrides afo
       JOIN features f ON f.id = afo.feature_id
       WHERE afo.tenant_id = $1
         AND f.slug = $2
         AND (afo.expires_at IS NULL OR afo.expires_at > now())`,
      [tenantId, feature],
      { allowNoTenant: true }
    );

    return result.rows[0]?.granted ?? null;
  }

  private async isMeteredFeature(feature: FeatureSlug): Promise<boolean> {
    const result = await db.query<{ is_metered: boolean }>(
      `SELECT is_metered FROM features WHERE slug = $1`,
      [feature],
      { allowNoTenant: true }
    );
    return result.rows[0]?.is_metered ?? false;
  }

  private async checkUsageLimit(
    tenantId: string,
    planSlug: PlanSlug,
    feature: FeatureSlug
  ): Promise<PermissionCheckResult> {
    const cacheKey = `perm:usage:${tenantId}:${feature}`;

    // Get the limit for this plan+feature
    const limitResult = await db.query<{ limit_value: number | null }>(
      `SELECT ul.limit_value
       FROM usage_limits ul
       JOIN plans p ON p.id = ul.plan_id
       JOIN features f ON f.id = ul.feature_id
       WHERE p.slug = $1 AND f.slug = $2 AND ul.limit_type = 'monthly'`,
      [planSlug, feature],
      { allowNoTenant: true }
    );

    const limit = limitResult.rows[0]?.limit_value;
    if (limit === null || limit === undefined) {
      return { allowed: true };  // unlimited
    }

    // Get current month usage
    const usageResult = await db.query<{ usage_count: number }>(
      `SELECT COALESCE(fu.usage_count, 0) AS usage_count
       FROM feature_usage fu
       JOIN features f ON f.id = fu.feature_id
       WHERE fu.tenant_id = $1
         AND f.slug = $2
         AND fu.period_start = date_trunc('month', now())`,
      [tenantId, feature],
      { allowNoTenant: true }
    );

    const used = usageResult.rows[0]?.usage_count ?? 0;
    const remaining = limit - used;

    if (remaining <= 0) {
      return {
        allowed: false,
        reason: 'usage_limit_reached',
        usageRemaining: 0,
      };
    }

    return { allowed: true, usageRemaining: remaining };
  }

  private async getMinimumRequiredPlan(feature: FeatureSlug): Promise<PlanSlug | undefined> {
    const result = await db.query<{ plan_slug: PlanSlug }>(
      `SELECT p.slug AS plan_slug
       FROM plan_features pf
       JOIN plans p ON p.id = pf.plan_id
       JOIN features f ON f.id = pf.feature_id
       WHERE f.slug = $1
       ORDER BY ARRAY_POSITION(ARRAY['starter','growth','scale'], p.slug)
       LIMIT 1`,
      [feature],
      { allowNoTenant: true }
    );
    return result.rows[0]?.plan_slug;
  }
}

export const permissionService = new PermissionService();
