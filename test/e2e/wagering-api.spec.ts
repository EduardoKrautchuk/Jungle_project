import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test';
import type { Db } from '../integration/persistence/support.js';
import {
  json,
  keyOf,
  startTestApp,
  text,
  uniqueId,
  wagerBody,
  type TestApp,
  type WagerBody,
  type WalletRef,
} from './support.js';

let t: TestApp;
let db: Db;

beforeAll(async () => {
  t = await startTestApp();
  db = t.db;
});

afterAll(async () => {
  await db.query(
    'DROP TRIGGER IF EXISTS e2e_fail_ledger ON wallet_ledger_entries',
  );
  await db.query('DROP TRIGGER IF EXISTS e2e_fail_outbox ON outbox_messages');
  await db.query('DROP FUNCTION IF EXISTS e2e_raise_failure()');
  await t.close();
});

afterEach(async () => {
  const drift = await db.query(`
    SELECT w.id FROM wallets w
     WHERE w.balance <> coalesce((
       SELECT sum(CASE direction WHEN 'CREDIT' THEN amount ELSE -amount END)
         FROM wallet_ledger_entries l WHERE l.wallet_id = w.id), 0)`);
  expect(drift).toEqual([]);
});

const brl = (amount: string) => ({ amount, currency: 'BRL' });

async function createWallet(amount = '100.00'): Promise<WalletRef> {
  const playerId = uniqueId('player');
  const response = await t
    .http()
    .post('/wallets')
    .send({ playerId, initialBalance: brl(amount) });
  expect(response.status).toBe(201);
  return { id: text(json(response.body).id), playerId };
}

function submit(body: object, key?: string) {
  const call = t.http().post('/wagering/transactions');
  return key === undefined
    ? call.send(body)
    : call.set('Idempotency-Key', key).send(body);
}

const send = (body: WagerBody) => submit(body, keyOf(body));

async function balance(walletId: string): Promise<string> {
  const [row] = await db.query(
    'SELECT balance::text AS balance FROM wallets WHERE id = ?',
    [walletId],
  );
  return text(row?.balance);
}

async function count(sql: string, params: unknown[]): Promise<number> {
  const [row] = await db.query(`SELECT count(*)::int AS n FROM ${sql}`, params);
  return Number(row?.n);
}

const ledgerRows = (walletId: string) =>
  count('wallet_ledger_entries WHERE wallet_id = ?', [walletId]);

const outboxRows = (aggregateId: string) =>
  count('outbox_messages WHERE aggregate_id = ?', [aggregateId]);

async function transactionRow(id: string) {
  const [row] = await db.query(
    `SELECT kind, status, failure_code, amount::text AS amount,
            result_balance::text AS result_balance, reference_transaction_id,
            reference_attempts, next_reference_attempt_at
       FROM wager_transactions WHERE id = ?`,
    [id],
  );
  return row;
}

describe('POST /wallets', () => {
  it('creates the wallet with OPENING transaction, ledger and events atomically', async () => {
    const playerId = uniqueId('player');
    const response = await t
      .http()
      .post('/wallets')
      .send({ playerId, initialBalance: brl('1000.00') });

    expect(response.status).toBe(201);
    const body = json(response.body);
    expect(body).toEqual({
      id: body.id,
      playerId,
      balance: brl('1000.00'),
      version: 1,
    });
    const walletId = text(body.id);
    expect(await balance(walletId)).toBe('1000.00');
    expect(await ledgerRows(walletId)).toBe(1);
    expect(
      await count(
        "wager_transactions WHERE wallet_id = ? AND kind = 'OPENING'",
        [walletId],
      ),
    ).toBe(1);
    expect(await outboxRows(walletId)).toBe(1);
  });

  it('answers 409 for a duplicate player wallet without writing anything', async () => {
    const wallet = await createWallet('10.00');
    const response = await t
      .http()
      .post('/wallets')
      .send({ playerId: wallet.playerId, initialBalance: brl('5.00') });
    expect(response.status).toBe(409);
    expect(json(response.body).error).toMatchObject({
      code: 'WALLET_ALREADY_EXISTS',
    });
    expect(await count('wallets WHERE player_id = ?', [wallet.playerId])).toBe(
      1,
    );
  });
});

