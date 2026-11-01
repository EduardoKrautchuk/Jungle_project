import { beforeEach, describe, expect, it } from 'bun:test';
import { WagerTransactionStatus } from '../../../src/domain/wagering/wager-transaction.enums.js';
import {
  pendingReferenceDelayMs,
  ResolvePendingReference,
} from '../../../src/application/wagering/resolve-pending-reference.js';
import {
  balanceOf,
  createHarness,
  eventsFor,
  ledgerOf,
  openWallet,
  transactionRecord,
  versionOf,
  wager,
  type Harness,
} from './support/wagering-harness.js';

const POLICY = { maxAttempts: 4, baseDelayMs: 1_000, maxDelayMs: 5_000 };

let h: Harness;
let resolver: ResolvePendingReference;

beforeEach(() => {
  h = createHarness();
  resolver = new ResolvePendingReference(
    h.uow,
    h.settlement,
    h.clock,
    h.ids,
    POLICY,
  );
});

async function due() {
  return resolver.listDue(10, 'unit');
}

async function resolveAllDue() {
  const outcomes = [];
  for (const candidate of await due()) {
    outcomes.push(await resolver.resolve(candidate));
  }
  return outcomes;
}

async function pendingRefund(
  wallet: Awaited<ReturnType<typeof openWallet>>,
  reference: string,
  overrides: Parameters<typeof wager>[1] = {},
) {
  return h.submit.execute(
    wager(wallet, {
      kind: 'REFUND',
      externalTransactionId: `refund-of-${reference}`,
      referenceExternalTransactionId: reference,
      ...overrides,
    }),
  );
}

describe('pendingReferenceDelayMs', () => {
  it('grows exponentially and caps the delay', () => {
    expect(
      [1, 2, 3, 4, 10].map((n) => pendingReferenceDelayMs(POLICY, n)),
    ).toEqual([2_000, 4_000, 5_000, 5_000, 5_000]);
  });
});

