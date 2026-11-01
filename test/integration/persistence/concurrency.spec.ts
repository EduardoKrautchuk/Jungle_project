import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { MikroORM } from '@mikro-orm/postgresql';
import type { UnitOfWork } from '../../../src/application/ports/persistence.js';
import { MikroOrmUnitOfWork } from '../../../src/infrastructure/persistence/mikro-orm-unit-of-work.js';
import {
  applyDebit,
  brl,
  deferred,
  persistOpenedWallet,
  sha256,
  sleep,
  stored,
  wagerTransaction,
} from './domain-fixtures.js';
import { Db, migrateFresh, openTestOrm } from './support.js';

let ormA: MikroORM;
let ormB: MikroORM;
let instanceA: UnitOfWork;
let instanceB: UnitOfWork;
let observer: Db;

async function ledgerOf(walletId: string) {
  return observer.query(
    `SELECT direction, amount, balance_before, balance_after
     FROM wallet_ledger_entries WHERE wallet_id = ? ORDER BY balance_before DESC, created_at`,
    [walletId],
  );
}

async function walletRow(walletId: string) {
  const [row] = await observer.query(
    'SELECT balance, version FROM wallets WHERE id = ?',
    [walletId],
  );
  return row;
}

async function rebuiltBalance(walletId: string): Promise<string> {
  const [row] = await observer.query(
    `SELECT COALESCE(SUM(CASE direction WHEN 'CREDIT' THEN amount ELSE -amount END), 0)::numeric(20,2)::text AS total
     FROM wallet_ledger_entries WHERE wallet_id = ?`,
    [walletId],
  );
  return String(row?.total);
}

