// ============================================================
// src/modules/onboarding/service/onboarding.service.ts
// ============================================================

import { db } from '../../../infrastructure/database/connection';
import { getTenantContext } from '../../../shared/middleware/tenant-context';
import { eventBus } from '../../../shared/events/event-bus';
import { logger } from '../../../shared/logging/logger';
import { OnboardingRepository } from '../repository/onboarding.repository';

export type OnboardingStep =
  | 'account_created'
  | 'plan_selected'
  | 'payment_completed'
  | 'shop_connected'
  | 'completed';

export interface OnboardingStatus {
  currentStep:     OnboardingStep;
  completedSteps:  OnboardingStep[];
  percentComplete: number;
  isComplete:      boolean;
  nextAction: {
    step:        OnboardingStep;
    label:       string;
    description: string;
    url:         string;
  } | null;
}

const STEP_ORDER: OnboardingStep[] = [
  'account_created',
  'plan_selected',
  'payment_completed',
  'shop_connected',
  'completed',
];

const STEP_LABELS: Record<OnboardingStep, { label: string; description: string; url: string }> = {
  account_created:   { label: 'Account aangemaakt',   description: 'Account is aangemaakt',           url: '/onboarding' },
  plan_selected:     { label: 'Plan kiezen',           description: 'Kies het pakket dat bij je past', url: '/onboarding' },
  payment_completed: { label: 'Betaling instellen',    description: 'Voeg een betaalmethode toe',      url: '/onboarding' },
  shop_connected:    { label: 'Webshop koppelen',      description: 'Verbind je eerste webshop',       url: '/onboarding' },
  completed:         { label: 'Klaar!',                description: 'Je platform staat klaar',         url: '/dashboard' },
};

export class OnboardingService {
  constructor(private readonly repo = new OnboardingRepository()) {}

  async getStatus(): Promise<OnboardingStatus> {
    const { tenantId } = getTenantContext();
    const progress = await this.repo.getProgress(tenantId);

    const currentIndex    = STEP_ORDER.indexOf(progress.current_step as OnboardingStep);
    const percentComplete = Math.round((currentIndex / (STEP_ORDER.length - 1)) * 100);
    const isComplete      = progress.current_step === 'completed';

    const nextStep = isComplete ? null : STEP_ORDER[currentIndex + 1] as OnboardingStep;
    const nextAction = nextStep ? {
      step: nextStep,
      ...STEP_LABELS[nextStep],
    } : null;

    return {
      currentStep:    progress.current_step as OnboardingStep,
      completedSteps: progress.completed_steps as OnboardingStep[],
      percentComplete,
      isComplete,
      nextAction,
    };
  }

  async completeStep(step: OnboardingStep): Promise<OnboardingStatus> {
    const { tenantId } = getTenantContext();

    const progress = await this.repo.getProgress(tenantId);
    const completingIndex = STEP_ORDER.indexOf(step);
    const currentIndex    = STEP_ORDER.indexOf(progress.current_step as OnboardingStep);

    // Al voltooid: idempotent teruggeven
    const alreadyCompleted = (progress.completed_steps as string[]).includes(step);
    if (alreadyCompleted && step !== 'completed') {
      // Maar zorg dat current_step altijd vooruit gaat
      if (completingIndex >= currentIndex) {
        const nextStep = STEP_ORDER[completingIndex + 1] as OnboardingStep ?? 'completed';
        await this.repo.updateProgress(tenantId, { completedStep: step, nextStep });
      }
      return this.getStatus();
    }

    // Vul alle tussenliggende stappen automatisch in als die nog niet voltooid zijn
    // Bijv: als current=account_created en step=plan_selected, markeer account_created ook als voltooid
    if (completingIndex > currentIndex) {
      for (let i = currentIndex; i < completingIndex; i++) {
        const intermediateStep = STEP_ORDER[i] as OnboardingStep;
        const alreadyDone = (progress.completed_steps as string[]).includes(intermediateStep);
        if (!alreadyDone) {
          await this.repo.updateProgress(tenantId, {
            completedStep: intermediateStep,
            nextStep: STEP_ORDER[i + 1] as OnboardingStep,
          });
          logger.info('onboarding.step.auto_completed', { tenantId, step: intermediateStep });
        }
      }
    }

    // Nu de gevraagde stap voltooien
    const nextStep = STEP_ORDER[completingIndex + 1] as OnboardingStep ?? 'completed';
    await this.repo.updateProgress(tenantId, { completedStep: step, nextStep });

    logger.info('onboarding.step.completed', { tenantId, step, nextStep });

    await eventBus.publish({
      type: 'onboarding.step_completed',
      tenantId,
      occurredAt: new Date(),
      payload: { step, nextStep },
    });

    if (step === 'shop_connected' || nextStep === 'completed') {
      await this.markCompleted(tenantId);
    }

    return this.getStatus();
  }

  private async markCompleted(tenantId: string): Promise<void> {
    await db.query(
      `UPDATE onboarding_progress
       SET current_step = 'completed',
           completed_steps = array_append(completed_steps, 'completed'),
           completed_at = now()
       WHERE tenant_id = $1`,
      [tenantId]
    );

    await eventBus.publish({
      type: 'onboarding.completed',
      tenantId,
      occurredAt: new Date(),
      payload: {},
    });

    logger.info('onboarding.completed', { tenantId });
  }
}
