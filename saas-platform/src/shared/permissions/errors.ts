// ============================================================
// src/shared/permissions/errors.ts
//
// Thrown when a feature is not available on the current plan.
// The frontend uses requiredPlan to show the correct upgrade prompt.
// ============================================================

import { FeatureSlug, PlanSlug } from '../types/tenant';

export class FeatureNotAvailableError extends Error {
  public readonly feature: FeatureSlug;
  public readonly requiredPlan?: PlanSlug;
  public readonly httpStatus = 403;

  constructor(feature: FeatureSlug, requiredPlan?: PlanSlug) {
    super(`Feature '${feature}' is not available on your current plan.`);
    this.name = 'FeatureNotAvailableError';
    this.feature = feature;
    this.requiredPlan = requiredPlan;
  }
}

export class UsageLimitReachedError extends Error {
  public readonly feature: FeatureSlug;
  public readonly httpStatus = 429;

  constructor(feature: FeatureSlug) {
    super(`Monthly usage limit reached for feature '${feature}'.`);
    this.name = 'UsageLimitReachedError';
    this.feature = feature;
  }
}