describe('POST /wagering/transactions', () => {
  it('processes a BET end to end', async () => {
    const wallet = await createWallet();
    const body = wagerBody(wallet);
    const response = await send(body);

    expect(response.status).toBe(200);
    const result = json(response.body);
    expect(result).toEqual({
      transactionId: result.transactionId,
      status: 'PROCESSED',
      balance: brl('75.00'),
      idempotentReplay: false,
    });
    expect(response.headers['x-correlation-id']).toBeString();
    const id = text(result.transactionId);
    expect(await balance(wallet.id)).toBe('75.00');
    expect(await ledgerRows(wallet.id)).toBe(2);
    expect(await outboxRows(id)).toBe(1);
    expect(await outboxRows(wallet.id)).toBe(2);
    expect(await transactionRow(id)).toMatchObject({
      status: 'PROCESSED',
      result_balance: '75.00',
    });

    const fetched = await t.http().get(`/wagering/transactions/${id}`);
    expect(fetched.status).toBe(200);
    expect(json(fetched.body)).toMatchObject({
      transactionId: id,
      status: 'PROCESSED',
      kind: 'BET',
      money: brl('25.00'),
      balance: brl('75.00'),
      failureCode: null,
    });
    const byExternal = await t
      .http()
      .get(
        `/providers/provider-a/wagering/transactions/${body.externalTransactionId}`,
      );
    expect(json(byExternal.body).transactionId).toBe(id);
  });

  it('processes a WIN linked to its BET', async () => {
    const wallet = await createWallet();
    const bet = wagerBody(wallet);
    const betId = text(json((await send(bet)).body).transactionId);
    const response = await send(
      wagerBody(wallet, {
        kind: 'WIN',
        money: brl('60.00'),
        referenceExternalTransactionId: bet.externalTransactionId,
      }),
    );
    expect(response.status).toBe(200);
    const id = text(json(response.body).transactionId);
    expect(await balance(wallet.id)).toBe('135.00');
    expect(await ledgerRows(wallet.id)).toBe(3);
    expect(await transactionRow(id)).toMatchObject({
      status: 'PROCESSED',
      reference_transaction_id: betId,
    });
  });

  it('records a LOSS without moving money or writing ledger', async () => {
    const wallet = await createWallet();
    await send(wagerBody(wallet));
    const response = await send(
      wagerBody(wallet, { kind: 'LOSS', money: brl('0.00') }),
    );
    expect(response.status).toBe(200);
    const id = text(json(response.body).transactionId);
    expect(json(response.body).balance).toEqual(brl('75.00'));
    expect(await balance(wallet.id)).toBe('75.00');
    expect(await ledgerRows(wallet.id)).toBe(2);
    expect(await outboxRows(id)).toBe(1);
    const [row] = await db.query('SELECT version FROM wallets WHERE id = ?', [
      wallet.id,
    ]);
    expect(row?.version).toBe(2);
  });

  it('refunds a BET exactly once', async () => {
    const wallet = await createWallet();
    const bet = wagerBody(wallet);
    await send(bet);
    const refund = wagerBody(wallet, {
      kind: 'REFUND',
      referenceExternalTransactionId: bet.externalTransactionId,
    });
    expect((await send(refund)).status).toBe(200);
    expect(await balance(wallet.id)).toBe('100.00');

    const again = await send(
      wagerBody(wallet, {
        kind: 'REFUND',
        referenceExternalTransactionId: bet.externalTransactionId,
      }),
    );
    expect(again.status).toBe(422);
    expect(json(again.body)).toMatchObject({
      status: 'REJECTED',
      failureCode: 'ALREADY_REVERSED',
    });
    expect(await balance(wallet.id)).toBe('100.00');
    expect(await ledgerRows(wallet.id)).toBe(3);
  });

  it.each([
    ['BET', 'BET', '25.00', '100.00', 'CREDIT'],
    ['WIN', 'WIN', '30.00', '100.00', 'DEBIT'],
  ])(
    'rolls back a %s',
    async (_label, kind, amount, expectedBalance, direction) => {
      const wallet = await createWallet();
      const original = wagerBody(wallet, { kind, money: brl(amount) });
      await send(original);
      const response = await send(
        wagerBody(wallet, {
          kind: 'ROLLBACK',
          money: brl(amount),
          referenceExternalTransactionId: original.externalTransactionId,
        }),
      );
      expect(response.status).toBe(200);
      expect(await balance(wallet.id)).toBe(expectedBalance);
      const [last] = await db.query(
        'SELECT direction FROM wallet_ledger_entries WHERE wallet_id = ? ORDER BY created_at DESC, id DESC LIMIT 1',
        [wallet.id],
      );
      expect(last?.direction).toBe(direction);
    },
  );

  it('rolls back a REFUND by debiting it again', async () => {
    const wallet = await createWallet();
    const bet = wagerBody(wallet);
    await send(bet);
    const refund = wagerBody(wallet, {
      kind: 'REFUND',
      referenceExternalTransactionId: bet.externalTransactionId,
    });
    await send(refund);
    const response = await send(
      wagerBody(wallet, {
        kind: 'ROLLBACK',
        referenceExternalTransactionId: refund.externalTransactionId,
      }),
    );
    expect(response.status).toBe(200);
    expect(await balance(wallet.id)).toBe('75.00');
    expect(await ledgerRows(wallet.id)).toBe(4);
  });

  it('rejects an overdrawing reversal with its own failure code', async () => {
    const wallet = await createWallet('0.00');
    const win = wagerBody(wallet, { kind: 'WIN', money: brl('50.00') });
    await send(win);
    await send(wagerBody(wallet, { money: brl('40.00') }));
    const response = await send(
      wagerBody(wallet, {
        kind: 'ROLLBACK',
        money: brl('50.00'),
        referenceExternalTransactionId: win.externalTransactionId,
      }),
    );
    expect(response.status).toBe(422);
    expect(json(response.body).failureCode).toBe('REVERSAL_WOULD_OVERDRAW');
    expect(await balance(wallet.id)).toBe('10.00');
  });

  it('rejects insufficient funds with 422 and an auditable row', async () => {
    const wallet = await createWallet('10.00');
    const response = await send(wagerBody(wallet));
    expect(response.status).toBe(422);
    const result = json(response.body);
    expect(result).toMatchObject({
      status: 'REJECTED',
      failureCode: 'INSUFFICIENT_FUNDS',
      balance: brl('10.00'),
      idempotentReplay: false,
    });
    const id = text(result.transactionId);
    expect(await transactionRow(id)).toMatchObject({
      status: 'REJECTED',
      failure_code: 'INSUFFICIENT_FUNDS',
    });
    expect(await balance(wallet.id)).toBe('10.00');
    expect(await ledgerRows(wallet.id)).toBe(1);
    expect(await outboxRows(id)).toBe(1);
  });

  it.each([
    ['negative', '-1.00', 'MONEY_INVALID_AMOUNT'],
    ['three decimals', '1.005', 'MONEY_INVALID_AMOUNT'],
    ['scientific', '1e2', 'MONEY_INVALID_AMOUNT'],
    ['empty', '', 'MONEY_INVALID_AMOUNT'],
    ['too large', '1000000000000000000.00', 'MONEY_INVALID_AMOUNT'],
  ])('rejects a %s amount with 400', async (_label, amount, code) => {
    const wallet = await createWallet();
    const before = await count('wager_transactions', []);
    const response = await send(wagerBody(wallet, { money: brl(amount) }));
    expect(response.status).toBe(400);
    expect(json(response.body).error).toMatchObject({
      code: 'VALIDATION_FAILED',
      details: [expect.objectContaining({ field: 'money', code })],
    });
    expect(await count('wager_transactions', [])).toBe(before);
  });

  it('rejects a numeric amount with 400', async () => {
    const wallet = await createWallet();
    const body = {
      ...wagerBody(wallet),
      money: { amount: 25, currency: 'BRL' },
    };
    const response = await submit(body, 'provider-a:numeric');
    expect(response.status).toBe(400);
    expect(json(response.body).error).toMatchObject({
      details: [
        expect.objectContaining({
          field: 'money.amount',
          code: 'INVALID_TYPE',
        }),
      ],
    });
  });

  it('rejects an incomplete payload and a missing Idempotency-Key with 400', async () => {
    const wallet = await createWallet();
    const { roundId: _roundId, ...incomplete } = wagerBody(wallet);
    const response = await submit(incomplete);
    expect(response.status).toBe(400);
    const error = json(json(response.body).error);
    expect(error.code).toBe('VALIDATION_FAILED');
    expect(error.details).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ field: 'roundId', code: 'REQUIRED' }),
        expect.objectContaining({
          field: 'header.Idempotency-Key',
          code: 'REQUIRED',
        }),
      ]),
    );
  });

  it('rejects malformed JSON with 400 without leaking parser details', async () => {
    const response = await t
      .http()
      .post('/wagering/transactions')
      .set('Content-Type', 'application/json')
      .set('Idempotency-Key', 'k')
      .send('{"providerId":');
    expect(response.status).toBe(400);
    expect(json(response.body)).toEqual({
      error: {
        code: 'MALFORMED_REQUEST',
        message: 'The request could not be parsed',
      },
    });
  });

  it.each([
    ['blank', ''],
    ['with spaces', 'provider a'],
    ['reserved internal', '_internal'],
    ['too long', 'p'.repeat(65)],
  ])('rejects a %s providerId with 400', async (_label, providerId) => {
    const wallet = await createWallet();
    const response = await submit(
      wagerBody(wallet, { providerId }),
      'provider-key',
    );
    expect(response.status).toBe(400);
    expect(json(response.body).error).toMatchObject({
      details: [expect.objectContaining({ field: 'providerId' })],
    });
  });

  it('rejects an internal OPENING submitted by a provider', async () => {
    const wallet = await createWallet();
    const response = await send(wagerBody(wallet, { kind: 'OPENING' }));
    expect(response.status).toBe(400);
  });

  it('parks a reversal whose reference has not arrived as PENDING_REFERENCE with 202', async () => {
    const wallet = await createWallet();
    const response = await send(
      wagerBody(wallet, {
        kind: 'REFUND',
        referenceExternalTransactionId: uniqueId('missing'),
      }),
    );
    expect(response.status).toBe(202);
    const result = json(response.body);
    expect(result.status).toBe('PENDING_REFERENCE');
    const id = text(result.transactionId);
    const row = await transactionRow(id);
    expect(row).toMatchObject({
      status: 'PENDING_REFERENCE',
      reference_attempts: 0,
      reference_transaction_id: null,
    });
    expect(row?.next_reference_attempt_at).not.toBeNull();
    expect(await balance(wallet.id)).toBe('100.00');
    expect(await ledgerRows(wallet.id)).toBe(1);
    const [event] = await db.query(
      'SELECT event_type FROM outbox_messages WHERE aggregate_id = ?',
      [id],
    );
    expect(event?.event_type).toBe('WagerTransactionPendingReference');
  });

  it('keeps a reversal pending while its reference is itself pending', async () => {
    const wallet = await createWallet();
    const refund = wagerBody(wallet, {
      kind: 'REFUND',
      referenceExternalTransactionId: uniqueId('missing'),
    });
    await send(refund);
    const response = await send(
      wagerBody(wallet, {
        kind: 'ROLLBACK',
        referenceExternalTransactionId: refund.externalTransactionId,
      }),
    );
    expect(response.status).toBe(202);
    expect(json(response.body).status).toBe('PENDING_REFERENCE');
  });

  it.each([
    ['another round', { roundId: 'round-2' }, 'REFERENCE_MISMATCH'],
    ['another amount', { money: brl('10.00') }, 'REVERSAL_AMOUNT_MISMATCH'],
  ])('rejects a reference from %s', async (_label, overrides, failureCode) => {
    const wallet = await createWallet();
    const bet = wagerBody(wallet);
    await send(bet);
    const response = await send(
      wagerBody(wallet, {
        kind: 'REFUND',
        referenceExternalTransactionId: bet.externalTransactionId,
        ...overrides,
      }),
    );
    expect(response.status).toBe(422);
    expect(json(response.body).failureCode).toBe(failureCode);
    expect(await balance(wallet.id)).toBe('75.00');
  });

  it('rejects a reference that belongs to another player wallet', async () => {
    const owner = await createWallet();
    const other = await createWallet();
    const bet = wagerBody(owner);
    await send(bet);
    const response = await send(
      wagerBody(other, {
        kind: 'REFUND',
        referenceExternalTransactionId: bet.externalTransactionId,
      }),
    );
    expect(response.status).toBe(422);
    expect(json(response.body).failureCode).toBe('REFERENCE_MISMATCH');
    expect(await balance(other.id)).toBe('100.00');
  });

  it('rejects an unknown wallet and a foreign wallet without revealing balances', async () => {
    const wallet = await createWallet();
    const unknown = await send(
      wagerBody(wallet, { walletId: '0192f291-27dd-7d3f-8071-000000000000' }),
    );
    expect(unknown.status).toBe(422);
    expect(json(unknown.body)).toMatchObject({
      failureCode: 'WALLET_NOT_FOUND',
      balance: null,
    });
    const foreign = await send(
      wagerBody(wallet, { playerId: uniqueId('intruder') }),
    );
    expect(json(foreign.body)).toMatchObject({
      failureCode: 'WALLET_PLAYER_MISMATCH',
      balance: null,
    });
    expect(await balance(wallet.id)).toBe('100.00');
  });

  it('replays a success with the original result and no new effects', async () => {
    const wallet = await createWallet();
    const body = wagerBody(wallet);
    const first = json((await send(body)).body);
    await send(wagerBody(wallet, { money: brl('5.00') }));
    const ledgerBefore = await ledgerRows(wallet.id);
    const outboxBefore = await count('outbox_messages', []);

    const replay = await send(body);
    expect(replay.status).toBe(200);
    expect(json(replay.body)).toEqual({ ...first, idempotentReplay: true });
    expect(await balance(wallet.id)).toBe('70.00');
    expect(await ledgerRows(wallet.id)).toBe(ledgerBefore);
    expect(await count('outbox_messages', [])).toBe(outboxBefore);
  });

  it('replays a rejection with the original status code and failure', async () => {
    const wallet = await createWallet('10.00');
    const body = wagerBody(wallet);
    const first = await send(body);
    await send(wagerBody(wallet, { kind: 'WIN', money: brl('90.00') }));
    const replay = await send(body);
    expect(replay.status).toBe(first.status);
    expect(json(replay.body)).toEqual({
      ...json(first.body),
      idempotentReplay: true,
    });
    expect(json(replay.body).balance).toEqual(brl('10.00'));
  });

  it('answers 409 when the same key carries another payload', async () => {
    const wallet = await createWallet();
    const body = wagerBody(wallet);
    await send(body);
    const response = await submit(
      { ...body, money: brl('26.00') },
      keyOf(body),
    );
    expect(response.status).toBe(409);
    expect(json(response.body).error).toMatchObject({
      code: 'IDEMPOTENCY_CONFLICT',
    });
    expect(await balance(wallet.id)).toBe('75.00');
    expect(
      await count('wager_transactions WHERE external_transaction_id = ?', [
        body.externalTransactionId,
      ]),
    ).toBe(1);
  });

  it('answers 409 when the externalTransactionId repeats under another key', async () => {
    const wallet = await createWallet();
    const body = wagerBody(wallet);
    await send(body);
    const response = await submit(body, `${keyOf(body)}:retry`);
    expect(response.status).toBe(409);
    expect(await balance(wallet.id)).toBe('75.00');
    expect(await ledgerRows(wallet.id)).toBe(2);
  });

  it('debits once for 50 identical requests sent in parallel', async () => {
    const wallet = await createWallet();
    const body = wagerBody(wallet);
    const responses = await Promise.all(
      Array.from({ length: 50 }, () => send(body)),
    );
    expect(responses.map((r) => r.status)).toEqual(Array(50).fill(200));
    const results = responses.map((r) => json(r.body));
    expect(results.filter((r) => r.idempotentReplay === false)).toHaveLength(1);
    expect(new Set(results.map((r) => r.transactionId)).size).toBe(1);
    expect(
      results.every(
        (r) => JSON.stringify(r.balance) === JSON.stringify(brl('75.00')),
      ),
    ).toBe(true);
    expect(await balance(wallet.id)).toBe('75.00');
    expect(await ledgerRows(wallet.id)).toBe(2);
    expect(await outboxRows(text(results[0]?.transactionId))).toBe(1);
  });

  it('lets exactly one of two parallel 80.00 bets win a 100.00 balance', async () => {
    const wallet = await createWallet();
    const responses = await Promise.all([
      send(wagerBody(wallet, { money: brl('80.00') })),
      send(wagerBody(wallet, { money: brl('80.00') })),
    ]);
    expect(responses.map((r) => r.status).sort((a, b) => a - b)).toEqual([
      200, 422,
    ]);
    const rejected = responses.find((r) => r.status === 422);
    expect(json(rejected?.body).failureCode).toBe('INSUFFICIENT_FUNDS');
    expect(await balance(wallet.id)).toBe('20.00');
    expect(
      await count(
        "wallet_ledger_entries WHERE wallet_id = ? AND direction = 'DEBIT'",
        [wallet.id],
      ),
    ).toBe(1);
  });
});

