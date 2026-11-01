import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { ResolvePendingReference } from '../../src/application/wagering/resolve-pending-reference.js';
import { WagerSettlement } from '../../src/application/wagering/wager-settlement.js';
import { MikroOrmUnitOfWork } from '../../src/infrastructure/persistence/mikro-orm-unit-of-work.js';
import { UuidV7Generator } from '../../src/infrastructure/runtime/system-runtime.js';
import { MutableClock } from '../pending/support.js';
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

beforeAll(async () => {
  t = await startTestApp();
});

afterAll(async () => {
  await t.close();
});

const brl = (amount: string) => ({ amount, currency: 'BRL' });

async function createWallet(): Promise<WalletRef> {
  const playerId = uniqueId('player');
  const response = await t
    .http()
    .post('/wallets')
    .send({ playerId, initialBalance: brl('100.00') });
  expect(response.status).toBe(201);
  return { id: text(json(response.body).id), playerId };
}

function send(body: WagerBody, key = keyOf(body)) {
  return t
    .http()
    .post('/wagering/transactions')
    .set('Idempotency-Key', key)
    .send(body);
}

async function runWorker(maxAttempts: number): Promise<string[]> {
  const ids = new UuidV7Generator();
  const clock = new MutableClock();
  clock.advance(10 * 60_000);
  const resolver = new ResolvePendingReference(
    new MikroOrmUnitOfWork(t.orm.em),
    new WagerSettlement(ids),
    clock,
    ids,
    { maxAttempts, baseDelayMs: 1_000, maxDelayMs: 1_000 },
  );
  const results: string[] = [];
  for (const candidate of await resolver.listDue(100, 'e2e')) {
    results.push((await resolver.resolve(candidate)).result);
  }
  return results;
}

async function parkPending() {
  await t.db.query(
    `UPDATE wager_transactions SET next_reference_attempt_at = '2100-01-01T00:00:00Z'
      WHERE status = 'PENDING_REFERENCE'`,
  );
}

describe('replaying a request that was accepted as PENDING_REFERENCE', () => {
  it('answers 202 while pending and the settled 200 result once the worker resolves it', async () => {
    await parkPending();
    const wallet = await createWallet();
    const betId = uniqueId('bet');
    const refund = wagerBody(wallet, {
      kind: 'REFUND',
      referenceExternalTransactionId: betId,
    });

    const first = await send(refund);
    expect(first.status).toBe(202);
    const accepted = json(first.body);
    expect(accepted).toMatchObject({
      status: 'PENDING_REFERENCE',
      balance: brl('100.00'),
      idempotentReplay: false,
    });

    const whilePending = await send(refund);
    expect(whilePending.status).toBe(202);
    expect(json(whilePending.body)).toEqual({
      ...accepted,
      idempotentReplay: true,
    });

    expect(
      (await send(wagerBody(wallet, { externalTransactionId: betId }))).status,
    ).toBe(200);
    expect(await runWorker(12)).toEqual(['PROCESSED']);

    const settled = await send(refund);
    expect(settled.status).toBe(200);
    const result = json(settled.body);
    expect(result).toEqual({
      transactionId: accepted.transactionId,
      status: 'PROCESSED',
      balance: brl('100.00'),
      idempotentReplay: true,
    });
    const again = await send(refund);
    expect(again.status).toBe(200);
    expect(json(again.body)).toEqual(result);

    const query = await t
      .http()
      .get(`/wagering/transactions/${text(accepted.transactionId)}`);
    expect(json(query.body)).toMatchObject({
      status: 'PROCESSED',
      balance: brl('100.00'),
    });

    const conflicting = await send({ ...refund, money: brl('24.00') });
    expect(conflicting.status).toBe(409);
    expect(json(conflicting.body).error).toMatchObject({
      code: 'IDEMPOTENCY_CONFLICT',
    });
    const [credits] = await t.db.query(
      "SELECT count(*)::int AS n FROM wallet_ledger_entries WHERE wallet_id = ? AND direction = 'CREDIT'",
      [wallet.id],
    );
    expect(credits?.n).toBe(2);
  });

  it('answers 422 REFERENCE_NOT_FOUND after exhaustion and requires a new externalTransactionId for a retry', async () => {
    await parkPending();
    const wallet = await createWallet();
    const betId = uniqueId('bet');
    const refund = wagerBody(wallet, {
      kind: 'REFUND',
      referenceExternalTransactionId: betId,
    });
    const first = await send(refund);
    expect(first.status).toBe(202);
    const transactionId = text(json(first.body).transactionId);

    expect(await runWorker(1)).toEqual(['EXPIRED']);

    const expired = await send(refund);
    expect(expired.status).toBe(422);
    expect(json(expired.body)).toEqual({
      transactionId,
      status: 'REJECTED',
      failureCode: 'REFERENCE_NOT_FOUND',
      balance: brl('100.00'),
      idempotentReplay: true,
    });

    expect(
      (await send(wagerBody(wallet, { externalTransactionId: betId }))).status,
    ).toBe(200);

    const sameOperationNewKey = await send(refund, `${keyOf(refund)}:retry`);
    expect(sameOperationNewKey.status).toBe(409);
    expect(json(sameOperationNewKey.body).error).toMatchObject({
      code: 'IDEMPOTENCY_CONFLICT',
    });

    const newOperation = await send({
      ...refund,
      externalTransactionId: `${refund.externalTransactionId}-retry`,
    });
    expect(newOperation.status).toBe(200);
    expect(json(newOperation.body)).toMatchObject({
      status: 'PROCESSED',
      balance: brl('100.00'),
      idempotentReplay: false,
    });
    expect(text(json(newOperation.body).transactionId)).not.toBe(transactionId);

    const [rows] = await t.db.query(
      `SELECT count(*) FILTER (WHERE status = 'PROCESSED')::int AS processed,
              count(*) FILTER (WHERE status = 'REJECTED')::int AS rejected
         FROM wager_transactions WHERE wallet_id = ? AND kind = 'REFUND'`,
      [wallet.id],
    );
    expect(rows).toMatchObject({ processed: 1, rejected: 1 });
  });
});
