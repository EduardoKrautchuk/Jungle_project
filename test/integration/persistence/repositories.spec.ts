import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { MikroORM } from '@mikro-orm/postgresql';
import {
  ConcurrencyConflictError,
  IntegrityConstraintViolationError,
  UniqueConstraintViolationError,
} from '../../../src/application/ports/persistence.errors.js';
import type { UnitOfWork } from '../../../src/application/ports/persistence.js';
import { LedgerDirection } from '../../../src/domain/ledger/ledger-direction.js';
import { WalletLedgerEntry } from '../../../src/domain/ledger/wallet-ledger-entry.js';
import { InboxMessage } from '../../../src/domain/messaging/inbox-message.js';
import {
  FailureCode,
  WagerTransactionKind,
  WagerTransactionStatus,
} from '../../../src/domain/wagering/wager-transaction.enums.js';
import { Wallet } from '../../../src/domain/wallet/wallet.js';
import { MikroOrmUnitOfWork } from '../../../src/infrastructure/persistence/mikro-orm-unit-of-work.js';
import { MikroOrmLedgerRepository } from '../../../src/infrastructure/persistence/repositories/ledger.repository.js';
import {
  LATER,
  NOW,
  applyDebit,
  brl,
  outboxEvent,
  persistOpenedWallet,
  sha256,
  stored,
  wagerTransaction,
} from './domain-fixtures.js';
import { Db, migrateFresh, openTestOrm } from './support.js';

const MAX = '999999999999999999.99';

let orm: MikroORM;
let uow: UnitOfWork;
let db: Db;

