import type { OutboxEvent } from '../../domain/messaging/outbox-message.js';

export interface EventContext {
  readonly eventId: string;
  readonly correlationId: string;
  readonly causationId?: string;
  readonly occurredAt: Date;
}

export interface IntegrationEventProps<T> extends EventContext {
  readonly aggregateId: string;
  readonly data: T;
}

export type IntegrationEventEnvelope<T> = {
  eventId: string;
  eventType: string;
  aggregateId: string;
  correlationId: string;
  causationId?: string;
  occurredAt: string;
  version: number;
  data: T;
};

export abstract class IntegrationEvent<T> implements OutboxEvent {
  abstract readonly eventType: string;
  abstract readonly version: number;

  readonly eventId: string;
  readonly aggregateId: string;
  readonly correlationId: string;
  readonly causationId: string | undefined;
  readonly data: Readonly<T>;
  readonly #occurredAtMs: number;

  protected constructor(props: IntegrationEventProps<T>) {
    this.eventId = props.eventId;
    this.aggregateId = props.aggregateId;
    this.correlationId = props.correlationId;
    this.causationId = props.causationId;
    this.data = props.data;
    this.#occurredAtMs = props.occurredAt.getTime();
  }

  get occurredAt(): Date {
    return new Date(this.#occurredAtMs);
  }

  toJSON(): IntegrationEventEnvelope<T> {
    const envelope: IntegrationEventEnvelope<T> = {
      eventId: this.eventId,
      eventType: this.eventType,
      aggregateId: this.aggregateId,
      correlationId: this.correlationId,
      occurredAt: this.occurredAt.toISOString(),
      version: this.version,
      data: this.data,
    };
    if (this.causationId !== undefined) {
      envelope.causationId = this.causationId;
    }
    return envelope;
  }
}