describe('balance limit', () => {
  const MAX = '999999999999999999.99';

  async function version(walletId: string): Promise<number> {
    const [row] = await db.query('SELECT version FROM wallets WHERE id = ?', [
      walletId,
    ]);
    return Number(row?.version);
  }

  it('rejects a WIN beyond the maximum balance with 422 and no financial effect', async () => {
    const wallet = await createWallet(MAX);
    const outboxBefore = await outboxRows(wallet.id);
    const body = wagerBody(wallet, { kind: 'WIN', money: brl('0.01') });

    const response = await send(body);

    expect(response.status).toBe(422);
    const result = json(response.body);
    expect(result).toMatchObject({
      status: 'REJECTED',
      failureCode: 'BALANCE_LIMIT_EXCEEDED',
      balance: brl(MAX),
      idempotentReplay: false,
    });
    const id = text(result.transactionId);
    expect(await transactionRow(id)).toMatchObject({
      kind: 'WIN',
      status: 'REJECTED',
      failure_code: 'BALANCE_LIMIT_EXCEEDED',
      result_balance: MAX,
    });
    expect(await balance(wallet.id)).toBe(MAX);
    expect(await version(wallet.id)).toBe(1);
    expect(await ledgerRows(wallet.id)).toBe(1);
    expect(await outboxRows(wallet.id)).toBe(outboxBefore);
    expect(
      await count('outbox_messages WHERE aggregate_id = ? AND event_type = ?', [
        id,
        'WagerTransactionRejected',
      ]),
    ).toBe(1);
    expect(await outboxRows(id)).toBe(1);

    const replay = await send(body);
    expect(replay.status).toBe(422);
    expect(json(replay.body)).toMatchObject({
      transactionId: id,
      failureCode: 'BALANCE_LIMIT_EXCEEDED',
      idempotentReplay: true,
    });
    expect(await outboxRows(id)).toBe(1);
    expect(
      await count('wager_transactions WHERE wallet_id = ?', [wallet.id]),
    ).toBe(2);
  });

  it('rejects a reversal credit beyond the maximum without consuming its reference', async () => {
    const wallet = await createWallet(MAX);
    const bet = wagerBody(wallet);
    expect((await send(bet)).status).toBe(200);
    expect(
      (await send(wagerBody(wallet, { kind: 'WIN', money: brl('25.00') })))
        .status,
    ).toBe(200);

    const blocked = await send(
      wagerBody(wallet, {
        kind: 'ROLLBACK',
        referenceExternalTransactionId: bet.externalTransactionId,
      }),
    );
    expect(blocked.status).toBe(422);
    expect(json(blocked.body).failureCode).toBe('BALANCE_LIMIT_EXCEEDED');
    expect(await balance(wallet.id)).toBe(MAX);
    expect(await version(wallet.id)).toBe(3);
    expect(await ledgerRows(wallet.id)).toBe(3);

    expect((await send(wagerBody(wallet))).status).toBe(200);
    const retry = await send(
      wagerBody(wallet, {
        kind: 'ROLLBACK',
        referenceExternalTransactionId: bet.externalTransactionId,
      }),
    );
    expect(retry.status).toBe(200);
    expect(await balance(wallet.id)).toBe(MAX);
    expect(await ledgerRows(wallet.id)).toBe(5);
  });

  it('reconciles a wallet whose lifetime credits exceed the Money range', async () => {
    const wallet = await createWallet(MAX);
    expect((await send(wagerBody(wallet, { money: brl(MAX) }))).status).toBe(
      200,
    );
    expect(
      (await send(wagerBody(wallet, { kind: 'WIN', money: brl(MAX) }))).status,
    ).toBe(200);
    const response = await t
      .http()
      .post(`/wallets/${wallet.id}/reconciliation`);
    expect(response.status).toBe(200);
    expect(json(response.body)).toMatchObject({
      storedBalance: brl(MAX),
      calculatedBalance: brl(MAX),
      difference: brl('0.00'),
      consistent: true,
      checkedEntries: 3,
    });
  });
});

