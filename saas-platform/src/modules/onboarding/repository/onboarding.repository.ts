// ============================================================
// src/modules/onboarding/repository/onboarding.repository.ts
//
// Enige plek die de onboarding-kolommen op tenants leest/schrijft.
// Plus een afgeleide check op tenant_integrations voor shopConnected.
//
// Schema verifiable via:
//   SELECT column_name FROM information_schema.columns
//   WHERE table_schema = 'public' AND table_name = 'tenants';
//
// Vereiste kolommen (post-migration onboarding_wizard_tenant_columns):
//   country_code TEXT NULL
//   sells_to_countries TEXT[] NULL
//   business_goal TEXT NULL
//   marketing_style TEXT NULL
//   onboarding_status TEXT NOT NULL DEFAULT 'in_progress'
//   onboarding_step SMALLINT NOT NULL DEFAULT 1
//   onboarding_completed_at TIMESTAMPTZ NULL
// ============================================================

import { db } from '../../../infrastructure/database/connection';
import {
  OnboardingState,
  OnboardingStatus,
  OnboardingStep,
  CountryCode,
  SellsToCode,
  UpdateProfileInput,
} from '../types/onboarding.types';
import { BusinessGoal, MarketingStyle } from '../../../shared/types/tenant';

interface OnboardingRow {
  onboarding_status:       OnboardingStatus;
  onboarding_step:         number;
  onboarding_completed_at: Date | null;
  country_code:            string | null;
  sells_to_countries:      string[] | null;
  business_goal:           string | null;
  marketing_style:         string | null;
  shop_connected:          boolean;
}

export class OnboardingRepository {

  // Haal complete state op. shop_connected wordt afgeleid uit
  // tenant_integrations met status = 'active'.
  async getState(tenantId: string): Promise<OnboardingState | null> {
    const result = await db.query<OnboardingRow>(
      `SELECT
         t.onboarding_status,
         t.onboarding_step,
         t.onboarding_completed_at,
         t.country_code,
         t.sells_to_countries,
         t.business_goal,
         t.marketing_style,
         EXISTS (
           SELECT 1 FROM tenant_integrations ti
           WHERE ti.tenant_id = t.id
             AND ti.status = 'active'
         ) AS shop_connected
       FROM tenants t
       WHERE t.id = $1
       LIMIT 1`,
      [tenantId]
    );

    if (result.rows.length === 0) return null;

    const row = result.rows[0];
    return {
      status:           row.onboarding_status,
      step:             this.clampStep(row.onboarding_step),
      countryCode:      row.country_code as CountryCode | null,
      sellsToCountries: row.sells_to_countries as SellsToCode[] | null,
      businessGoal:     row.business_goal as BusinessGoal | null,
      marketingStyle:   row.marketing_style as MarketingStyle | null,
      shopConnected:    row.shop_connected,
      completedAt:      row.onboarding_completed_at?.toISOString() ?? null,
    };
  }

  // Step 1: country en sells-to.
  // GREATEST(step, 2) zorgt dat we de step nooit terugzetten als
  // user even terugbladert en opnieuw saved.
  async saveStep1(
    tenantId: string,
    countryCode: CountryCode,
    sellsToCountries: SellsToCode[],
  ): Promise<void> {
    await db.query(
      `UPDATE tenants
       SET country_code       = $2,
           sells_to_countries = $3,
           onboarding_step    = GREATEST(onboarding_step, 2),
           updated_at         = NOW()
       WHERE id = $1`,
      [tenantId, countryCode, sellsToCountries]
    );
  }

  async saveStep2(tenantId: string, businessGoal: BusinessGoal): Promise<void> {
    await db.query(
      `UPDATE tenants
       SET business_goal   = $2,
           onboarding_step = GREATEST(onboarding_step, 3),
           updated_at      = NOW()
       WHERE id = $1`,
      [tenantId, businessGoal]
    );
  }

  async saveStep3(tenantId: string, marketingStyle: MarketingStyle): Promise<void> {
    await db.query(
      `UPDATE tenants
       SET marketing_style = $2,
           onboarding_step = GREATEST(onboarding_step, 4),
           updated_at      = NOW()
       WHERE id = $1`,
      [tenantId, marketingStyle]
    );
  }

  async markCompleted(tenantId: string): Promise<void> {
    await db.query(
      `UPDATE tenants
       SET onboarding_status       = 'completed',
           onboarding_step         = 4,
           onboarding_completed_at = NOW(),
           updated_at              = NOW()
       WHERE id = $1`,
      [tenantId]
    );
  }

  // Skip vanaf step 2: status wordt 'skipped', step blijft staan
  // zodat Settings later precies weet welke velden nog leeg zijn.
  // Idempotent: alleen tenants in 'in_progress' worden geraakt.
  async markSkipped(tenantId: string): Promise<void> {
    await db.query(
      `UPDATE tenants
       SET onboarding_status       = 'skipped',
           onboarding_completed_at = NOW(),
           updated_at              = NOW()
       WHERE id = $1
         AND onboarding_status = 'in_progress'`,
      [tenantId]
    );
  }

  // Edits via Settings: 1 of meer velden tegelijk.
  // Dynamisch SET-statement met parameter-binding (geen string concat).
  async updateProfile(
    tenantId: string,
    fields: UpdateProfileInput,
  ): Promise<void> {
    const sets:   string[] = [];
    const params: unknown[] = [tenantId];

    if (fields.countryCode !== undefined) {
      params.push(fields.countryCode);
      sets.push(`country_code = $${params.length}`);
    }
    if (fields.sellsToCountries !== undefined) {
      params.push(fields.sellsToCountries);
      sets.push(`sells_to_countries = $${params.length}`);
    }
    if (fields.businessGoal !== undefined) {
      params.push(fields.businessGoal);
      sets.push(`business_goal = $${params.length}`);
    }
    if (fields.marketingStyle !== undefined) {
      params.push(fields.marketingStyle);
      sets.push(`marketing_style = $${params.length}`);
    }

    if (sets.length === 0) return;

    sets.push(`updated_at = NOW()`);

    await db.query(
      `UPDATE tenants SET ${sets.join(', ')} WHERE id = $1`,
      params
    );
  }

  private clampStep(raw: number): OnboardingStep {
    if (raw <= 1) return 1;
    if (raw === 2) return 2;
    if (raw === 3) return 3;
    return 4;
  }
}

export const onboardingRepository = new OnboardingRepository();