describe('ResolvePendingReference', () => {
  it('ignores pendings before their next attempt and picks them once due', async () => {
    const wallet = await openWallet(h);
    await pendingRefund(wallet, 'late-bet');
    expect(await due()).toHaveLength(0);
    h.clock.advance(1_000);
    expect(await due()).toHaveLength(1);
  });

  it('reschedules a still missing reference with backoff and without moving money', async () => {
    const wallet = await openWallet(h);
    const refund = await pendingRefund(wallet, 'late-bet');
    h.clock.advance(1_000);
    const [outcome] = await resolveAllDue();
    expect(outcome).toMatchObject({
      transactionId: refund.transactionId,
      result: 'RESCHEDULED',
      attempt: 1,
    });
    expect(transactionRecord(h, refund.transactionId)).toMatchObject({
      status: 'PENDING_REFERENCE',
      referenceAttempts: 1,
    });
    expect(outcome?.nextAttemptAt?.getTime()).toBe(
      h.clock.now().getTime() + 2_000,
    );
    expect(balanceOf(h, wallet.id)).toBe('100.00');
    expect(eventsFor(h, refund.transactionId)).toEqual([
      'WagerTransactionPendingReference',
    ]);
  });

  it('resolves the original transaction in place once the reference arrives', async () => {
    const wallet = await openWallet(h);
    const refund = await pendingRefund(wallet, 'late-bet');
    const original = transactionRecord(h, refund.transactionId);
    const bet = await h.submit.execute(
      wager(wallet, { externalTransactionId: 'late-bet' }),
    );
    h.clock.advance(1_000);

    const [outcome] = await resolveAllDue();

    expect(outcome).toMatchObject({
      transactionId: refund.transactionId,
      result: 'PROCESSED',
      referenceTransactionId: bet.transactionId,
      attempt: 1,
    });
    const resolved = transactionRecord(h, refund.transactionId);
    expect(resolved).toMatchObject({
      id: original?.id,
      idempotencyKey: original?.idempotencyKey,
      payloadHash: original?.payloadHash,
      externalTransactionId: original?.externalTransactionId,
      status: 'PROCESSED',
      resultBalance: '100.00',
      referenceTransactionId: bet.transactionId,
    });
    expect(balanceOf(h, wallet.id)).toBe('100.00');
    expect(versionOf(h, wallet.id)).toBe(3);
    expect(ledgerOf(h, wallet.id).map((e) => e.direction)).toEqual([
      'CREDIT',
      'DEBIT',
      'CREDIT',
    ]);
    expect(eventsFor(h, refund.transactionId)).toEqual([
      'WagerTransactionPendingReference',
      'WagerTransactionProcessed',
    ]);
    const processed = h.uow.tables.outbox.find(
      (m) =>
        m.aggregateId === refund.transactionId &&
        m.eventType === 'WagerTransactionProcessed',
    );
    expect(processed?.payload).toMatchObject({ correlationId: 'corr-1' });

    const replay = await h.submit.execute(
      wager(wallet, {
        kind: 'REFUND',
        externalTransactionId: 'refund-of-late-bet',
        referenceExternalTransactionId: 'late-bet',
      }),
    );
    expect(replay).toMatchObject({
      transactionId: refund.transactionId,
      status: 'PROCESSED',
      idempotentReplay: true,
    });
    expect(await due()).toHaveLength(0);
  });

  it.each([
    ['another wallet', 'REFERENCE_MISMATCH'],
    ['another round', 'REFERENCE_MISMATCH'],
    ['another amount', 'REVERSAL_AMOUNT_MISMATCH'],
    ['a WIN for a REFUND', 'INVALID_REFERENCE_KIND'],
    ['a rejected BET', 'REFERENCE_NOT_PROCESSED'],
  ])('rejects a reference that turns out to be %s', async (label, code) => {
    const wallet = await openWallet(h, '10.00');
    const other = await openWallet(h, '100.00');
    await pendingRefund(wallet, 'ref', {
      roundId: label === 'another round' ? 'round-2' : 'round-1',
    });
    if (label === 'another wallet') {
      await h.submit.execute(
        wager(other, {
          externalTransactionId: 'ref',
          playerId: wallet.playerId,
        }),
      );
    } else {
      await h.submit.execute(
        wager(wallet, {
          externalTransactionId: 'ref',
          kind: label === 'a WIN for a REFUND' ? 'WIN' : 'BET',
          money: {
            amount: label === 'another amount' ? '5.00' : '25.00',
            currency: 'BRL',
          },
        }),
      );
    }
    h.clock.advance(1_000);
    const outcomes = await resolveAllDue();
    expect(outcomes.map((o) => `${o.result}:${o.failureCode ?? ''}`)).toEqual([
      `REJECTED:${code}`,
    ]);
  });

  it('rejects a reversal of an already reversed reference', async () => {
    const wallet = await openWallet(h);
    await h.submit.execute(wager(wallet, { externalTransactionId: 'bet-x' }));
    await h.submit.execute(
      wager(wallet, {
        kind: 'ROLLBACK',
        referenceExternalTransactionId: 'bet-x',
      }),
    );
    const late = await h.submit.execute(
      wager(wallet, {
        kind: 'REFUND',
        externalTransactionId: 'refund-x',
        referenceExternalTransactionId: 'bet-pending',
      }),
    );
    expect(late.status).toBe(WagerTransactionStatus.PendingReference);
    const refundOfPending = await pendingRefund(wallet, 'bet-y');
    await h.submit.execute(wager(wallet, { externalTransactionId: 'bet-y' }));
    await h.submit.execute(
      wager(wallet, {
        kind: 'ROLLBACK',
        referenceExternalTransactionId: 'bet-y',
      }),
    );
    h.clock.advance(1_000);
    const outcomes = await resolveAllDue();
    expect(
      outcomes.find((o) => o.transactionId === refundOfPending.transactionId),
    ).toMatchObject({ result: 'REJECTED', failureCode: 'ALREADY_REVERSED' });
  });

  it('expires after the attempt limit with REFERENCE_NOT_FOUND and a rejection event', async () => {
    const wallet = await openWallet(h);
    const refund = await pendingRefund(wallet, 'never');
    const results = [];
    for (let round = 0; round < POLICY.maxAttempts; round += 1) {
      h.clock.advance(POLICY.maxDelayMs);
      results.push(...(await resolveAllDue()).map((o) => o.result));
    }
    expect(results).toEqual([
      'RESCHEDULED',
      'RESCHEDULED',
      'RESCHEDULED',
      'EXPIRED',
    ]);
    expect(transactionRecord(h, refund.transactionId)).toMatchObject({
      status: 'REJECTED',
      failureCode: 'REFERENCE_NOT_FOUND',
      referenceAttempts: 4,
      nextReferenceAttemptAt: null,
    });
    expect(eventsFor(h, refund.transactionId)).toEqual([
      'WagerTransactionPendingReference',
      'WagerTransactionRejected',
    ]);
    h.clock.advance(POLICY.maxDelayMs);
    expect(await due()).toHaveLength(0);
  });

  it('expires with REFERENCE_NOT_PROCESSED when the reference exists but never settles', async () => {
    const wallet = await openWallet(h);
    await pendingRefund(wallet, 'inner');
    const rollback = await h.submit.execute(
      wager(wallet, {
        kind: 'ROLLBACK',
        externalTransactionId: 'rollback-of-refund',
        referenceExternalTransactionId: 'refund-of-inner',
      }),
    );
    expect(rollback.status).toBe(WagerTransactionStatus.PendingReference);
    for (let round = 0; round < POLICY.maxAttempts; round += 1) {
      h.clock.advance(POLICY.maxDelayMs);
      await resolveAllDue();
    }
    expect(transactionRecord(h, rollback.transactionId)).toMatchObject({
      status: 'REJECTED',
    });
    expect(['REFERENCE_NOT_PROCESSED', 'REFERENCE_NOT_FOUND']).toContain(
      transactionRecord(h, rollback.transactionId)?.failureCode ?? '',
    );
  });

  it('fences a stale candidate whose attempt was already taken', async () => {
    const wallet = await openWallet(h);
    await pendingRefund(wallet, 'late');
    h.clock.advance(1_000);
    const [candidate] = await due();
    if (candidate === undefined) {
      throw new Error('expected a candidate');
    }
    expect((await resolver.resolve(candidate)).result).toBe('RESCHEDULED');
    expect(await resolver.resolve(candidate)).toMatchObject({
      result: 'SKIPPED',
      skipReason: 'ATTEMPT_ALREADY_TAKEN',
    });
    h.clock.advance(10_000);
    expect(
      await resolver.resolve({ ...candidate, referenceAttempts: 1 }),
    ).toMatchObject({ result: 'RESCHEDULED', attempt: 2 });
  });

  it('skips a candidate already resolved by someone else', async () => {
    const wallet = await openWallet(h);
    await pendingRefund(wallet, 'late');
    await h.submit.execute(wager(wallet, { externalTransactionId: 'late' }));
    h.clock.advance(1_000);
    const [candidate] = await due();
    if (candidate === undefined) {
      throw new Error('expected a candidate');
    }
    await resolver.resolve(candidate);
    expect(await resolver.resolve(candidate)).toMatchObject({
      result: 'SKIPPED',
      skipReason: 'ALREADY_RESOLVED',
    });
    expect(ledgerOf(h, wallet.id)).toHaveLength(3);
  });

  it('rolls back everything and keeps the attempt when persistence fails', async () => {
    const wallet = await openWallet(h);
    const refund = await pendingRefund(wallet, 'late');
    await h.submit.execute(wager(wallet, { externalTransactionId: 'late' }));
    h.clock.advance(1_000);
    const [candidate] = await due();
    if (candidate === undefined) {
      throw new Error('expected a candidate');
    }
    h.uow.faults.add('outbox.enqueue');
    let failed = false;
    try {
      await resolver.resolve(candidate);
    } catch {
      failed = true;
    }
    expect(failed).toBe(true);
    expect(transactionRecord(h, refund.transactionId)).toMatchObject({
      status: 'PENDING_REFERENCE',
      referenceAttempts: 0,
    });
    expect(balanceOf(h, wallet.id)).toBe('75.00');
    h.uow.faults.clear();
    expect((await resolver.resolve(candidate)).result).toBe('PROCESSED');
    expect(balanceOf(h, wallet.id)).toBe('100.00');
  });
});
