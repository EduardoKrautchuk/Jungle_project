import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  setDefaultTimeout,
} from 'bun:test';
import type { MikroORM } from '@mikro-orm/postgresql';
import { ConcurrencyConflictError } from '../../src/application/ports/persistence.errors.js';
import { WagerTransactionStatus } from '../../src/domain/wagering/wager-transaction.enums.js';
import {
  Db,
  migrateFresh,
  openTestOrm,
} from '../integration/persistence/support.js';
import { assertLedgerMatchesBalance } from '../messaging/support.js';
import {
  balance,
  command,
  drain,
  eventsOf,
  ledgerChainBreaks,
  ledgerDirections,
  MutableClock,
  openWallet,
  POLICY,
  stack,
  transactionRow,
  uniqueRef,
  type Stack,
  type WalletRef,
} from './support.js';

setDefaultTimeout(60_000);

let orm: MikroORM;
let db: Db;
let s: Stack;

beforeAll(async () => {
  orm = await openTestOrm();
  await migrateFresh(orm);
  db = new Db(orm);
});

afterAll(async () => {
  await orm.close(true);
});

beforeEach(async () => {
  await db.query(
    `UPDATE wager_transactions SET next_reference_attempt_at = '2100-01-01T00:00:00Z'
      WHERE status = 'PENDING_REFERENCE'`,
  );
  s = stack(orm);
});

afterEach(async () => {
  expect(await assertLedgerMatchesBalance(db)).toEqual([]);
  expect(await ledgerChainBreaks(db)).toBe(0);
});

async function pending(
  wallet: WalletRef,
  kind: 'REFUND' | 'ROLLBACK' | 'WIN',
  reference: string,
  overrides: Parameters<typeof command>[1] = {},
) {
  const result = await s.submit.execute(
    command(wallet, {
      kind,
      referenceExternalTransactionId: reference,
      ...overrides,
    }),
  );
  expect(result.status).toBe(WagerTransactionStatus.PendingReference);
  return result;
}

