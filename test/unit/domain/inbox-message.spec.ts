import { describe, expect, it } from 'bun:test';
import { InboxMessage } from '../../../src/domain/messaging/inbox-message.js';
import {
  InvalidMessageError,
  InvalidMessageStateError,
} from '../../../src/domain/messaging/messaging.errors.js';

const HASH = 'a'.repeat(64);
const RECEIVED = new Date('2026-10-31T12:00:00.000Z');
const PROCESSED = new Date('2026-10-31T12:00:01.000Z');

const props = (
  overrides: Partial<Parameters<typeof InboxMessage.receive>[0]> = {},
) => ({
  messageId: 'msg-1',
  consumerName: 'wager-transactions',
  payloadHash: HASH,
  receivedAt: RECEIVED,
  ...overrides,
});

describe('InboxMessage', () => {
  it('receives an unprocessed message', () => {
    const message = InboxMessage.receive(props());
    expect(message.isProcessed()).toBe(false);
    expect(message.processedAt).toBeUndefined();
    expect(message.receivedAt).toEqual(RECEIVED);
    expect(message.matchesPayload(HASH)).toBe(true);
    expect(message.matchesPayload('b'.repeat(64))).toBe(false);
  });

  it.each([
    ['messageId', ''],
    ['consumerName', ' '],
    ['payloadHash', 'ABC'],
    ['payloadHash', 'A'.repeat(64)],
    ['receivedAt', new Date(Number.NaN)],
  ] as const)('rejects invalid %s %p', (field, value) => {
    expect(() => InboxMessage.receive(props({ [field]: value }))).toThrow(
      InvalidMessageError,
    );
  });

  it('is processed exactly once', () => {
    const message = InboxMessage.receive(props());
    message.markProcessed(PROCESSED);
    expect(message.isProcessed()).toBe(true);
    expect(message.processedAt).toEqual(PROCESSED);
    expect(() => message.markProcessed(PROCESSED)).toThrow(
      InvalidMessageStateError,
    );
  });

  it('refuses processing before reception without changing state', () => {
    const message = InboxMessage.receive(props());
    expect(() =>
      message.markProcessed(new Date(RECEIVED.getTime() - 1)),
    ).toThrow(InvalidMessageStateError);
    expect(message.isProcessed()).toBe(false);
  });

  it('rehydrates a processed message', () => {
    const message = InboxMessage.rehydrate({
      ...props(),
      processedAt: PROCESSED,
    });
    expect(message.isProcessed()).toBe(true);
  });

  it('protects its fields and dates', () => {
    const receivedAt = new Date(RECEIVED.getTime());
    const message = InboxMessage.receive(props({ receivedAt }));
    receivedAt.setFullYear(2000);
    message.receivedAt.setFullYear(2000);
    expect(message.receivedAt).toEqual(RECEIVED);
    expect(Object.isFrozen(message)).toBe(true);
    expect(() => {
      Object.assign(message, { messageId: 'other' });
    }).toThrow(TypeError);
  });
});
