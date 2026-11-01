import { describe, expect, it } from 'bun:test';
import { InvalidRequestError } from '../../../../src/application/application.errors.js';
import {
  MalformedMessageError,
  parseWagerMessage,
} from '../../../../src/infrastructure/messaging/wager-message.js';

const data = {
  providerId: 'provider-a',
  externalTransactionId: 'transaction-123',
  idempotencyKey: 'provider-a:transaction-123',
  playerId: '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1',
  walletId: '0192F291-27DD-7D3F-8071-5F8685DEEF37',
  roundId: 'round-987',
  gameId: 'fortune-chimp',
  kind: 'BET',
  money: { amount: '25.00', currency: 'BRL' },
};

const message = {
  messageId: 'msg-123',
  type: 'WagerTransactionRequested',
  occurredAt: '2026-07-29T15:00:00.000Z',
  data,
};

function issues(body: string): string[] {
  try {
    parseWagerMessage(body);
  } catch (error) {
    if (error instanceof InvalidRequestError) {
      return error.issues.map((issue) => `${issue.field}:${issue.code}`);
    }
    throw error;
  }
  return [];
}

describe('parseWagerMessage', () => {
  it('parses the contract from the challenge keeping money as strings', () => {
    const parsed = parseWagerMessage(JSON.stringify(message));
    expect(parsed).toMatchObject({
      messageId: 'msg-123',
      type: 'WagerTransactionRequested',
      correlationId: 'msg-123',
      command: {
        ...data,
        walletId: data.walletId.toLowerCase(),
        correlationId: 'msg-123',
        causationId: 'msg-123',
      },
    });
    expect(parsed.occurredAt.toISOString()).toBe(message.occurredAt);
    expect(typeof parsed.command.money.amount).toBe('string');
    expect(parsed.payloadHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('preserves an explicit correlationId', () => {
    const parsed = parseWagerMessage(
      JSON.stringify({ ...message, correlationId: 'corr-1' }),
    );
    expect(parsed.correlationId).toBe('corr-1');
    expect(parsed.command.causationId).toBe('msg-123');
  });

  it('hashes type and data independently of key order and transport fields', () => {
    const base = parseWagerMessage(JSON.stringify(message)).payloadHash;
    const reordered = parseWagerMessage(
      JSON.stringify({
        data: { ...data, money: { currency: 'BRL', amount: '25.00' } },
        occurredAt: '2026-07-30T00:00:00.000Z',
        correlationId: 'other',
        type: 'WagerTransactionRequested',
        messageId: 'msg-123',
      }),
    ).payloadHash;
    const changed = parseWagerMessage(
      JSON.stringify({
        ...message,
        data: { ...data, money: { amount: '25.01', currency: 'BRL' } },
      }),
    ).payloadHash;
    expect(reordered).toBe(base);
    expect(changed).not.toBe(base);
  });

  it.each([['not json'], [''], ['{']])('flags %p as malformed', (body) => {
    expect(() => parseWagerMessage(body)).toThrow(MalformedMessageError);
  });

  it('rejects numeric money, unknown fields and wrong types at once', () => {
    expect(
      issues(
        JSON.stringify({
          ...message,
          extra: true,
          type: 'Other',
          occurredAt: 'yesterday',
          data: {
            ...data,
            money: { amount: 25, currency: 'BRL' },
            kind: 'OPENING',
            unknown: 1,
          },
        }),
      ),
    ).toEqual([
      'extra:UNKNOWN_FIELD',
      'type:UNSUPPORTED_MESSAGE_TYPE',
      'occurredAt:INVALID_TIMESTAMP',
      'data.unknown:UNKNOWN_FIELD',
      'data.kind:UNSUPPORTED_KIND',
      'data.money.amount:INVALID_TYPE',
    ]);
  });

  it('requires the idempotency key and the logical messageId', () => {
    const { idempotencyKey: _ignored, ...withoutKey } = data;
    expect(
      issues(
        JSON.stringify({ ...message, messageId: undefined, data: withoutKey }),
      ),
    ).toEqual(['messageId:REQUIRED', 'data.idempotencyKey:REQUIRED']);
  });

  it('rejects an impossible calendar date', () => {
    expect(
      issues(
        JSON.stringify({ ...message, occurredAt: '2026-02-30T25:00:00Z' }),
      ),
    ).toEqual(['occurredAt:INVALID_TIMESTAMP']);
  });
});