describe('out of order references resolved by the worker', () => {
  it('resolves a REFUND that arrived before its BET in place, keeping identity and idempotency', async () => {
    const wallet = await openWallet(s);
    const betId = uniqueRef('bet');
    const refundCommand = command(wallet, {
      kind: 'REFUND',
      referenceExternalTransactionId: betId,
    });
    const refund = await s.submit.execute(refundCommand);
    const before = await transactionRow(db, refund.transactionId);
    expect(before).toMatchObject({
      status: 'PENDING_REFERENCE',
      reference_attempts: 0,
      scheduled: 'true',
    });
    const bet = await s.submit.execute(
      command(wallet, { externalTransactionId: betId }),
    );
    expect(await balance(db, wallet.id)).toBe('75.00');
    s.clock.advance(1_000);

    expect(await drain(s)).toEqual(['PROCESSED']);

    const after = await transactionRow(db, refund.transactionId);
    expect(after).toMatchObject({
      id: before?.id,
      idempotency_key: before?.idempotency_key,
      payload_hash: before?.payload_hash,
      external_transaction_id: before?.external_transaction_id,
      status: 'PROCESSED',
      failure_code: null,
      reference_transaction_id: bet.transactionId,
      result_balance: '100.00',
      reference_attempts: 1,
      scheduled: 'false',
    });
    expect(await balance(db, wallet.id)).toBe('100.00');
    expect(await ledgerDirections(db, wallet.id)).toEqual([
      'CREDIT',
      'DEBIT',
      'CREDIT',
    ]);
    expect(await eventsOf(db, refund.transactionId)).toEqual([
      'WagerTransactionPendingReference',
      'WagerTransactionProcessed',
    ]);
    const [processed] = await db.query(
      `SELECT payload->>'correlationId' AS correlation_id
         FROM outbox_messages
        WHERE aggregate_id = ? AND event_type = 'WagerTransactionProcessed'`,
      [refund.transactionId],
    );
    expect(processed?.correlation_id).toBe(refundCommand.correlationId);

    const replay = await s.submit.execute(refundCommand);
    expect(replay).toMatchObject({
      transactionId: refund.transactionId,
      status: WagerTransactionStatus.Processed,
      idempotentReplay: true,
    });
    expect(replay.balance?.toJSON().amount).toBe('100.00');
    expect(
      (await ledgerDirections(db, wallet.id)).filter((d) => d === 'CREDIT'),
    ).toHaveLength(2);
    expect(await drain(s)).toEqual([]);
  });

  it('credits a ROLLBACK that arrived before its BET', async () => {
    const wallet = await openWallet(s);
    const betId = uniqueRef('bet');
    const rollback = await pending(wallet, 'ROLLBACK', betId);
    await s.submit.execute(command(wallet, { externalTransactionId: betId }));
    s.clock.advance(1_000);
    expect(await drain(s)).toEqual(['PROCESSED']);
    expect(await transactionRow(db, rollback.transactionId)).toMatchObject({
      status: 'PROCESSED',
      result_balance: '100.00',
    });
    expect((await ledgerDirections(db, wallet.id)).at(-1)).toBe('CREDIT');
  });

  it('debits a ROLLBACK that arrived before its WIN', async () => {
    const wallet = await openWallet(s);
    const winId = uniqueRef('win');
    const rollback = await pending(wallet, 'ROLLBACK', winId, {
      money: { amount: '40.00', currency: 'BRL' },
    });
    await s.submit.execute(
      command(wallet, {
        kind: 'WIN',
        externalTransactionId: winId,
        money: { amount: '40.00', currency: 'BRL' },
      }),
    );
    s.clock.advance(1_000);
    expect(await drain(s)).toEqual(['PROCESSED']);
    expect(await transactionRow(db, rollback.transactionId)).toMatchObject({
      status: 'PROCESSED',
      result_balance: '100.00',
    });
    expect(await ledgerDirections(db, wallet.id)).toEqual([
      'CREDIT',
      'CREDIT',
      'DEBIT',
    ]);
  });

  it('chains a ROLLBACK that arrived before a REFUND that itself waits for its BET', async () => {
    const wallet = await openWallet(s);
    const betId = uniqueRef('bet');
    const refundId = uniqueRef('refund');
    const refund = await pending(wallet, 'REFUND', betId, {
      externalTransactionId: refundId,
    });
    const rollback = await pending(wallet, 'ROLLBACK', refundId);
    s.clock.advance(1_000);
    expect((await drain(s, 1)).sort()).toEqual(['RESCHEDULED', 'RESCHEDULED']);

    await s.submit.execute(command(wallet, { externalTransactionId: betId }));
    s.clock.advance(5_000);
    await drain(s, 1);
    s.clock.advance(5_000);
    await drain(s, 1);

    expect(await transactionRow(db, refund.transactionId)).toMatchObject({
      status: 'PROCESSED',
    });
    expect(await transactionRow(db, rollback.transactionId)).toMatchObject({
      status: 'PROCESSED',
      result_balance: '75.00',
    });
    expect(await balance(db, wallet.id)).toBe('75.00');
    expect(await ledgerDirections(db, wallet.id)).toEqual([
      'CREDIT',
      'DEBIT',
      'CREDIT',
      'DEBIT',
    ]);
  });

  it('keeps waiting while the reference exists but is itself pending', async () => {
    const wallet = await openWallet(s);
    const refundId = uniqueRef('refund');
    await pending(wallet, 'REFUND', uniqueRef('missing-bet'), {
      externalTransactionId: refundId,
    });
    const rollback = await pending(wallet, 'ROLLBACK', refundId);
    s.clock.advance(1_000);
    await drain(s, 1);
    expect(await transactionRow(db, rollback.transactionId)).toMatchObject({
      status: 'PENDING_REFERENCE',
      reference_attempts: 1,
    });
    expect(await balance(db, wallet.id)).toBe('100.00');
  });
});

