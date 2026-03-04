// ============================================================
// src/shared/events/event-bus.ts
//
// Internal pub/sub event bus. Modules communicate ONLY via events.
// Module A never imports code from Module B — it publishes events.
// Module B subscribes to those events.
//
// For production: swap the in-process emitter with BullMQ + Redis
// to get persistence, retries, and cross-process delivery.
// ============================================================

import { EventEmitter } from 'events';
import { logger } from '../logging/logger';
import { TenantContext } from '../types/tenant';

// All domain events must extend this base
export interface DomainEvent {
  type: string;
  tenantId: string;
  occurredAt: Date;
  traceId?: string;
  payload: Record<string, unknown>;
}

// ─── Domain Event Catalogue ──────────────────────────────────
// All event types in one place. Add new events here as modules grow.

export interface OrderCreatedEvent extends DomainEvent {
  type: 'order.created';
  payload: {
    orderId: string;
    totalAmount: number;
    currency: string;
  };
}

export interface AdMetricsUpdatedEvent extends DomainEvent {
  type: 'ad.metrics.updated';
  payload: {
    platform: 'google' | 'meta';
    campaignId: string;
    spend: number;
    conversions: number;
    roas: number;
  };
}

export interface SubscriptionChangedEvent extends DomainEvent {
  type: 'subscription.changed';
  payload: {
    oldPlanSlug: string;
    newPlanSlug: string;
    changeType: 'upgrade' | 'downgrade' | 'cancelled';
  };
}

export interface AiCreditsConsumedEvent extends DomainEvent {
  type: 'ai.credits.consumed';
  payload: {
    feature: string;
    creditsUsed: number;
    creditsRemaining: number;
  };
}

export type AnyDomainEvent =
  | OrderCreatedEvent
  | AdMetricsUpdatedEvent
  | SubscriptionChangedEvent
  | AiCreditsConsumedEvent;

type EventHandler<T extends DomainEvent> = (event: T) => Promise<void>;

// ─── Event Bus Implementation ────────────────────────────────
class EventBus {
  private emitter = new EventEmitter();

  constructor() {
    this.emitter.setMaxListeners(50);  // increase limit for many subscribers
  }

  // Publish an event. Enriches with tenantId + traceId from context.
  async publish<T extends DomainEvent>(event: T): Promise<void> {
    logger.info('event.published', {
      eventType: event.type,
      tenantId: event.tenantId,
      traceId: event.traceId,
    });

    // Emit async — handlers run after current call stack
    setImmediate(() => {
      this.emitter.emit(event.type, event);
    });
  }

  // Subscribe to an event type
  subscribe<T extends DomainEvent>(
    eventType: T['type'],
    handler: EventHandler<T>
  ): void {
    this.emitter.on(eventType, async (event: T) => {
      try {
        await handler(event);
      } catch (err) {
        logger.error('event.handler.error', {
          eventType,
          tenantId: event.tenantId,
          error: (err as Error).message,
        });
        // In production: send to dead-letter queue for retry
      }
    });

    logger.debug('event.subscribed', { eventType });
  }
}

export const eventBus = new EventBus();
