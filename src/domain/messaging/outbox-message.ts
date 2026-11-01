import {
  assertNonEmptyString,
  assertNonNegativeInteger,
  assertValidDate,
} from './message-guards.js';
import {
  InvalidMessageError,
  InvalidMessageStateError,
} from './messaging.errors.js';

export type OutboxPayload = Readonly<Record<string, unknown>>;

export interface OutboxEvent {
  readonly eventId: string;
  readonly aggregateId: string;
  readonly eventType: string;
  readonly occurredAt: Date;
  toJSON(): Record<string, unknown>;
}

export interface OutboxMessageState {
  id: string;
  aggregateId: string;
  eventType: string;
  payload: Record<string, unknown>;
  occurredAt: Date;
  attempts: number;
  nextAttemptAt?: Date;
  publishedAt?: Date;
}

export const OUTBOX_BASE_RETRY_DELAY_MS = 1_000;
export const OUTBOX_MAX_RETRY_DELAY_MS = 300_000;

export class OutboxMessage {
  readonly id: string;
  readonly aggregateId: string;
  readonly eventType: string;
  readonly payload: OutboxPayload;
  readonly #occurredAtMs: number;
  #attempts: number;
  #nextAttemptAtMs: number | undefined;
  #publishedAtMs: number | undefined;

  private constructor(state: OutboxMessageState) {
    this.id = state.id;
    this.aggregateId = state.aggregateId;
    this.eventType = state.eventType;
    this.payload = freezeJson(state.payload);
    this.#occurredAtMs = state.occurredAt.getTime();
    this.#attempts = state.attempts;
    this.#nextAttemptAtMs = state.nextAttemptAt?.getTime();
    this.#publishedAtMs = state.publishedAt?.getTime();
    Object.freeze(this);
  }

  static enqueue(event: OutboxEvent): OutboxMessage {
    const state: OutboxMessageState = {
      id: event.eventId,
      aggregateId: event.aggregateId,
      eventType: event.eventType,
      payload: event.toJSON(),
      occurredAt: event.occurredAt,
      attempts: 0,
      nextAttemptAt: event.occurredAt,
    };
    OutboxMessage.assertStructure(state);
    return new OutboxMessage(state);
  }

  static rehydrate(state: OutboxMessageState): OutboxMessage {
    OutboxMessage.assertStructure(state);
    return new OutboxMessage(state);
  }

  get occurredAt(): Date {
    return new Date(this.#occurredAtMs);
  }

  get attempts(): number {
    return this.#attempts;
  }

  get nextAttemptAt(): Date | undefined {
    return this.#nextAttemptAtMs === undefined
      ? undefined
      : new Date(this.#nextAttemptAtMs);
  }

  get publishedAt(): Date | undefined {
    return this.#publishedAtMs === undefined
      ? undefined
      : new Date(this.#publishedAtMs);
  }

  isPending(): boolean {
    return this.#publishedAtMs === undefined;
  }

  isDue(now: Date): boolean {
    assertValidDate(now, 'now');
    return (
      this.isPending() &&
      (this.#nextAttemptAtMs ?? this.#occurredAtMs) <= now.getTime()
    );
  }

  markPublished(at: Date): void {
    assertValidDate(at, 'at');
    this.#assertPending();
    if (at.getTime() < this.#occurredAtMs) {
      throw new InvalidMessageStateError(
        'publishedAt must not precede occurredAt',
      );
    }
    this.#publishedAtMs = at.getTime();
  }

  scheduleRetry(now: Date): void {
    assertValidDate(now, 'now');
    this.#assertPending();
    const attempts = this.#attempts + 1;
    const delay = Math.min(
      OUTBOX_BASE_RETRY_DELAY_MS * 2 ** (attempts - 1),
      OUTBOX_MAX_RETRY_DELAY_MS,
    );
    this.#attempts = attempts;
    this.#nextAttemptAtMs = now.getTime() + delay;
  }

  #assertPending(): void {
    if (!this.isPending()) {
      throw new InvalidMessageStateError('outbox message already published');
    }
  }

  private static assertStructure(state: OutboxMessageState): void {
    assertNonEmptyString(state.id, 'id');
    assertNonEmptyString(state.aggregateId, 'aggregateId');
    assertNonEmptyString(state.eventType, 'eventType');
    assertValidDate(state.occurredAt, 'occurredAt');
    assertNonNegativeInteger(state.attempts, 'attempts');
    if (state.nextAttemptAt !== undefined) {
      assertValidDate(state.nextAttemptAt, 'nextAttemptAt');
    }
    if (state.publishedAt !== undefined) {
      assertValidDate(state.publishedAt, 'publishedAt');
    }
    if (!isPlainObject(state.payload)) {
      throw new InvalidMessageError('payload must be a JSON object');
    }
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function freezeJson(payload: Record<string, unknown>): OutboxPayload {
  const parsed: unknown = JSON.parse(JSON.stringify(payload));
  if (!isPlainObject(parsed)) {
    throw new InvalidMessageError('payload must be a JSON object');
  }
  return deepFreeze(parsed);
}

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null) {
    for (const child of Object.values(value)) {
      deepFreeze(child);
    }
    Object.freeze(value);
  }
  return value;
}
