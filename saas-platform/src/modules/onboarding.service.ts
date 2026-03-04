// ============================================================
// src/modules/onboarding/service/onboarding.service.ts
//
// Beheert de onboarding-flow voor nieuwe klanten:
//   Stap 1: account_created  (automatisch bij registratie)
//   Stap 2: plan_selected    (Starter/Growth/Scale kiezen)
//   Stap 3: payment_completed (betaling via Stripe)
//   Stap 4: shop_connected   (eerste webshop koppelen)
//   Stap 5: completed        (klaar!)
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
  account_created:   { label: 'Account aangemaakt',   description: 'Bevestig je e-mailadres',              url: '/onboarding/verify-email' },
  plan_selected:     { label: 'Plan kiezen',           description: 'Kies het pakket dat bij je past',      url: '/onboarding/plan' },
  payment_completed: { label: 'Betaling instellen',    description: 'Voeg een betaalmethode toe',           url: '/onboarding/billing' },
  shop_connected:    { label: 'Webshop koppelen',      description: 'Verbind je eerste webshop',            url: '/onboarding/connect-shop' },
  completed:         { label: 'Klaar!',                description: 'Je platform staat klaar',              url: '/dashboard' },
};

export class OnboardingService {
  constructor(private readonly repo = new OnboardingRepository()) {}

  // Huidige onboarding status ophalen
  async getStatus(): Promise<OnboardingStatus> {
    const { tenantId } = getTenantContext();
    const progress = await this.repo.getProgress(tenantId);

    const currentIndex    = STEP_ORDER.indexOf(progress.current_step as OnboardingStep);
    const percentComplete = Math.round((currentIndex / (STEP_ORDER.length - 1)) * 100);
    const isComplete      = progress.current_step === 'completed';

    // Volgende actie bepalen
    const nextStep = isComplete ? null : STEP_ORDER[currentIndex + 1] as OnboardingStep;
    const nextAction = nextStep ? {
      step:        nextStep,
      ...STEP_LABELS[nextStep],
    } : null;

    return {
      currentStep:     progress.current_step as OnboardingStep,
      completedSteps:  progress.completed_steps as OnboardingStep[],
      percentComplete,
      isComplete,
      nextAction,
    };
  }

  // Stap markeren als voltooid en naar de volgende gaan
  async completeStep(step: OnboardingStep): Promise<OnboardingStatus> {
    const { tenantId } = getTenantContext();

    const progress = await this.repo.getProgress(tenantId);
    const currentIndex  = STEP_ORDER.indexOf(progress.current_step as OnboardingStep);
    const completingIndex = STEP_ORDER.indexOf(step);

    // Kan alleen de huidige of een eerdere stap voltooien
    if (completingIndex > currentIndex) {
      throw new Error(`Stap '${step}' kan nog niet worden voltooid. Voltooi eerst de vorige stappen.`);
    }

    const alreadyCompleted = (progress.completed_steps as string[]).includes(step);
    if (alreadyCompleted && step !== 'completed') {
      return this.getStatus();  // Idempotent: al voltooid, gewoon huidige status teruggeven
    }

    // Volgende stap bepalen
    const nextStep = STEP_ORDER[completingIndex + 1] as OnboardingStep;

    await this.repo.updateProgress(tenantId, {
      completedStep: step,
      nextStep: nextStep ?? 'completed',
    });

    logger.info('onboarding.step.completed', { tenantId, step, nextStep });

    // Event publiceren (bijv. voor welkoms-email, analytics)
    await eventBus.publish({
      type: 'onboarding.step_completed',
      tenantId,
      occurredAt: new Date(),
      payload: { step, nextStep },
    });

    if (nextStep === 'completed' || step === 'shop_connected') {
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