describe('definitive rejections', () => {
  it('rejects a reference that was itself rejected', async () => {
    const wallet = await openWallet(s, '10.00');
    const betId = uniqueRef('bet');
    const refund = await pending(wallet, 'REFUND', betId);
    const bet = await s.submit.execute(
      command(wallet, { externalTransactionId: betId }),
    );
    expect(bet.status).toBe(WagerTransactionStatus.Rejected);
    s.clock.advance(1_000);
    expect(await drain(s)).toEqual(['REJECTED']);
    expect(await transactionRow(db, refund.transactionId)).toMatchObject({
      status: 'REJECTED',
      failure_code: 'REFERENCE_NOT_PROCESSED',
    });
    expect(await eventsOf(db, refund.transactionId)).toEqual([
      'WagerTransactionPendingReference',
      'WagerTransactionRejected',
    ]);
    expect(await balance(db, wallet.id)).toBe('10.00');
  });

  it.each([
    ['wallet', 'REFERENCE_MISMATCH'],
    ['player', 'REFERENCE_MISMATCH'],
    ['round', 'REFERENCE_MISMATCH'],
    ['currency', 'REFERENCE_MISMATCH'],
    ['amount', 'REVERSAL_AMOUNT_MISMATCH'],
  ])('rejects a reference with an incompatible %s', async (field, code) => {
    const wallet = await openWallet(s);
    const sibling = await openWallet(s, '100.00', 'USD');
    const betId = uniqueRef('bet');
    const refund = await pending(wallet, 'REFUND', betId);
    const overrides: Parameters<typeof command>[1] = {
      externalTransactionId: betId,
      ...(field === 'wallet' ? { walletId: sibling.id } : {}),
      ...(field === 'player' ? { playerId: sibling.playerId } : {}),
      ...(field === 'round' ? { roundId: 'round-2' } : {}),
      ...(field === 'currency'
        ? { money: { amount: '25.00', currency: 'USD' } }
        : {}),
      ...(field === 'amount'
        ? { money: { amount: '20.00', currency: 'BRL' } }
        : {}),
    };
    await s.submit.execute(command(wallet, overrides));
    const balanceBefore = await balance(db, wallet.id);
    s.clock.advance(1_000);
    expect(await drain(s)).toEqual(['REJECTED']);
    expect(await transactionRow(db, refund.transactionId)).toMatchObject({
      status: 'REJECTED',
      failure_code: code,
    });
    expect(await balance(db, wallet.id)).toBe(balanceBefore);
  });

  it('never matches a reference from another provider and expires as REFERENCE_NOT_FOUND', async () => {
    const wallet = await openWallet(s);
    const betId = uniqueRef('bet');
    const refund = await pending(wallet, 'REFUND', betId);
    await s.submit.execute(
      command(wallet, {
        externalTransactionId: betId,
        providerId: 'provider-b',
      }),
    );
    for (let round = 0; round < POLICY.maxAttempts; round += 1) {
      s.clock.advance(POLICY.maxDelayMs);
      await drain(s, 1);
    }
    expect(await transactionRow(db, refund.transactionId)).toMatchObject({
      status: 'REJECTED',
      failure_code: 'REFERENCE_NOT_FOUND',
      reference_attempts: POLICY.maxAttempts,
    });
  });

  it('rejects a reversal whose reference was already reversed meanwhile', async () => {
    const wallet = await openWallet(s);
    const betId = uniqueRef('bet');
    const refund = await pending(wallet, 'REFUND', betId);
    await s.submit.execute(command(wallet, { externalTransactionId: betId }));
    const rollback = await s.submit.execute(
      command(wallet, {
        kind: 'ROLLBACK',
        referenceExternalTransactionId: betId,
      }),
    );
    expect(rollback.status).toBe(WagerTransactionStatus.Processed);
    s.clock.advance(1_000);
    expect(await drain(s)).toEqual(['REJECTED']);
    expect(await transactionRow(db, refund.transactionId)).toMatchObject({
      status: 'REJECTED',
      failure_code: 'ALREADY_REVERSED',
    });
    expect(await balance(db, wallet.id)).toBe('100.00');
  });
});