describe('persistence failures', () => {
  beforeAll(async () => {
    await db.query(`
      CREATE OR REPLACE FUNCTION e2e_raise_failure() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION 'e2e injected failure on %', TG_TABLE_NAME;
      END;
      $$`);
  });

  async function expectAtomicFailureThenRecovery(
    trigger: string,
    table: string,
    condition: string,
  ): Promise<void> {
    const wallet = await createWallet();
    const body = wagerBody(wallet, { money: brl('13.13') });
    const before = {
      transactions: await count('wager_transactions', []),
      outbox: await count('outbox_messages', []),
    };
    await db.query(
      `CREATE TRIGGER ${trigger} BEFORE INSERT ON ${table}
         FOR EACH ROW WHEN (${condition}) EXECUTE FUNCTION e2e_raise_failure()`,
    );
    const failed = await send(body);
    await db.query(`DROP TRIGGER ${trigger} ON ${table}`);

    expect(failed.status).toBe(500);
    expect(json(failed.body)).toEqual({
      error: { code: 'INTERNAL_ERROR', message: 'Internal server error' },
    });
    expect(await balance(wallet.id)).toBe('100.00');
    expect(await ledgerRows(wallet.id)).toBe(1);
    expect(await count('wager_transactions', [])).toBe(before.transactions);
    expect(await count('outbox_messages', [])).toBe(before.outbox);

    const retry = await send(body);
    expect(retry.status).toBe(200);
    expect(json(retry.body).idempotentReplay).toBe(false);
    expect(await balance(wallet.id)).toBe('86.87');
    expect(await ledgerRows(wallet.id)).toBe(2);
  }

  it('rolls back wallet and transaction when the ledger insert fails', async () => {
    await expectAtomicFailureThenRecovery(
      'e2e_fail_ledger',
      'wallet_ledger_entries',
      'NEW.amount = 13.13',
    );
  });

  it('rolls back wallet, ledger and transaction when the outbox insert fails', async () => {
    await expectAtomicFailureThenRecovery(
      'e2e_fail_outbox',
      'outbox_messages',
      "NEW.event_type = 'WalletBalanceChanged' AND NEW.payload->'data'->'money'->>'amount' = '13.13'",
    );
  });
});

