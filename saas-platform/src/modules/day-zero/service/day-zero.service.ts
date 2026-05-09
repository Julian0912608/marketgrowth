// ============================================================
// src/modules/day-zero/service/day-zero.service.ts
//
// Orchestratie van de 5-stage Day Zero job.
// Wordt aangeroepen door de BullMQ worker (1 job per stage).
//
// Per stage: markRunning -> uitvoer -> updateStage of markFailed.
// Stage 5 finalize -> markCompleted.
// ============================================================

import { logger } from '../../../shared/logging/logger';
import { dayZeroRepository, DayZeroRepository } from '../repository/day-zero.repository';
import { stage1IngestionService, Stage1IngestionService } from '../stages/stage-1-ingestion';
import {
  DayZeroJobData,
  DayZeroStage,
  STAGE_NAMES,
} from '../types/day-zero.types';

export class DayZeroService {

  constructor(
    private readonly repo:    DayZeroRepository       = dayZeroRepository,
    private readonly stage1:  Stage1IngestionService  = stage1IngestionService,
  ) {}

  /**
   * Idempotent init. Aangeroepen door /api/onboarding/complete.
   */
  async initForTenant(tenantId: string): Promise<{ created: boolean; status: string }> {
    const row = await this.repo.createIfNotExists(tenantId);
    return {
      created: row.status === 'pending' && row.current_stage === 0,
      status:  row.status,
    };
  }

  /**
   * Worker entry point. Wordt aangeroepen voor elke stage job.
   * Stage 1 is gefaseerd 1->2->3->4->5; elke stage enqueue de volgende.
   */
  async runStage(job: DayZeroJobData): Promise<{ next: DayZeroStage | null }> {
    const { tenantId, stage } = job;

    logger.info('day_zero.stage.start', {
      tenantId,
      stage,
      stageName: STAGE_NAMES[stage],
    });

    try {
      await this.repo.markRunning(tenantId, stage);

      switch (stage) {
        case 1: {
          const output = await this.stage1.run(tenantId);
          await this.repo.updateStage(tenantId, 1, { stage_1: output });
          return { next: 2 };
        }

        case 2: {
          // Sprint 3b: brand voice via Haiku op products.description
          await this.runStubStage(tenantId, 2);
          return { next: 3 };
        }

        case 3: {
          // Sprint 3b: pattern detection (top SKUs, seasonality, segments)
          await this.runStubStage(tenantId, 3);
          return { next: 4 };
        }

        case 4: {
          // Sprint 3b: baseline plan generation via Sonnet
          await this.runStubStage(tenantId, 4);
          return { next: 5 };
        }

        case 5: {
          // Sprint 3c: pgvector init + first daily briefing schedule
          await this.runStubStage(tenantId, 5);
          await this.repo.markCompleted(tenantId);
          logger.info('day_zero.completed', { tenantId });
          return { next: null };
        }

        default:
          throw new Error(`Unknown Day Zero stage: ${stage}`);
      }
    } catch (err: any) {
      const message = err?.message ?? 'unknown error';
      logger.error('day_zero.stage.failed', {
        tenantId,
        stage,
        error: message,
      });
      await this.repo.markFailed(tenantId, stage, message);
      throw err;  // BullMQ retry triggeren
    }
  }

  /**
   * Tijdelijk: zet stage_data zodat polling page progress laat zien.
   * Vervangen door echte logica in sprint 3b en 3c.
   */
  private async runStubStage(tenantId: string, stage: DayZeroStage): Promise<void> {
    await new Promise((res) => setTimeout(res, 2000));
    await this.repo.updateStage(tenantId, stage, {
      [`stage_${stage}`]: {
        stub: true,
        completed_at: new Date().toISOString(),
      },
    } as any);
  }
}

export const dayZeroService = new DayZeroService();
