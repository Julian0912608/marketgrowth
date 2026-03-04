// ============================================================
// src/modules/onboarding/repository/onboarding.repository.ts
// ============================================================

import { db } from '../../../infrastructure/database/connection';
import { OnboardingStep } from '../service/onboarding.service';

export class OnboardingRepository {
  async getProgress(tenantId: string) {
    const result = await db.query<{
      current_step: string;
      completed_steps: string[];
      completed_at: Date | null;
    }>(
      `SELECT current_step, completed_steps, completed_at
       FROM onboarding_progress
       WHERE tenant_id = $1`,
      [tenantId], { allowNoTenant: true }
    );

    // Als er nog geen progress is: initialiseer
    if (!result.rows[0]) {
      await db.query(
        `INSERT INTO onboarding_progress (tenant_id, current_step, completed_steps)
         VALUES ($1, 'account_created', ARRAY['account_created'])
         ON CONFLICT (tenant_id) DO NOTHING`,
        [tenantId], { allowNoTenant: true }
      );
      return { current_step: 'account_created', completed_steps: ['account_created'], completed_at: null };
    }

    return result.rows[0];
  }

  async updateProgress(tenantId: string, update: { completedStep: OnboardingStep; nextStep: OnboardingStep }): Promise<void> {
    await db.query(
      `UPDATE onboarding_progress
       SET current_step    = $2,
           completed_steps = array_append(completed_steps, $3::text),
           updated_at      = now()
       WHERE tenant_id = $1`,
      [tenantId, update.nextStep, update.completedStep],
      { allowNoTenant: true }
    );
  }
}