describe('concurrency across independent connection pools', () => {
  beforeAll(async () => {
    ormA = await openTestOrm();
    ormB = await openTestOrm();
    await migrateFresh(ormA);
    instanceA = new MikroOrmUnitOfWork(ormA.em);
    instanceB = new MikroOrmUnitOfWork(ormB.em);
    observer = new Db(ormA);
  });

  afterAll(async () => {
    await ormA.close(true);
    await ormB.close(true);
  });

  it('blocks a second instance on the wallet row lock until the first commits', async () => {
    const wallet = await persistOpenedWallet(instanceA);
    const locked = deferred();
    const timeline: string[] = [];

    const first = applyDebit(instanceA, wagerTransaction(wallet), {
      afterLock: async () => {
        timeline.push('A locked');
        locked.resolve();
        await sleep(300);
        timeline.push('A releasing');
      },
    });
    await locked.promise;
    const second = applyDebit(instanceB, wagerTransaction(wallet), {
      afterLock: async () => {
        timeline.push('B locked');
      },
    });

    const [resultA, resultB] = await Promise.all([first, second]);
    expect(timeline).toEqual(['A locked', 'A releasing', 'B locked']);
    expect(resultA).toEqual({ outcome: 'PROCESSED', balance: '75.00' });
    expect(resultB).toEqual({ outcome: 'PROCESSED', balance: '50.00' });
    expect(await walletRow(wallet.id)).toEqual({
      balance: '50.00',
      version: 3,
    });
  });

  it.each([1, 2, 3, 4, 5])(
    'run %p: two simultaneous 80.00 bets on 100.00 debit exactly once',
    async () => {
      const wallet = await persistOpenedWallet(instanceA, '100.00');
      const results = await Promise.all([
        applyDebit(
          instanceA,
          wagerTransaction(wallet, { money: brl('80.00') }),
        ),
        applyDebit(
          instanceB,
          wagerTransaction(wallet, { money: brl('80.00') }),
        ),
      ]);

      expect(results.map((r) => r.outcome).sort()).toEqual([
        'PROCESSED',
        'REJECTED',
      ]);
      expect(await walletRow(wallet.id)).toEqual({
        balance: '20.00',
        version: 2,
      });
      const ledger = await ledgerOf(wallet.id);
      expect(ledger.filter((e) => e.direction === 'DEBIT')).toEqual([
        {
          direction: 'DEBIT',
          amount: '80.00',
          balance_before: '100.00',
          balance_after: '20.00',
        },
      ]);
      const statuses = await observer.query(
        `SELECT status, failure_code FROM wager_transactions
         WHERE wallet_id = ? AND kind = 'BET' ORDER BY status`,
        [wallet.id],
      );
      expect(statuses).toEqual([
        { status: 'PROCESSED', failure_code: null },
        { status: 'REJECTED', failure_code: 'INSUFFICIENT_FUNDS' },
      ]);
    },
  );

  it.each([1, 2, 3, 4, 5])(
    'run %p: does not deadlock when a wallet reference is written before the lock',
    async () => {
      const wallet = await persistOpenedWallet(instanceA, '100.00');
      const claimThenLock = (instance: UnitOfWork) =>
        instance.run(async (r) => {
          const bet = wagerTransaction(wallet, { money: brl('80.00') });
          await r.transactions.claim(stored(bet));
          await sleep(50);
          const locked = await r.wallets.findByIdForUpdate(wallet.id);
          if (!locked) {
            throw new Error('wallet missing');
          }
          if (locked.balance.isLessThan(bet.money)) {
            return 'INSUFFICIENT';
          }
          const expectedVersion = locked.version;
          const entry = locked.debit(bet.money, {
            entryId: crypto.randomUUID(),
            transactionId: bet.id,
            at: new Date(),
          });
          await r.wallets.update(locked, expectedVersion);
          await r.ledger.append(entry);
          return 'DEBITED';
        });

      const results = await Promise.all([
        claimThenLock(instanceA),
        claimThenLock(instanceB),
      ]);
      expect(results.sort()).toEqual(['DEBITED', 'INSUFFICIENT']);
      expect(await walletRow(wallet.id)).toEqual({
        balance: '20.00',
        version: 2,
      });
    },
  );

  it('serializes many concurrent debits from two instances without lost updates', async () => {
    const wallet = await persistOpenedWallet(instanceA, '100.00');
    const bets = Array.from({ length: 24 }, () =>
      wagerTransaction(wallet, { money: brl('5.00') }),
    );
    const results = await Promise.all(
      bets.map((bet, index) =>
        applyDebit(index % 2 === 0 ? instanceA : instanceB, bet),
      ),
    );

    expect(results.filter((r) => r.outcome === 'PROCESSED')).toHaveLength(20);
    expect(results.filter((r) => r.outcome === 'REJECTED')).toHaveLength(4);
    expect(await walletRow(wallet.id)).toEqual({
      balance: '0.00',
      version: 21,
    });
    expect(await rebuiltBalance(wallet.id)).toBe('0.00');

    const debits = (await ledgerOf(wallet.id)).filter(
      (e) => e.direction === 'DEBIT',
    );
    expect(debits).toHaveLength(20);
    for (let i = 1; i < debits.length; i += 1) {
      expect(debits[i]?.balance_before).toBe(debits[i - 1]?.balance_after);
    }
  }, 30_000);

  it('turns the same request sent 50 times in parallel into a single debit', async () => {
    const wallet = await persistOpenedWallet(instanceA, '100.00');
    const template = wagerTransaction(wallet);
    const copies = Array.from({ length: 50 }, () =>
      wagerTransaction(wallet, {
        externalTransactionId: template.externalTransactionId,
        idempotencyKey: template.idempotencyKey,
        payloadHash: template.payloadHash,
      }),
    );

    const results = await Promise.all(
      copies.map((copy, index) =>
        applyDebit(index % 2 === 0 ? instanceA : instanceB, copy),
      ),
    );

    expect(results.filter((r) => r.outcome === 'PROCESSED')).toHaveLength(1);
    expect(results.filter((r) => r.outcome === 'REPLAY')).toHaveLength(49);
    expect(await walletRow(wallet.id)).toEqual({
      balance: '75.00',
      version: 2,
    });
    expect(
      (await ledgerOf(wallet.id)).filter((e) => e.direction === 'DEBIT'),
    ).toHaveLength(1);
    expect(await rebuiltBalance(wallet.id)).toBe('75.00');
  }, 30_000);

  it('makes a concurrent claim with the same key wait and then replay', async () => {
    const wallet = await persistOpenedWallet(instanceA);
    const original = wagerTransaction(wallet);
    const duplicate = wagerTransaction(wallet, {
      externalTransactionId: original.externalTransactionId,
      idempotencyKey: original.idempotencyKey,
      payloadHash: original.payloadHash,
    });
    const claimed = deferred();
    const timeline: string[] = [];

    const first = applyDebit(instanceA, original, {
      afterLock: async () => {
        claimed.resolve();
        await sleep(250);
        timeline.push('A committing');
      },
    });
    await claimed.promise;
    const second = applyDebit(instanceB, duplicate).then((result) => {
      timeline.push(`B ${result.outcome}`);
      return result;
    });

    expect(await first).toEqual({ outcome: 'PROCESSED', balance: '75.00' });
    expect(await second).toEqual({
      outcome: 'REPLAY',
      status: 'PROCESSED',
      balance: '75.00',
    });
    expect(timeline).toEqual(['A committing', 'B REPLAY']);
  });

  it('reports a conflict when the concurrent claim carries another payload', async () => {
    const wallet = await persistOpenedWallet(instanceA);
    const original = wagerTransaction(wallet);
    const tampered = wagerTransaction(wallet, {
      externalTransactionId: original.externalTransactionId,
      idempotencyKey: original.idempotencyKey,
      payloadHash: sha256('tampered'),
      money: brl('99.00'),
    });

    const results = await Promise.all([
      applyDebit(instanceA, original),
      applyDebit(instanceB, tampered),
    ]);
    const outcomes = results.map((r) => r.outcome).sort();
    expect(outcomes).toEqual(['CONFLICT', 'PROCESSED']);
    expect(
      (await ledgerOf(wallet.id)).filter((e) => e.direction === 'DEBIT'),
    ).toHaveLength(1);
  });

  it('lets the waiting claim win when the first transaction rolls back', async () => {
    const wallet = await persistOpenedWallet(instanceA);
    const original = wagerTransaction(wallet);
    const retry = wagerTransaction(wallet, {
      externalTransactionId: original.externalTransactionId,
      idempotencyKey: original.idempotencyKey,
      payloadHash: original.payloadHash,
    });
    const claimed = deferred();

    const failing = applyDebit(instanceA, original, {
      afterLock: async () => {
        claimed.resolve();
        await sleep(200);
        throw new Error('instance A crashed before commit');
      },
    }).catch((error: unknown) => error);
    await claimed.promise;
    const recovering = applyDebit(instanceB, retry);

    expect(await failing).toBeInstanceOf(Error);
    expect(await recovering).toEqual({
      outcome: 'PROCESSED',
      balance: '75.00',
    });
    expect(await walletRow(wallet.id)).toEqual({
      balance: '75.00',
      version: 2,
    });
  });
});
