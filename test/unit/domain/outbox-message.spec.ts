import { describe, expect, it } from 'bun:test';
import {
  InvalidMessageError,
  InvalidMessageStateError,
} from '../../../src/domain/messaging/messaging.errors.js';
import {
  OUTBOX_MAX_RETRY_DELAY_MS,
  OutboxMessage,
  type OutboxEvent,
} from '../../../src/domain/messaging/outbox-message.js';

const OCCURRED = new Date('2026-10-31T12:00:00.000Z');

const event = (overrides: Partial<OutboxEvent> = {}): OutboxEvent => ({
  eventId: 'event-1',
  aggregateId: 'wallet-1',
  eventType: 'WalletBalanceChanged',
  occurredAt: OCCURRED,
  toJSON: () => ({
    eventId: 'event-1',
    data: { money: { amount: '25.00', currency: 'BRL' } },
  }),
  ...overrides,
});

const at = (ms: number) => new Date(OCCURRED.getTime() + ms);

describe('OutboxMessage', () => {
  it('enqueues a pending event due immediately', () => {
    const message = OutboxMessage.enqueue(event());
    expect(message.id).toBe('event-1');
    expect(message.attempts).toBe(0);
    expect(message.isPending()).toBe(true);
    expect(message.nextAttemptAt).toEqual(OCCURRED);
    expect(message.isDue(OCCURRED)).toBe(true);
    expect(message.isDue(at(-1))).toBe(false);
    expect(message.payload).toEqual({
      eventId: 'event-1',
      data: { money: { amount: '25.00', currency: 'BRL' } },
    });
  });

  it('keeps a deep frozen copy of the payload', () => {
    const payload = { data: { amount: '1.00' } };
    const message = OutboxMessage.enqueue(event({ toJSON: () => payload }));
    payload.data.amount = '999.00';
    expect(message.payload).toEqual({ data: { amount: '1.00' } });
    expect(Object.isFrozen(message.payload)).toBe(true);
    expect(Object.isFrozen(message.payload.data)).toBe(true);
  });

  it.each([
    ['eventId', { eventId: '' }],
    ['eventType', { eventType: ' ' }],
    ['occurredAt', { occurredAt: new Date(Number.NaN) }],
  ] as const)('rejects invalid %s', (_label, overrides) => {
    expect(() => OutboxMessage.enqueue(event(overrides))).toThrow(
      InvalidMessageError,
    );
  });

  it('backs off exponentially and caps the delay', () => {
    const message = OutboxMessage.enqueue(event());
    message.scheduleRetry(at(0));
    expect(message.attempts).toBe(1);
    expect(message.nextAttemptAt).toEqual(at(1_000));
    expect(message.isDue(at(999))).toBe(false);
    message.scheduleRetry(at(1_000));
    expect(message.nextAttemptAt).toEqual(at(3_000));
    for (let i = 0; i < 20; i += 1) {
      message.scheduleRetry(at(0));
    }
    expect(message.attempts).toBe(22);
    expect(message.nextAttemptAt).toEqual(at(OUTBOX_MAX_RETRY_DELAY_MS));
  });

  it('shortens the delay by at most the jitter ratio without exceeding the cap', () => {
    const message = OutboxMessage.enqueue(event());
    message.scheduleRetry(at(0), 0.999);
    expect(message.nextAttemptAt).toEqual(
      at(1_000 - Math.floor(1_000 * 0.2 * 0.999)),
    );
    for (let i = 0; i < 20; i += 1) {
      message.scheduleRetry(at(0), 0.5);
    }
    expect(message.nextAttemptAt).toEqual(
      at(OUTBOX_MAX_RETRY_DELAY_MS - OUTBOX_MAX_RETRY_DELAY_MS * 0.1),
    );
    expect(() => message.scheduleRetry(at(0), 1)).toThrow(InvalidMessageError);
    expect(() => message.scheduleRetry(at(0), -0.1)).toThrow(
      InvalidMessageError,
    );
  });

  it('is published once and then refuses further changes', () => {
    const message = OutboxMessage.enqueue(event());
    message.markPublished(at(10));
    expect(message.isPending()).toBe(false);
    expect(message.isDue(at(10_000))).toBe(false);
    expect(message.publishedAt).toEqual(at(10));
    expect(() => message.markPublished(at(20))).toThrow(
      InvalidMessageStateError,
    );
    expect(() => message.scheduleRetry(at(20))).toThrow(
      InvalidMessageStateError,
    );
    expect(message.attempts).toBe(0);
  });

  it('refuses publication before the event occurred', () => {
    const message = OutboxMessage.enqueue(event());
    expect(() => message.markPublished(at(-1))).toThrow(
      InvalidMessageStateError,
    );
    expect(message.isPending()).toBe(true);
  });

  it('rehydrates persisted retry state', () => {
    const message = OutboxMessage.rehydrate({
      id: 'event-1',
      aggregateId: 'wallet-1',
      eventType: 'WalletBalanceChanged',
      payload: { a: 1 },
      occurredAt: OCCURRED,
      attempts: 3,
      nextAttemptAt: at(8_000),
    });
    expect(message.attempts).toBe(3);
    expect(message.isDue(at(8_000))).toBe(true);
  });

  it.each([[-1], [1.5]])('rejects attempts %p on rehydration', (attempts) => {
    expect(() =>
      OutboxMessage.rehydrate({
        id: 'event-1',
        aggregateId: 'wallet-1',
        eventType: 'X',
        payload: {},
        occurredAt: OCCURRED,
        attempts,
      }),
    ).toThrow(InvalidMessageError);
  });
});
