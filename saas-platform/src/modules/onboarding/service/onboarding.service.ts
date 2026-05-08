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
      // Edits gaan via Settings, niet via wizard
      throw new Error('Onboarding already completed. Use settings to edit.');
    }

    await this.repo.saveStep1(
      tenantId,
      input.countryCode,
      input.sellsToCountries,
    );

    // Country gewijzigd: tenant context cache + feature flags cache
    // moeten beide leeg, anders ziet user op step 4 nog flags voor
    // de oude country.
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
      // Hard force: step 1 moet eerst gebeuren
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

  // Wordt aangeroepen na step 4 (store connected of "I'll connect later").
  // Idempotent: dubbele calls geven gewoon de huidige state terug.
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

    // Day Zero AI setup trigger.
    // Gap 2 sprint: alleen een log-stub. Echte BullMQ job in Gap 3.
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

  // Skip vanaf step 2 (all-or-nothing). Step 1 kan niet geskipt worden.
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

    logger.info('onboarding.profile_updated', {
      tenantId,
      fieldsUpdated: Object.keys(fields),
    });

    return this.getState(tenantId);
  }
}

export const onboardingService = new OnboardingService();