describe('scheduling and retries', () => {
  it('does not retry before next_reference_attempt_at and retries after it', async () => {
    const wallet = await openWallet(s);
    const refund = await pending(wallet, 'REFUND', uniqueRef('bet'));
    expect(await s.resolver.listDue(10, 'x')).toHaveLength(0);
    s.clock.advance(800);
    expect(await s.resolver.listDue(10, 'x')).toHaveLength(0);
    s.clock.advance(400);
    expect(await s.resolver.listDue(10, 'x')).toEqual([
      {
        transactionId: refund.transactionId,
        walletId: wallet.id,
        referenceAttempts: 0,
      },
    ]);
    await drain(s, 1);
    s.clock.advance(1_800);
    expect(await s.resolver.listDue(10, 'x')).toHaveLength(0);
    s.clock.advance(400);
    expect(await s.resolver.listDue(10, 'x')).toHaveLength(1);
  });

  it('exhausts attempts with REFERENCE_NOT_FOUND and a durable rejection event', async () => {
    const wallet = await openWallet(s);
    const refund = await pending(wallet, 'REFUND', uniqueRef('never'));
    const results: string[] = [];
    for (let round = 0; round < POLICY.maxAttempts + 1; round += 1) {
      s.clock.advance(POLICY.maxDelayMs);
      results.push(...(await drain(s, 1)));
    }
    expect(results).toEqual([
      'RESCHEDULED',
      'RESCHEDULED',
      'RESCHEDULED',
      'EXPIRED',
    ]);
    expect(await transactionRow(db, refund.transactionId)).toMatchObject({
      status: 'REJECTED',
      failure_code: 'REFERENCE_NOT_FOUND',
      reference_attempts: 4,
      scheduled: 'false',
      result_balance: '100.00',
    });
    expect(await eventsOf(db, refund.transactionId)).toEqual([
      'WagerTransactionPendingReference',
      'WagerTransactionRejected',
    ]);
    const [event] = await db.query(
      `SELECT payload #>> '{data,failureCode}' AS failure_code, published_at
         FROM outbox_messages
        WHERE aggregate_id = ? AND event_type = 'WagerTransactionRejected'`,
      [refund.transactionId],
    );
    expect(event).toMatchObject({
      failure_code: 'REFERENCE_NOT_FOUND',
      published_at: null,
    });
  });

  it('resumes after a restart with a fresh process stack', async () => {
    const wallet = await openWallet(s);
    const betId = uniqueRef('bet');
    const refund = await pending(wallet, 'REFUND', betId);
    s.clock.advance(1_000);
    await drain(s, 1);
    await s.submit.execute(command(wallet, { externalTransactionId: betId }));

    const restartedOrm = await openTestOrm();
    try {
      const clock = new MutableClock();
      clock.advance(10_000);
      const restarted = stack(restartedOrm, clock);
      expect(await drain(restarted)).toEqual(['PROCESSED']);
    } finally {
      await restartedOrm.close(true);
    }
    expect(await transactionRow(db, refund.transactionId)).toMatchObject({
      status: 'PROCESSED',
      reference_attempts: 2,
    });
  });

  it('treats a busy wallet as a transient failure without consuming the attempt', async () => {
    const wallet = await openWallet(s);
    const betId = uniqueRef('bet');
    const refund = await pending(wallet, 'REFUND', betId);
    await s.submit.execute(command(wallet, { externalTransactionId: betId }));
    s.clock.advance(1_000);
    const impatient = stack(orm, s.clock, { lockTimeoutMs: 200 });
    const holder = await openTestOrm();
    const em = holder.em.fork();
    try {
      await em.begin();
      await em.execute('SELECT 1 FROM wallets WHERE id = ? FOR NO KEY UPDATE', [
        wallet.id,
      ]);
      const [candidate] = await impatient.resolver.listDue(10, 'x');
      if (candidate === undefined) {
        throw new Error('expected a candidate');
      }
      let failure: unknown;
      try {
        await impatient.resolver.resolve(candidate);
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(ConcurrencyConflictError);
      await em.commit();
    } finally {
      await holder.close(true);
    }
    expect(await transactionRow(db, refund.transactionId)).toMatchObject({
      status: 'PENDING_REFERENCE',
      reference_attempts: 0,
    });
    expect(await drain(s)).toEqual(['PROCESSED']);
  });

  it('lets two concurrent resolvers settle one pending exactly once', async () => {
    const wallet = await openWallet(s);
    const betId = uniqueRef('bet');
    const refund = await pending(wallet, 'REFUND', betId);
    await s.submit.execute(command(wallet, { externalTransactionId: betId }));
    s.clock.advance(1_000);
    const otherOrm = await openTestOrm();
    try {
      const other = stack(otherOrm, s.clock);
      const [candidate] = await s.resolver.listDue(10, 'x');
      if (candidate === undefined) {
        throw new Error('expected a candidate');
      }
      const outcomes = await Promise.all([
        s.resolver.resolve(candidate),
        other.resolver.resolve(candidate),
        s.resolver.resolve(candidate),
      ]);
      expect(outcomes.map((o) => o.result).sort()).toEqual([
        'PROCESSED',
        'SKIPPED',
        'SKIPPED',
      ]);
    } finally {
      await otherOrm.close(true);
    }
    expect(await eventsOf(db, refund.transactionId)).toEqual([
      'WagerTransactionPendingReference',
      'WagerTransactionProcessed',
    ]);
    expect(
      (await ledgerDirections(db, wallet.id)).filter((d) => d === 'CREDIT'),
    ).toHaveLength(2);
  });
});
