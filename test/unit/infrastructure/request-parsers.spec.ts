import { describe, expect, it } from 'bun:test';
import { InvalidRequestError } from '../../../src/application/application.errors.js';
import {
  parseCorrelationId,
  parseCreateWallet,
  parseLedgerQuery,
  parseWagerRequest,
} from '../../../src/infrastructure/http/validation/request-parsers.js';

const body = {
  providerId: 'provider-a',
  externalTransactionId: 'transaction-123',
  playerId: 'player-1',
  walletId: '0192F291-27DD-7D3F-8071-5F8685DEEF37',
  roundId: 'round-987',
  gameId: 'fortune-chimp',
  kind: 'BET',
  money: { amount: '25.00', currency: 'BRL' },
};

function issuesOf(action: () => unknown): string[] {
  try {
    action();
  } catch (error) {
    if (error instanceof InvalidRequestError) {
      return error.issues.map((issue) => `${issue.field}:${issue.code}`);
    }
    throw error;
  }
  return [];
}

describe('parseWagerRequest', () => {
  it('accepts a valid request and normalizes the wallet UUID', () => {
    const parsed = parseWagerRequest(body, 'provider-a:transaction-123');
    expect(parsed.walletId).toBe('0192f291-27dd-7d3f-8071-5f8685deef37');
    expect(parsed.idempotencyKey).toBe('provider-a:transaction-123');
    expect(parsed.referenceExternalTransactionId).toBeUndefined();
  });

  it('reports every problem at once', () => {
    expect(
      issuesOf(() =>
        parseWagerRequest(
          {
            ...body,
            providerId: 'bad provider',
            walletId: 'nope',
            kind: 'OPENING',
            money: { amount: 25, currency: 'BRL', extra: true },
            gameId: '',
            debug: true,
          },
          undefined,
        ),
      ),
    ).toEqual([
      'debug:UNKNOWN_FIELD',
      'header.Idempotency-Key:REQUIRED',
      'providerId:INVALID_PROVIDER_ID',
      'walletId:INVALID_UUID',
      'gameId:INVALID_IDENTIFIER',
      'kind:UNSUPPORTED_KIND',
      'money.extra:UNKNOWN_FIELD',
      'money.amount:INVALID_TYPE',
    ]);
  });

  it.each([
    [
      'padded identifier',
      { ...body, roundId: ' r ' },
      ['roundId:INVALID_IDENTIFIER'],
    ],
    [
      'oversized identifier',
      { ...body, externalTransactionId: 'x'.repeat(257) },
      ['externalTransactionId:INVALID_IDENTIFIER'],
    ],
    [
      'missing money',
      { ...body, money: undefined },
      [
        'money:INVALID_TYPE',
        'money.amount:REQUIRED',
        'money.currency:REQUIRED',
      ],
    ],
    [
      'numeric reference',
      { ...body, referenceExternalTransactionId: 7 },
      ['referenceExternalTransactionId:INVALID_TYPE'],
    ],
  ])('rejects %s', (_label, input, expected) => {
    expect(issuesOf(() => parseWagerRequest(input, 'key'))).toEqual(expected);
  });
});

describe('non-object bodies', () => {
  it.each([[null], [[]], ['text'], [42]])('rejects %p as body', (input) => {
    const issues = issuesOf(() => parseWagerRequest(input, 'key'));
    expect(issues[0]).toBe('body:INVALID_TYPE');
    expect(issues).toContain('providerId:REQUIRED');
  });
});

describe('other parsers', () => {
  it('parses wallet creation strictly', () => {
    expect(
      parseCreateWallet({
        playerId: 'p',
        initialBalance: { amount: '1.00', currency: 'BRL' },
      }),
    ).toEqual({
      playerId: 'p',
      initialBalance: { amount: '1.00', currency: 'BRL' },
    });
    expect(
      issuesOf(() => parseCreateWallet({ playerId: 'p', balance: 1 })),
    ).toEqual([
      'balance:UNKNOWN_FIELD',
      'initialBalance:INVALID_TYPE',
      'initialBalance.amount:REQUIRED',
      'initialBalance.currency:REQUIRED',
    ]);
  });

  it('parses ledger paging', () => {
    expect(parseLedgerQuery({})).toEqual({ cursor: undefined, limit: 50 });
    expect(parseLedgerQuery({ limit: '200', cursor: 'abc' })).toEqual({
      cursor: 'abc',
      limit: 200,
    });
    for (const limit of ['0', '201', '1.5', '-1', ['1', '2']]) {
      expect(issuesOf(() => parseLedgerQuery({ limit }))).toEqual([
        'limit:INVALID_LIMIT',
      ]);
    }
    expect(issuesOf(() => parseLedgerQuery({ page: '1' }))).toEqual([
      'query.page:UNKNOWN_FIELD',
    ]);
  });

  it('accepts optional safe correlation ids', () => {
    expect(parseCorrelationId(undefined)).toBeUndefined();
    expect(parseCorrelationId('req-1:abc')).toBe('req-1:abc');
    expect(issuesOf(() => parseCorrelationId('<script>'))).toEqual([
      'header.X-Correlation-Id:INVALID_CORRELATION_ID',
    ]);
  });
});