describe('queries', () => {
  it('pages the ledger with an opaque cursor and validates parameters', async () => {
    const wallet = await createWallet();
    for (let i = 0; i < 3; i += 1) {
      await send(wagerBody(wallet, { money: brl('1.00') }));
    }
    const first = await t.http().get(`/wallets/${wallet.id}/ledger?limit=2`);
    expect(first.status).toBe(200);
    const page = json(first.body);
    expect(page.entries).toHaveLength(2);
    const second = await t
      .http()
      .get(`/wallets/${wallet.id}/ledger`)
      .query({ limit: '2', cursor: text(page.nextCursor) });
    const next = json(second.body);
    expect(next.entries).toHaveLength(2);
    expect(next.nextCursor).toBeNull();

    expect(
      (await t.http().get(`/wallets/${wallet.id}/ledger?limit=0`)).status,
    ).toBe(400);
    expect(
      (await t.http().get(`/wallets/${wallet.id}/ledger?cursor=nope`)).status,
    ).toBe(400);
  });

  it('reconciles the stored balance against the ledger', async () => {
    const wallet = await createWallet();
    await send(wagerBody(wallet));
    const response = await t
      .http()
      .post(`/wallets/${wallet.id}/reconciliation`);
    expect(response.status).toBe(200);
    expect(json(response.body)).toEqual({
      walletId: wallet.id,
      storedBalance: brl('75.00'),
      calculatedBalance: brl('75.00'),
      difference: brl('0.00'),
      consistent: true,
      checkedEntries: 2,
    });
  });

  it('answers 404 and 400 with stable codes', async () => {
    const missing = '0192f291-27dd-7d3f-8071-000000000001';
    const cases: [string, number, string][] = [
      [`/wallets/${missing}`, 404, 'WALLET_NOT_FOUND'],
      [`/wallets/not-a-uuid`, 400, 'VALIDATION_FAILED'],
      [`/wagering/transactions/${missing}`, 404, 'TRANSACTION_NOT_FOUND'],
      [
        `/providers/provider-a/wagering/transactions/nope`,
        404,
        'TRANSACTION_NOT_FOUND',
      ],
      ['/unknown-route', 404, 'ROUTE_NOT_FOUND'],
    ];
    for (const [path, status, code] of cases) {
      const response = await t.http().get(path);
      expect(response.status).toBe(status);
      expect(json(json(response.body).error).code).toBe(code);
    }
  });

  it('keeps the health endpoints working', async () => {
    expect((await t.http().get('/health/live')).status).toBe(200);
    expect(json((await t.http().get('/health/ready')).body)).toEqual({
      status: 'ok',
      checks: { postgres: 'up' },
    });
  });
});