async function expectRejection<E extends Error>(
  action: Promise<unknown>,
  type: new (...args: never[]) => E,
): Promise<E> {
  let caught: unknown;
  try {
    await action;
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(type);
  if (!(caught instanceof type)) {
    throw new Error('unreachable');
  }
  return caught;
}

describe('MikroORM repositories', () => {
  beforeAll(async () => {
    orm = await openTestOrm();
    await migrateFresh(orm);
    uow = new MikroOrmUnitOfWork(orm.em);
    db = new Db(orm);
  });

  afterAll(async () => {
    await orm.close(true);
  });

  describe('wallets', () => {
    it('persists and restores a wallet with exact state', async () => {
      const wallet = await persistOpenedWallet(uow, '1234.56');
      const restored = await uow.run((r) => r.wallets.findById(wallet.id));

      expect(restored).toBeInstanceOf(Wallet);
      expect(restored?.playerId).toBe(wallet.playerId);
      expect(restored?.currency).toBe('BRL');
      expect(restored?.balance.toJSON()).toEqual({
        amount: '1234.56',
        currency: 'BRL',
      });
      expect(restored?.version).toBe(1);
      expect(restored?.createdAt).toEqual(NOW);
      expect(restored?.updatedAt).toEqual(NOW);
    });

    it('finds a wallet by player and currency', async () => {
      const wallet = await persistOpenedWallet(uow);
      const found = await uow.run((r) =>
        r.wallets.findByPlayerAndCurrency(wallet.playerId, 'BRL'),
      );
      expect(found?.id).toBe(wallet.id);
      expect(
        await uow.run((r) =>
          r.wallets.findByPlayerAndCurrency(wallet.playerId, 'USD'),
        ),
      ).toBeUndefined();
    });

    it('returns undefined for a missing wallet', async () => {
      expect(
        await uow.run((r) => r.wallets.findById(randomUUID())),
      ).toBeUndefined();
    });

    it('stores the Money limit exactly', async () => {
      const wallet = await persistOpenedWallet(uow, MAX);
      const [row] = await db.query('SELECT balance FROM wallets WHERE id = ?', [
        wallet.id,
      ]);
      expect(row?.balance).toBe(MAX);
      const restored = await uow.run((r) => r.wallets.findById(wallet.id));
      expect(restored?.balance.toJSON().amount).toBe(MAX);
    });

    it('increments the version once per balance change', async () => {
      const wallet = await persistOpenedWallet(uow);
      await applyDebit(uow, wagerTransaction(wallet));
      await applyDebit(uow, wagerTransaction(wallet));
      const restored = await uow.run((r) => r.wallets.findById(wallet.id));
      expect(restored?.version).toBe(3);
      expect(restored?.balance.toJSON().amount).toBe('50.00');
      expect(restored?.updatedAt).toEqual(LATER);
    });

    it('refuses an update based on a stale version', async () => {
      const wallet = await persistOpenedWallet(uow);
      await applyDebit(uow, wagerTransaction(wallet));
      wallet.credit(brl('1.00'), {
        entryId: randomUUID(),
        transactionId: randomUUID(),
        at: LATER,
      });
      await expectRejection(
        uow.run((r) => r.wallets.update(wallet, 1)),
        ConcurrencyConflictError,
      );
      const restored = await uow.run((r) => r.wallets.findById(wallet.id));
      expect(restored?.balance.toJSON().amount).toBe('75.00');
    });

    it('translates a duplicate player wallet into a unique violation', async () => {
      const wallet = await persistOpenedWallet(uow, '0.00');
      const { wallet: duplicate } = Wallet.open({
        id: randomUUID(),
        playerId: wallet.playerId,
        initialBalance: brl('0.00'),
        at: NOW,
      });
      const error = await expectRejection(
        uow.run((r) => r.wallets.insert(duplicate)),
        UniqueConstraintViolationError,
      );
      expect(error.constraint).toBe('wallets_player_currency_uq');
    });
  });

  describe('wager transactions', () => {
    it('persists and restores a pending transaction', async () => {
      const wallet = await persistOpenedWallet(uow);
      const transaction = wagerTransaction(wallet, { money: brl('0.01') });
      await uow.run((r) => r.transactions.insert(stored(transaction)));

      const restored = await uow.run((r) =>
        r.transactions.findById(transaction.id),
      );
      expect(restored?.transaction.status).toBe(WagerTransactionStatus.Pending);
      expect(restored?.transaction.money.toJSON()).toEqual({
        amount: '0.01',
        currency: 'BRL',
      });
      expect(restored?.transaction.payloadHash).toBe(transaction.payloadHash);
      expect(restored?.transaction.createdAt).toEqual(NOW);
      expect(restored?.resultBalance).toBeUndefined();
      expect(restored?.referenceAttempts).toBe(0);
    });

    it('persists the processed result needed for replay', async () => {
      const wallet = await persistOpenedWallet(uow);
      const bet = wagerTransaction(wallet);
      await applyDebit(uow, bet);

      const restored = await uow.run((r) => r.transactions.findById(bet.id));
      expect(restored?.transaction.status).toBe(
        WagerTransactionStatus.Processed,
      );
      expect(restored?.transaction.processedAt).toEqual(LATER);
      expect(restored?.resultBalance?.toJSON().amount).toBe('75.00');
    });

    it('persists rejections with their failure code', async () => {
      const wallet = await persistOpenedWallet(uow, '10.00');
      const bet = wagerTransaction(wallet);
      expect(await applyDebit(uow, bet)).toEqual({
        outcome: 'REJECTED',
        balance: '10.00',
      });
      const restored = await uow.run((r) => r.transactions.findById(bet.id));
      expect(restored?.transaction.failureCode).toBe(
        FailureCode.InsufficientFunds,
      );
      expect(restored?.resultBalance?.toJSON().amount).toBe('10.00');
    });

    it('finds transactions by idempotency key and by external id', async () => {
      const wallet = await persistOpenedWallet(uow);
      const bet = wagerTransaction(wallet);
      await uow.run((r) => r.transactions.insert(stored(bet)));

      const byKey = await uow.run((r) =>
        r.transactions.findByIdempotencyKey('provider-a', bet.idempotencyKey),
      );
      const byExternal = await uow.run((r) =>
        r.transactions.findByExternalId(
          'provider-a',
          bet.externalTransactionId,
        ),
      );
      expect(byKey?.transaction.id).toBe(bet.id);
      expect(byExternal?.transaction.id).toBe(bet.id);
      expect(
        await uow.run((r) =>
          r.transactions.findByIdempotencyKey('provider-b', bet.idempotencyKey),
        ),
      ).toBeUndefined();
    });

    it('classifies idempotent claims', async () => {
      const wallet = await persistOpenedWallet(uow);
      const first = wagerTransaction(wallet);
      const props = {
        externalTransactionId: first.externalTransactionId,
        idempotencyKey: first.idempotencyKey,
      };

      expect(await uow.run((r) => r.transactions.claim(stored(first)))).toEqual(
        { outcome: 'CREATED' },
      );

      const replay = await uow.run((r) =>
        r.transactions.claim(
          stored(
            wagerTransaction(wallet, {
              ...props,
              payloadHash: first.payloadHash,
            }),
          ),
        ),
      );
      expect(replay.outcome).toBe('REPLAY');

      const conflict = await uow.run((r) =>
        r.transactions.claim(
          stored(
            wagerTransaction(wallet, {
              ...props,
              payloadHash: sha256('other'),
            }),
          ),
        ),
      );
      expect(conflict.outcome).toBe('CONFLICT');

      const sameExternalOtherKey = await uow.run((r) =>
        r.transactions.claim(
          stored(
            wagerTransaction(wallet, {
              externalTransactionId: first.externalTransactionId,
              payloadHash: first.payloadHash,
            }),
          ),
        ),
      );
      expect(sameExternalOtherKey.outcome).toBe('CONFLICT');
      if (replay.outcome === 'REPLAY') {
        expect(replay.existing.transaction.id).toBe(first.id);
      }
    });

    it('finds processed reversals and translates a duplicate reversal', async () => {
      const wallet = await persistOpenedWallet(uow);
      const bet = wagerTransaction(wallet);
      await applyDebit(uow, bet);

      const refund = (externalTransactionId: string) => {
        const transaction = wagerTransaction(wallet, {
          kind: WagerTransactionKind.Refund,
          externalTransactionId,
          idempotencyKey: `provider-a:${externalTransactionId}`,
          referenceExternalTransactionId: bet.externalTransactionId,
        });
        transaction.markProcessed(bet.id, LATER);
        return stored(transaction, brl('100.00'));
      };

      const first = refund(`ext-${randomUUID()}`);
      await uow.run((r) => r.transactions.insert(first));
      const found = await uow.run((r) =>
        r.transactions.findProcessedReversalOf(bet.id),
      );
      expect(found?.transaction.id).toBe(first.transaction.id);

      const error = await expectRejection(
        uow.run((r) => r.transactions.insert(refund(`ext-${randomUUID()}`))),
        UniqueConstraintViolationError,
      );
      expect(error.constraint).toBe('wager_tx_single_reversal_uq');
    });

    it('refuses a status update when the stored status changed', async () => {
      const wallet = await persistOpenedWallet(uow);
      const bet = wagerTransaction(wallet);
      await uow.run((r) => r.transactions.insert(stored(bet)));

      const firstWorker = await uow.run((r) => r.transactions.findById(bet.id));
      const secondWorker = await uow.run((r) =>
        r.transactions.findById(bet.id),
      );
      if (!firstWorker || !secondWorker) {
        throw new Error('transaction not persisted');
      }
      firstWorker.transaction.fail(FailureCode.ProcessingFailed);
      await uow.run((r) =>
        r.transactions.update(firstWorker, WagerTransactionStatus.Pending),
      );

      secondWorker.transaction.reject(FailureCode.InsufficientFunds);
      await expectRejection(
        uow.run((r) =>
          r.transactions.update(secondWorker, WagerTransactionStatus.Pending),
        ),
        ConcurrencyConflictError,
      );
      const restored = await uow.run((r) => r.transactions.findById(bet.id));
      expect(restored?.transaction.status).toBe(WagerTransactionStatus.Failed);
      expect(restored?.transaction.failureCode).toBe(
        FailureCode.ProcessingFailed,
      );
    });

    it('locks due pending references in schedule order', async () => {
      const wallet = await persistOpenedWallet(uow);
      const pending = (minutes: number) => {
        const refund = wagerTransaction(wallet, {
          kind: WagerTransactionKind.Refund,
          referenceExternalTransactionId: `ext-missing-${randomUUID()}`,
        });
        refund.markPendingReference();
        return {
          ...stored(refund),
          referenceAttempts: 1,
          nextReferenceAttemptAt: new Date(NOW.getTime() + minutes * 60_000),
        };
      };
      const later = pending(10);
      const due = pending(-1);
      await uow.run(async (r) => {
        await r.transactions.insert(later);
        await r.transactions.insert(due);
      });
      const locked = await uow.run((r) =>
        r.transactions.lockDuePendingReferences(NOW, 10),
      );
      const ids = locked.map((s) => s.transaction.id);
      expect(ids).toContain(due.transaction.id);
      expect(ids).not.toContain(later.transaction.id);
      const restored = locked.find(
        (s) => s.transaction.id === due.transaction.id,
      );
      expect(restored?.referenceAttempts).toBe(1);
      expect(restored?.nextReferenceAttemptAt).toEqual(
        due.nextReferenceAttemptAt,
      );
    });
  });

  describe('ledger', () => {
    it('appends immutable entries and pages them by cursor', async () => {
      const wallet = await persistOpenedWallet(uow);
      const bets = [wagerTransaction(wallet), wagerTransaction(wallet)];
      for (const bet of bets) {
        await applyDebit(uow, bet);
      }

      const firstPage = await uow.run((r) =>
        r.ledger.listByWallet(wallet.id, { limit: 2 }),
      );
      expect(firstPage).toHaveLength(2);
      expect(firstPage.every((e) => e instanceof WalletLedgerEntry)).toBe(true);
      expect(firstPage.every((e) => e.isBalanced())).toBe(true);
      const last = firstPage.at(-1);
      expect(last).toBeDefined();
      const secondPage = await uow.run((r) =>
        r.ledger.listByWallet(wallet.id, {
          limit: 10,
          after: last ? { createdAt: last.createdAt, id: last.id } : undefined,
        }),
      );
      const all = [...firstPage, ...secondPage];
      expect(all).toHaveLength(3);
      expect(new Set(all.map((e) => e.id)).size).toBe(3);
      expect(all.map((e) => e.balanceAfter.toJSON().amount).sort()).toEqual([
        '100.00',
        '50.00',
        '75.00',
      ]);
    });

    it('finds the entry of a transaction with exact amounts', async () => {
      const wallet = await persistOpenedWallet(uow);
      const bet = wagerTransaction(wallet, { money: brl('33.33') });
      await applyDebit(uow, bet);
      const entry = await uow.run((r) =>
        r.ledger.findByWalletAndTransaction(wallet.id, bet.id),
      );
      expect(entry?.direction).toBe(LedgerDirection.Debit);
      expect(entry?.money.toJSON().amount).toBe('33.33');
      expect(entry?.balanceBefore.toJSON().amount).toBe('100.00');
      expect(entry?.balanceAfter.toJSON().amount).toBe('66.67');
    });

    it('translates a ledger entry for a missing transaction into an integrity error', async () => {
      const wallet = await persistOpenedWallet(uow);
      const entry = WalletLedgerEntry.create({
        id: randomUUID(),
        walletId: wallet.id,
        transactionId: randomUUID(),
        direction: LedgerDirection.Credit,
        money: brl('1.00'),
        balanceBefore: brl('100.00'),
        balanceAfter: brl('101.00'),
        createdAt: LATER,
      });
      const error = await expectRejection(
        uow.run((r) => r.ledger.append(entry)),
        IntegrityConstraintViolationError,
      );
      expect(error.constraint).toBe('ledger_transaction_fk');
      expect(error.sqlState).toBe('23503');
    });

    it('exposes only append and read operations', () => {
      const methods = Object.getOwnPropertyNames(
        MikroOrmLedgerRepository.prototype,
      ).filter((name) => name !== 'constructor');
      expect(methods.sort()).toEqual([
        'append',
        'findByWalletAndTransaction',
        'listByWallet',
      ]);
    });
  });

  describe('inbox', () => {
    const message = (
      overrides: Partial<{ messageId: string; payloadHash: string }> = {},
    ) =>
      InboxMessage.receive({
        consumerName: 'wager-transactions',
        messageId: overrides.messageId ?? `msg-${randomUUID()}`,
        payloadHash: overrides.payloadHash ?? sha256('payload'),
        receivedAt: NOW,
      });

    it('records a message once and reports duplicates with the original', async () => {
      const first = message();
      expect(await uow.run((r) => r.inbox.receive(first))).toEqual({
        outcome: 'RECEIVED',
      });
      const duplicate = await uow.run((r) =>
        r.inbox.receive(
          message({ messageId: first.messageId, payloadHash: sha256('other') }),
        ),
      );
      expect(duplicate.outcome).toBe('DUPLICATE');
      if (duplicate.outcome === 'DUPLICATE') {
        expect(duplicate.existing.payloadHash).toBe(first.payloadHash);
        expect(duplicate.existing.receivedAt).toEqual(NOW);
      }
    });

    it('marks a message processed exactly once', async () => {
      const received = message();
      await uow.run((r) => r.inbox.receive(received));
      received.markProcessed(LATER);
      await uow.run((r) => r.inbox.markProcessed(received));

      const restored = await uow.run((r) =>
        r.inbox.find(received.consumerName, received.messageId),
      );
      expect(restored?.isProcessed()).toBe(true);
      expect(restored?.processedAt).toEqual(LATER);
      await expectRejection(
        uow.run((r) => r.inbox.markProcessed(received)),
        ConcurrencyConflictError,
      );
    });
  });

  describe('outbox', () => {
    it('persists, reschedules and publishes an event', async () => {
      const event = outboxEvent(randomUUID(), 'WalletBalanceChanged');
      await uow.run((r) => r.outbox.enqueue(event));

      const due = await uow.run((r) => r.outbox.lockDue(LATER, 100));
      const restored = due.find((m) => m.id === event.id);
      expect(restored?.payload).toEqual(event.payload);
      expect(restored?.attempts).toBe(0);

      restored?.scheduleRetry(LATER);
      if (restored) {
        await uow.run((r) => r.outbox.save(restored));
      }
      const retried = await uow.run((r) => r.outbox.findById(event.id));
      expect(retried?.attempts).toBe(1);
      expect(retried?.nextAttemptAt).toEqual(new Date(LATER.getTime() + 1000));
      expect(
        (await uow.run((r) => r.outbox.lockDue(LATER, 100))).map((m) => m.id),
      ).not.toContain(event.id);

      retried?.markPublished(new Date(LATER.getTime() + 2000));
      if (retried) {
        await uow.run((r) => r.outbox.save(retried));
        await expectRejection(
          uow.run((r) => r.outbox.save(retried)),
          ConcurrencyConflictError,
        );
      }
      const published = await uow.run((r) => r.outbox.findById(event.id));
      expect(published?.isPending()).toBe(false);
    });
  });
});
