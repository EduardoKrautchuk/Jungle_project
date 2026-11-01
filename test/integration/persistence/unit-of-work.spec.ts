import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { MikroORM } from '@mikro-orm/postgresql';
import {
  ConcurrencyConflictError,
  UniqueConstraintViolationError,
} from '../../../src/application/ports/persistence.errors.js';
import type { UnitOfWork } from '../../../src/application/ports/persistence.js';
import { MikroOrmUnitOfWork } from '../../../src/infrastructure/persistence/mikro-orm-unit-of-work.js';
import {
  applyDebit,
  deferred,
  outboxEvent,
  persistOpenedWallet,
  wagerTransaction,
} from './domain-fixtures.js';
import { Db, migrateFresh, openTestOrm } from './support.js';

let ormA: MikroORM;
let ormB: MikroORM;
let uow: UnitOfWork;
let observer: Db;

async function snapshot(walletId: string, transactionId: string) {
  const [wallet] = await observer.query(
    'SELECT balance, version FROM wallets WHERE id = ?',
    [walletId],
  );
  const transactions = await observer.query(
    'SELECT status FROM wager_transactions WHERE id = ?',
    [transactionId],
  );
  const ledger = await observer.query(
    'SELECT 1 FROM wallet_ledger_entries WHERE transaction_id = ?',
    [transactionId],
  );
  const outbox = await observer.query(
    'SELECT event_type FROM outbox_messages WHERE aggregate_id = ?',
    [transactionId],
  );
  return {
    wallet,
    transactions: transactions.length,
    ledger: ledger.length,
    outbox: outbox.length,
  };
}

