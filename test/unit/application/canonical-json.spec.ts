import { describe, expect, it } from 'bun:test';
import {
  canonicalJson,
  sha256Hex,
} from '../../../src/application/idempotency/canonical-json.js';
import {
  wagerPayloadHash,
  type WagerRequestPayload,
} from '../../../src/application/wagering/wager-request.js';

const payload: WagerRequestPayload = {
  providerId: 'provider-a',
  externalTransactionId: 'transaction-123',
  playerId: '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1',
  walletId: '0192f291-27dd-7d3f-8071-5f8685deef37',
  roundId: 'round-987',
  gameId: 'fortune-chimp',
  kind: 'BET',
  money: { amount: '25.00', currency: 'BRL' },
};

describe('canonicalJson', () => {
  it('sorts keys recursively and drops undefined members', () => {
    expect(
      canonicalJson({
        b: '1',
        a: { d: null, c: true },
        e: undefined,
        f: ['x'],
      }),
    ).toBe('{"a":{"c":true,"d":null},"b":"1","f":["x"]}');
  });

  it('is independent of property insertion order', () => {
    expect(canonicalJson({ x: '1', y: '2' })).toBe(
      canonicalJson({ y: '2', x: '1' }),
    );
  });

  it('escapes strings like JSON', () => {
    expect(canonicalJson({ 'k"': 'a\nb' })).toBe('{"k\\"":"a\\nb"}');
  });

  it('produces lowercase SHA-256 hex', () => {
    expect(sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });
});

describe('wagerPayloadHash', () => {
  it('hashes the canonical business payload', () => {
    expect(wagerPayloadHash(payload)).toBe(
      sha256Hex(
        '{"externalTransactionId":"transaction-123","gameId":"fortune-chimp","kind":"BET","money":{"amount":"25.00","currency":"BRL"},"playerId":"0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1","providerId":"provider-a","roundId":"round-987","walletId":"0192f291-27dd-7d3f-8071-5f8685deef37"}',
      ),
    );
  });

  it('ignores field order and changes with any business field', () => {
    const reordered: WagerRequestPayload = {
      money: { currency: 'BRL', amount: '25.00' },
      kind: 'BET',
      gameId: 'fortune-chimp',
      roundId: 'round-987',
      walletId: payload.walletId,
      playerId: payload.playerId,
      externalTransactionId: 'transaction-123',
      providerId: 'provider-a',
    };
    expect(wagerPayloadHash(reordered)).toBe(wagerPayloadHash(payload));
    expect(
      wagerPayloadHash({
        ...payload,
        money: { amount: '25.01', currency: 'BRL' },
      }),
    ).not.toBe(wagerPayloadHash(payload));
    expect(
      wagerPayloadHash({ ...payload, referenceExternalTransactionId: 'b' }),
    ).not.toBe(wagerPayloadHash(payload));
  });
});
