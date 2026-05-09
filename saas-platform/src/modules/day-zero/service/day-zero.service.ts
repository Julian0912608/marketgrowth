// ============================================================
// src/modules/day-zero/service/day-zero.service.ts
//
// Orchestratie van de 5-stage Day Zero job.
// Single source of truth voor:
//   - initForTenant: aangeroepen door /api/onboarding/complete
//   - runStage: aangeroepen door BullMQ worker per stage
//   - getStatusDTO: aangeroepen door /api/day-zero/status polling
//   - Plan lookup: bepalen welke priority een tenant in de queue krijgt
//
// Sprint 3a: stage 1 echt, stages 2-5 stubs (worden vervangen in 3b en 3c).
// ============================================================

import { db } from '../../../infrastructure/database/connection';
import { logger } from '../../../shared/logging/logger';
import { dayZeroRepository, DayZeroRepository } from '../repository/day-zero.repository';
import { stage1IngestionService, Stage1IngestionService } from '../stages/stage-1-ingestion';
import {
  enqueueDayZero,
  enqueueNextStage,
} from '../queue/day-zero.queue';
import {
  DayZeroJobData,
  DayZeroProgressRow,
  DayZeroStage,
  DayZeroStatusDTO,
  STAGE_NAMES,
  TenantPlan,
} from '../types/day-zero.types';

// --------------------------------------------------------------
// Progress berekening config
// --------------------------------------------------------------

const STAGE_END_PERCENTS = [0, 13, 46, 79, 95, 100];

const STAGE_BUDGETS_SEC: Record<DayZeroStage, number> = {
  0: 0,
  1: 120,
  2: 300,
  3: 300,
  4: 180,
  5: 30,
};

const TOTAL_BUDGET_SEC = Object.values(STAGE_BUDGETS_SEC).reduce((a, b) => a + b, 0);

const STAGE_START_OFFSETS_SEC: Record<DayZeroStage, number> = {
  0: 0,
  1: 0,
  2: STAGE_BUDGETS_SEC[1],
  3: STAGE_BUDGETS_SEC[1] + STAGE_BUDGETS_SEC[2],
  4: STAGE_BUDGETS_SEC[1] + STAGE_BUDGETS_SEC[2] + STAGE_BUDGETS_SEC[3],
  5: STAGE_BUDGETS_SEC[1] + STAGE_BUDGETS_SEC[2] + STAGE_BUDGETS_SEC[3] + STAGE_BUDGETS_SEC[4],
};

// ============================================================

export class DayZeroService {

  constructor(
    private readonly repo:    DayZeroRepository       = dayZeroRepository,
    private readonly stage1:  Stage1IngestionService  = stage1IngestionService,
  ) {}

  // --------------------------------------------------------------
  // Public: aangeroepen door onboarding flow
  // --------------------------------------------------------------

  async initForTenant(tenantId: string): Promise<{ status: string; jobId: string | null }> {
    const row = await this.repo.createIfNotExists(tenantId);

    if (row.status === 'completed') {
      logger.info('day_zero.init.already_completed', { tenantId });
      return { status: 'completed', jobId: null };
    }
    if (row.status === 'running') {
      logger.info('day_zero.init.already_running', { tenantId });
      return { status: 'running', jobId: null };
    }

    const plan  = await this.fetchTenantPlan(tenantId);
    const jobId = await enqueueDayZero(tenantId, plan);

    logger.info('day_zero.init.enqueued', { tenantId, plan, jobId });
    return {
      status: 'running',
      jobId,
    };
  }

  // --------------------------------------------------------------
  // Public: aangeroepen door /api/day-zero/status
  // --------------------------------------------------------------

  async getStatusDTO(tenantId: string): Promise<DayZeroStatusDTO | null> {
    const row = await this.repo.getByTenantId(tenantId);
    if (!row) return null;

    return {
      status:             row.status,
      current_stage:      row.current_stage,
      current_stage_name: STAGE_NAMES[row.current_stage],
      progress_percent:   computeProgressPercent(row),
      eta_seconds:        computeEtaSeconds(row),
      started_at:         row.started_at,
      completed_at:       row.completed_at,
      error_message:      row.error_message,
    };
  }

  // --------------------------------------------------------------
  // Public: aangeroepen door BullMQ worker
  // --------------------------------------------------------------