describe('MikroOrmUnitOfWork atomicity', () => {
  beforeAll(async () => {
    ormA = await openTestOrm();
    ormB = await openTestOrm();
    await migrateFresh(ormA);
    uow = new MikroOrmUnitOfWork(ormA.em);
    observer = new Db(ormB);
  });

  afterAll(async () => {
    await ormA.close(true);
    await ormB.close(true);
  });

  it('commits wallet, transaction, ledger and outbox together', async () => {
    const wallet = await persistOpenedWallet(uow);
    const bet = wagerTransaction(wallet);

    expect(await applyDebit(uow, bet)).toEqual({
      outcome: 'PROCESSED',
      balance: '75.00',
    });
    expect(await snapshot(wallet.id, bet.id)).toEqual({
      wallet: { balance: '75.00', version: 2 },
      transactions: 1,
      ledger: 1,
      outbox: 1,
    });
  });

  it('rolls back the claim and wallet update when the ledger insert fails', async () => {
    const wallet = await persistOpenedWallet(uow);
    const bet = wagerTransaction(wallet);

    let caught: unknown;
    try {
      await uow.run(async (r) => {
        await r.transactions.claim({
          transaction: bet,
          resultBalance: undefined,
          referenceAttempts: 0,
          nextReferenceAttemptAt: undefined,
        });
        const locked = await r.wallets.findByIdForUpdate(wallet.id);
        if (!locked) {
          throw new Error('wallet missing');
        }
        const entry = locked.debit(bet.money, {
          entryId: randomUUID(),
          transactionId: bet.id,
          at: new Date(),
        });
        await r.wallets.update(locked, 1);
        await r.outbox.enqueue(outboxEvent(bet.id, 'WalletBalanceChanged'));
        await r.ledger.append(entry);
        await r.ledger.append(entry);
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(UniqueConstraintViolationError);
    expect(await snapshot(wallet.id, bet.id)).toEqual({
      wallet: { balance: '100.00', version: 1 },
      transactions: 0,
      ledger: 0,
      outbox: 0,
    });
  });

  it('rolls back the claim, wallet update, ledger and outbox when the last write fails', async () => {
    const wallet = await persistOpenedWallet(uow);
    const bet = wagerTransaction(wallet);
    const duplicateEvent = outboxEvent(randomUUID(), 'Existing');
    await uow.run((r) => r.outbox.enqueue(duplicateEvent));

    let caught: unknown;
    try {
      await uow.run(async (r) => {
        const claim = await r.transactions.claim({
          transaction: bet,
          resultBalance: undefined,
          referenceAttempts: 0,
          nextReferenceAttemptAt: undefined,
        });
        expect(claim.outcome).toBe('CREATED');
        const locked = await r.wallets.findByIdForUpdate(wallet.id);
        if (!locked) {
          throw new Error('wallet missing');
        }
        const entry = locked.debit(bet.money, {
          entryId: randomUUID(),
          transactionId: bet.id,
          at: new Date(),
        });
        await r.wallets.update(locked, 1);
        await r.ledger.append(entry);
        await r.outbox.enqueue(duplicateEvent);
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(UniqueConstraintViolationError);
    expect(await snapshot(wallet.id, bet.id)).toEqual({
      wallet: { balance: '100.00', version: 1 },
      transactions: 0,
      ledger: 0,
      outbox: 0,
    });
  });

  it('rolls back everything when the work throws after all writes', async () => {
    const wallet = await persistOpenedWallet(uow);
    const bet = wagerTransaction(wallet);
    const failure = new Error('crash before commit');

    let caught: unknown;
    try {
      await uow.run(async (r) => {
        await r.transactions.claim({
          transaction: bet,
          resultBalance: undefined,
          referenceAttempts: 0,
          nextReferenceAttemptAt: undefined,
        });
        const locked = await r.wallets.findByIdForUpdate(wallet.id);
        if (!locked) {
          throw new Error('wallet missing');
        }
        const entry = locked.debit(bet.money, {
          entryId: randomUUID(),
          transactionId: bet.id,
          at: new Date(),
        });
        await r.wallets.update(locked, 1);
        await r.ledger.append(entry);
        await r.outbox.enqueue(outboxEvent(bet.id, 'WalletBalanceChanged'));
        throw failure;
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBe(failure);
    expect(await snapshot(wallet.id, bet.id)).toEqual({
      wallet: { balance: '100.00', version: 1 },
      transactions: 0,
      ledger: 0,
      outbox: 0,
    });
  });

  it('keeps outbox events invisible to other connections until commit', async () => {
    const wallet = await persistOpenedWallet(uow);
    const bet = wagerTransaction(wallet);
    const written = deferred();
    const release = deferred();

    const pending = applyDebit(uow, bet, {
      afterLock: async () => {
        written.resolve();
        await release.promise;
      },
    });
    await written.promise;

    const duringTransaction = await snapshot(wallet.id, bet.id);
    expect(duringTransaction.outbox).toBe(0);
    expect(duringTransaction.transactions).toBe(0);
    expect(duringTransaction.wallet).toEqual({ balance: '100.00', version: 1 });

    release.resolve();
    await pending;
    expect(await snapshot(wallet.id, bet.id)).toEqual({
      wallet: { balance: '75.00', version: 2 },
      transactions: 1,
      ledger: 1,
      outbox: 1,
    });
  });

  describe('runWithWalletLock', () => {
    it('holds the wallet row lock before handing out the repositories', async () => {
      const wallet = await persistOpenedWallet(uow);
      const inside = deferred();
      const release = deferred();

      const holder = uow.runWithWalletLock(
        wallet.id,
        async ({ wallet: locked }) => {
          expect(locked?.id).toBe(wallet.id);
          inside.resolve();
          await release.promise;
        },
      );
      await inside.promise;
      let lockError: unknown;
      try {
        await observer.query(
          'SELECT id FROM wallets WHERE id = ? FOR NO KEY UPDATE NOWAIT',
          [wallet.id],
        );
      } catch (error) {
        lockError = error;
      }
      const keyShare = await observer.query(
        'SELECT id FROM wallets WHERE id = ? FOR KEY SHARE NOWAIT',
        [wallet.id],
      );
      release.resolve();
      await holder;

      expect(lockError).toMatchObject({ code: '55P03' });
      expect(keyShare).toHaveLength(1);
    });

    it('passes undefined when the wallet does not exist', async () => {
      const result = await uow.runWithWalletLock(randomUUID(), async (scope) =>
        scope.wallet === undefined ? 'missing' : 'found',
      );
      expect(result).toBe('missing');
    });

    it('gives up after the lock timeout without writing anything', async () => {
      const wallet = await persistOpenedWallet(uow);
      const impatient = new MikroOrmUnitOfWork(ormB.em, { lockTimeoutMs: 200 });
      const inside = deferred();
      const release = deferred();
      const bet = wagerTransaction(wallet);

      const holder = uow.runWithWalletLock(wallet.id, async () => {
        inside.resolve();
        await release.promise;
      });
      await inside.promise;

      let caught: unknown;
      const startedAt = Date.now();
      try {
        await impatient.runWithWalletLock(
          wallet.id,
          async ({ repositories }) => {
            await repositories.transactions.claim({
              transaction: bet,
              resultBalance: undefined,
              referenceAttempts: 0,
              nextReferenceAttemptAt: undefined,
            });
          },
        );
      } catch (error) {
        caught = error;
      }
      const waited = Date.now() - startedAt;
      release.resolve();
      await holder;

      expect(caught).toBeInstanceOf(ConcurrencyConflictError);
      expect(waited).toBeGreaterThanOrEqual(150);
      expect(waited).toBeLessThan(3_000);
      expect(await snapshot(wallet.id, bet.id)).toEqual({
        wallet: { balance: '100.00', version: 1 },
        transactions: 0,
        ledger: 0,
        outbox: 0,
      });
    });

    it('rejects an invalid lock timeout', () => {
      expect(
        () => new MikroOrmUnitOfWork(ormA.em, { lockTimeoutMs: 0 }),
      ).toThrow(RangeError);
    });
  });
});
