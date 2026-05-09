// ============================================================
// src/modules/onboarding/service/onboarding.service.ts
//
// Business logic voor de 4-stappen onboarding wizard.
//
// Beslissingen vanuit Master Plan v3.1 + Julian:
//   - Step 1 is hard required (country drives feature flags)
//   - Skip vanaf Step 2 = all-or-nothing (status 'skipped')
//   - Settings biedt later edit (updateProfileFields)
//   - Cache invalidatie na country change: tenant context + flags
//   - Auto-completion: skipped tenant -> completed zodra alle 4
//     velden gevuld zijn via updateProfileFields. Zorgt dat de
//     StartSetupCard automatisch verdwijnt na Business tab save.
//
// Day Zero AI setup: voor Gap 2 leveren we alleen een log-stub.
// Volledige BullMQ implementatie volgt in Gap 3.
// ============================================================

import { logger } from '../../../shared/logging/logger';
import {
  OnboardingRepository,
  onboardingRepository,
} from '../repository/onboarding.repository';
import { featureFlagsService } from '../../feature-flags/service/feature-flags.service';
import { invalidateTenantContextCache } from '../../../shared/middleware/tenant.middleware';
import {
  OnboardingState,
  Step1Input,
  Step2Input,
  Step3Input,
  CompleteInput,
  UpdateProfileInput,
  StepResult,
  CompleteResult,
} from '../types/onboarding.types';

export class OnboardingService {
  constructor(
    private readonly repo: OnboardingRepository = onboardingRepository,
  ) {}

  async getState(tenantId: string): Promise<OnboardingState> {
    const state = await this.repo.getState(tenantId);
    if (!state) {
      throw new Error(`Tenant not found: ${tenantId}`);
    }
    return state;
  }

  async saveStep1(tenantId: string, input: Step1Input): Promise<StepResult> {
    const current = await this.repo.getState(tenantId);
    if (!current) throw new Error(`Tenant not found: ${tenantId}`);
    if (current.status === 'completed') {
      throw new Error('Onboarding already completed. Use settings to edit.');
    }

    await this.repo.saveStep1(
      tenantId,
      input.countryCode,
      input.sellsToCountries,
    );

    await Promise.all([
      invalidateTenantContextCache(tenantId),
      featureFlagsService.invalidateAll(),
    ]);

    logger.info('onboarding.step1.saved', {
      tenantId,
      countryCode:  input.countryCode,
      sellsToCount: input.sellsToCountries.length,
    });

    return { ok: true, status: 'in_progress', nextStep: 2 };
  }

  async saveStep2(tenantId: string, input: Step2Input): Promise<StepResult> {
    const current = await this.repo.getState(tenantId);
    if (!current) throw new Error(`Tenant not found: ${tenantId}`);
    if (current.status === 'completed') {
      throw new Error('Onboarding already completed. Use settings to edit.');
    }
    if (!current.countryCode) {
      throw new Error('Step 1 must be completed first.');
    }

    await this.repo.saveStep2(tenantId, input.businessGoal);

    logger.info('onboarding.step2.saved', {
      tenantId,
      businessGoal: input.businessGoal,
    });

    return { ok: true, status: 'in_progress', nextStep: 3 };
  }

  async saveStep3(tenantId: string, input: Step3Input): Promise<StepResult> {
    const current = await this.repo.getState(tenantId);
    if (!current) throw new Error(`Tenant not found: ${tenantId}`);
    if (current.status === 'completed') {
      throw new Error('Onboarding already completed. Use settings to edit.');
    }
    if (!current.countryCode) {
      throw new Error('Step 1 must be completed first.');
    }

    await this.repo.saveStep3(tenantId, input.marketingStyle);

    logger.info('onboarding.step3.saved', {
      tenantId,
      marketingStyle: input.marketingStyle,
    });

    return { ok: true, status: 'in_progress', nextStep: 4 };
  }

  async complete(tenantId: string, input: CompleteInput): Promise<CompleteResult> {
    const current = await this.repo.getState(tenantId);
    if (!current) throw new Error(`Tenant not found: ${tenantId}`);
    if (!current.countryCode) {
      throw new Error('Step 1 must be completed first.');
    }
    if (current.status === 'completed') {
      return { ok: true, status: 'completed' };
    }

    await this.repo.markCompleted(tenantId);

    logger.info('onboarding.completed', {
      tenantId,
      shopConnected: input.shopConnected,
    });

    let dayZeroJobId: string | undefined;
    if (input.shopConnected) {
      dayZeroJobId = `day-zero:${tenantId}:${Date.now()}`;
      logger.info('onboarding.day_zero.queued_stub', {
        tenantId,
        dayZeroJobId,
        note: 'Stub. Real BullMQ job ships in Gap 3.',
      });
    }

    return { ok: true, status: 'completed', dayZeroJobId };
  }

  async skip(tenantId: string): Promise<StepResult> {
    const current = await this.repo.getState(tenantId);
    if (!current) throw new Error(`Tenant not found: ${tenantId}`);
    if (!current.countryCode) {
      throw new Error('Cannot skip before step 1 is completed.');
    }
    if (current.status !== 'in_progress') {
      throw new Error('Onboarding is not in progress.');
    }

    await this.repo.markSkipped(tenantId);

    logger.info('onboarding.skipped', {
      tenantId,
      stepWhenSkipped: current.step,
    });

    return { ok: true, status: 'skipped' };
  }

  // Edits via Settings, beschikbaar na completed of skipped status.
  // Bij country wijziging worden de caches opnieuw leeggemaakt.
  // AUTO-COMPLETION: als de tenant op 'skipped' stond en met deze
  // edit alle 4 velden gevuld zijn, transition automatisch naar
  // 'completed'. Zo verdwijnt de StartSetupCard zonder dat de
  // user een aparte "Mark as complete" knop hoeft te klikken.
  async updateProfileFields(
    tenantId: string,
    fields: UpdateProfileInput,
  ): Promise<OnboardingState> {
    await this.repo.updateProfile(tenantId, fields);

    if (fields.countryCode !== undefined) {
      await Promise.all([
        invalidateTenantContextCache(tenantId),
        featureFlagsService.invalidateAll(),
      ]);
    }

    let state = await this.getState(tenantId);

    if (state.status === 'skipped' && this.isProfileComplete(state)) {
      await this.repo.markCompleted(tenantId);
      logger.info('onboarding.auto_completed', { tenantId });
      state = await this.getState(tenantId);
    }

    logger.info('onboarding.profile_updated', {
      tenantId,
      fieldsUpdated: Object.keys(fields),
      finalStatus:   state.status,
    });

    return state;
  }

  private isProfileComplete(state: OnboardingState): boolean {
    return Boolean(
      state.countryCode &&
      state.sellsToCountries &&
      state.sellsToCountries.length > 0 &&
      state.businessGoal &&
      state.marketingStyle,
    );
  }
}

export const onboardingService = new OnboardingService();