  async runStage(job: DayZeroJobData): Promise<{ next: DayZeroStage | null }> {
    const { tenantId, stage } = job;

    logger.info('day_zero.stage.start', {
      tenantId, stage, stageName: STAGE_NAMES[stage],
    });

    let next: DayZeroStage | null = null;

    try {
      await this.repo.markRunning(tenantId, stage);

      switch (stage) {
        case 1: {
          const output = await this.stage1.run(tenantId);
          await this.repo.updateStage(tenantId, 1, { stage_1: output });
          next = 2;
          break;
        }

        case 2: {
          await this.runStubStage(tenantId, 2);
          next = 3;
          break;
        }

        case 3: {
          await this.runStubStage(tenantId, 3);
          next = 4;
          break;
        }

        case 4: {
          await this.runStubStage(tenantId, 4);
          next = 5;
          break;
        }

        case 5: {
          await this.runStubStage(tenantId, 5);
          await this.repo.markCompleted(tenantId);
          logger.info('day_zero.completed', { tenantId });
          next = null;
          break;
        }

        default:
          throw new Error(`Unknown Day Zero stage: ${stage}`);
      }
    } catch (err: any) {
      const message = err?.message ?? 'unknown error';
      logger.error('day_zero.stage.failed', { tenantId, stage, error: message });
      await this.repo.markFailed(tenantId, stage, message);
      throw err;
    }

    if (next !== null) {
      const plan = await this.fetchTenantPlan(tenantId);
      await enqueueNextStage(tenantId, next, plan);
    }

    return { next };
  }

  // --------------------------------------------------------------
  // Internal helpers
  // --------------------------------------------------------------

  private async runStubStage(tenantId: string, stage: DayZeroStage): Promise<void> {
    await new Promise((res) => setTimeout(res, 2000));
    await this.repo.updateStage(tenantId, stage, {
      [`stage_${stage}`]: {
        stub: true,
        completed_at: new Date().toISOString(),
      },
    } as any);
  }

  /**
   * Plan lookup via tenant_subscriptions JOIN plans.
   * Pattern overgenomen van sync.scheduler.ts (gevalideerd in productie).
   * Fallback bij geen actieve sub: 'starter' (laagste priority, veiligste default).
   */
  private async fetchTenantPlan(tenantId: string): Promise<TenantPlan> {
    try {
      const result = await db.query<{ plan_slug: string }>(
        `SELECT COALESCE(p.slug, 'starter') AS plan_slug
         FROM tenant_subscriptions ts
         JOIN plans p ON p.id = ts.plan_id
         WHERE ts.tenant_id = $1
           AND ts.status IN ('active', 'trialing')
         ORDER BY ts.created_at DESC
         LIMIT 1`,
        [tenantId],
        { allowNoTenant: true }
      );

      const slug = result.rows[0]?.plan_slug;
      if (slug === 'scale' || slug === 'growth' || slug === 'starter') return slug;
      return 'starter';
    } catch (err) {
      logger.warn('day_zero.plan_fallback', {
        tenantId,
        error: (err as Error).message,
      });
      return 'starter';
    }
  }
}

// ============================================================
// Pure helpers (geexporteerd voor testbaarheid)
// ============================================================

export function computeProgressPercent(row: DayZeroProgressRow): number {
  if (row.status === 'pending')   return 0;
  if (row.status === 'completed') return 100;

  if (row.status === 'failed') {
    const lastDone = Math.max(0, row.current_stage - 1);
    return STAGE_END_PERCENTS[lastDone] ?? 0;
  }

  const stage = row.current_stage;
  const stageStartPct = STAGE_END_PERCENTS[stage - 1] ?? 0;
  const stageEndPct   = STAGE_END_PERCENTS[stage]     ?? 100;

  const startedAtMs = row.started_at ? new Date(row.started_at).getTime() : Date.now();
  const elapsedSec  = (Date.now() - startedAtMs) / 1000;

  const stageStartOffset = STAGE_START_OFFSETS_SEC[stage] ?? 0;
  const stageBudget      = STAGE_BUDGETS_SEC[stage]       ?? 60;

  const elapsedInStage = Math.max(0, elapsedSec - stageStartOffset);
  const stageProgress  = Math.min(1, elapsedInStage / stageBudget);

  const pct = stageStartPct + (stageEndPct - stageStartPct) * stageProgress;
  return Math.max(0, Math.min(99, Math.round(pct)));
}

export function computeEtaSeconds(row: DayZeroProgressRow): number | null {
  if (row.status === 'pending')   return TOTAL_BUDGET_SEC;
  if (row.status === 'completed') return 0;
  if (row.status === 'failed')    return null;

  if (!row.started_at) return TOTAL_BUDGET_SEC;

  const elapsedSec = (Date.now() - new Date(row.started_at).getTime()) / 1000;
  return Math.max(0, Math.round(TOTAL_BUDGET_SEC - elapsedSec));
}

export const dayZeroService = new DayZeroService();
