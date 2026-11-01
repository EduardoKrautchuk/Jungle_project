import { describe, expect, it } from 'bun:test';
import {
  InvalidOutboxEventError,
  toOutgoingEvent,
} from '../../../../src/application/outbox/outgoing-event.js';
import { balanceChanged, claimed, rehydrated } from './support.js';

function codeOf(action: () => unknown): string | undefined {
  try {
    action();
  } catch (error) {
    if (error instanceof InvalidOutboxEventError) {
      return error.code;
    }
    throw error;
  }
  return undefined;
}

describe('toOutgoingEvent', () => {
  it('serializes exactly the persisted payload with stable identifiers', () => {
    const message = balanceChanged('wallet-1', '25.50');
    const event = toOutgoingEvent(claimed(message, 'wallet-1'));
    expect(event).toEqual({
      eventId: message.id,
      eventType: 'WalletBalanceChanged',
      version: 1,
      correlationId: expect.stringMatching(/^corr-/),
      groupKey: 'wallet-1',
      body: JSON.stringify(message.payload),
    });
    const body: unknown = JSON.parse(event.body);
    expect(body).toMatchObject({
      eventId: message.id,
      aggregateId: 'wallet-1',
      causationId: expect.stringMatching(/^msg-/),
      data: {
        walletId: 'wallet-1',
        money: { amount: '25.50', currency: 'BRL' },
        balanceAfter: { amount: '74.50', currency: 'BRL' },
      },
    });
  });

  it('accepts newer event versions without special casing', () => {
    const base = balanceChanged('wallet-2');
    const v2 = rehydrated(base, { ...base.payload, version: 2 });
    expect(toOutgoingEvent(claimed(v2, 'wallet-2')).version).toBe(2);
  });

  it.each([
    ['eventId mismatch', { eventId: 'other' }, 'EVENT_ID_MISMATCH'],
    ['eventType mismatch', { eventType: 'Other' }, 'EVENT_TYPE_MISMATCH'],
    ['aggregateId mismatch', { aggregateId: 'other' }, 'AGGREGATE_ID_MISMATCH'],
    ['missing correlationId', { correlationId: '' }, 'CORRELATION_ID_MISSING'],
    ['numeric causationId', { causationId: 7 }, 'CAUSATION_ID_INVALID'],
    [
      'other occurredAt',
      { occurredAt: '2020-01-01T00:00:00.000Z' },
      'OCCURRED_AT_MISMATCH',
    ],
    ['zero version', { version: 0 }, 'EVENT_VERSION_INVALID'],
    ['string version', { version: '1' }, 'EVENT_VERSION_INVALID'],
    ['non-object data', { data: [] }, 'EVENT_DATA_INVALID'],
  ])('rejects %s', (_label, override, code) => {
    const base = balanceChanged('wallet-3');
    const broken = rehydrated(base, { ...base.payload, ...override });
    expect(codeOf(() => toOutgoingEvent(claimed(broken, 'wallet-3')))).toBe(
      code,
    );
  });

  it('refuses a monetary amount stored as a JavaScript number', () => {
    const base = balanceChanged('wallet-4');
    const broken = rehydrated(base, {
      ...base.payload,
      data: { walletId: 'wallet-4', money: { amount: 25, currency: 'BRL' } },
    });
    expect(codeOf(() => toOutgoingEvent(claimed(broken, 'wallet-4')))).toBe(
      'EVENT_AMOUNT_NOT_DECIMAL_STRING',
    );
  });

  it('refuses invalid group keys and oversized bodies', () => {
    const base = balanceChanged('wallet-5');
    expect(codeOf(() => toOutgoingEvent(claimed(base, 'has space')))).toBe(
      'GROUP_KEY_INVALID',
    );
    const huge = rehydrated(base, {
      ...base.payload,
      data: { walletId: 'wallet-5', note: 'x'.repeat(262_145) },
    });
    expect(codeOf(() => toOutgoingEvent(claimed(huge, 'wallet-5')))).toBe(
      'EVENT_BODY_TOO_LARGE',
    );
  });
});
