import {
  ConcurrencyConflictError,
  UniqueConstraintViolationError,
} from '../../../../src/application/ports/persistence.errors.js';
import type {
  IdempotencyClaim,
  InboxReceipt,
  LedgerCursor,
  StoredWagerTransaction,
  TransactionalRepositories,
  UnitOfWork,
  WalletBalanceSnapshot,
  WalletLockScope,
} from '../../../../src/application/ports/persistence.js';
import type {
  Clock,
  IdGenerator,
} from '../../../../src/application/ports/runtime.js';
import type { WalletLedgerEntry } from '../../../../src/domain/ledger/wallet-ledger-entry.js';
import type { InboxMessage } from '../../../../src/domain/messaging/inbox-message.js';
import type { OutboxMessage } from '../../../../src/domain/messaging/outbox-message.js';
import { Money } from '../../../../src/domain/money/money.js';
import {
  WagerTransactionKind,
  WagerTransactionStatus,
} from '../../../../src/domain/wagering/wager-transaction.enums.js';
import type { Wallet } from '../../../../src/domain/wallet/wallet.js';
import {
  fromInboxMessage,
  fromLedgerEntry,
  fromOutboxMessage,
  fromStoredTransaction,
  fromWallet,
  toInboxMessage,
  toLedgerEntry,
  toOutboxMessage,
  toStoredTransaction,
  toWallet,
} from '../../../../src/infrastructure/persistence/mappers.js';
import type {
  InboxMessageRecord,
  LedgerEntryRecord,
  OutboxMessageRecord,
  WagerTransactionRecord,
  WalletRecord,
} from '../../../../src/infrastructure/persistence/schemas.js';

export interface Tables {
  wallets: WalletRecord[];
  transactions: WagerTransactionRecord[];
  ledger: LedgerEntryRecord[];
  inbox: InboxMessageRecord[];
  outbox: OutboxMessageRecord[];
}

export type Fault =
  'wallets.update' | 'ledger.append' | 'transactions.update' | 'outbox.enqueue';

export class InjectedFault extends Error {
  constructor(fault: Fault) {
    super(`injected fault at ${fault}`);
    this.name = 'InjectedFault';
  }
}

const copy = (tables: Tables): Tables => ({
  wallets: [...tables.wallets],
  transactions: [...tables.transactions],
  ledger: [...tables.ledger],
  inbox: [...tables.inbox],
  outbox: [...tables.outbox],
});

export class InMemoryUnitOfWork implements UnitOfWork {
  tables: Tables = {
    wallets: [],
    transactions: [],
    ledger: [],
    inbox: [],
    outbox: [],
  };
  readonly faults = new Set<Fault>();
  commits = 0;
  #queue: Promise<unknown> = Promise.resolve();

  run<T>(
    work: (repositories: TransactionalRepositories) => Promise<T>,
  ): Promise<T> {
    const next = this.#queue.then(async () => {
      const draft = copy(this.tables);
      const result = await work(this.#repositories(draft));
      this.tables = draft;
      this.commits += 1;
      return result;
    });
    this.#queue = next.catch(() => undefined);
    return next;
  }

  runWithWalletLock<T>(
    walletId: string,
    work: (scope: WalletLockScope) => Promise<T>,
  ): Promise<T> {
    return this.run(async (repositories) =>
      work({
        wallet: await repositories.wallets.findByIdForUpdate(walletId),
        repositories,
      }),
    );
  }

  #fail(fault: Fault): void {
    if (this.faults.has(fault)) {
      throw new InjectedFault(fault);
    }
  }

  #repositories(t: Tables): TransactionalRepositories {
    const fail = (fault: Fault) => this.#fail(fault);
    const findTx = (
      predicate: (record: WagerTransactionRecord) => boolean,
    ): StoredWagerTransaction | undefined => {
      const record = t.transactions.find(predicate);
      return record ? toStoredTransaction(record) : undefined;
    };
    const findWallet = (id: string): Wallet | undefined => {
      const record = t.wallets.find((wallet) => wallet.id === id);
      return record ? toWallet(record) : undefined;
    };

    return {
      wallets: {
        findById: async (id) => findWallet(id),
        findByIdForUpdate: async (id) => findWallet(id),
        findByPlayerAndCurrency: async (playerId, currency) => {
          const record = t.wallets.find(
            (w) => w.playerId === playerId && w.currency === currency,
          );
          return record ? toWallet(record) : undefined;
        },
        findBalanceSnapshot: async (
          id,
        ): Promise<WalletBalanceSnapshot | undefined> => {
          const wallet = findWallet(id);
          if (wallet === undefined) {
            return undefined;
          }
          const entries = t.ledger.filter((entry) => entry.walletId === id);
          const ledgerBalance = entries.reduce((total, entry) => {
            const amount = Money.from({
              amount: entry.amount,
              currency: entry.currency,
            });
            return entry.direction === 'CREDIT'
              ? total.add(amount)
              : total.subtract(amount);
          }, Money.zero(wallet.currency));
          return {
            wallet,
            ledgerBalance,
            ledgerEntries: entries.length,
          };
        },
        insert: async (wallet) => {
          if (
            t.wallets.some(
              (w) =>
                w.playerId === wallet.playerId &&
                w.currency === wallet.currency,
            )
          ) {
            throw new UniqueConstraintViolationError(
              'wallets_player_currency_uq',
            );
          }
          t.wallets.push(fromWallet(wallet));
        },
        update: async (wallet, expectedVersion) => {
          fail('wallets.update');
          const index = t.wallets.findIndex(
            (w) => w.id === wallet.id && w.version === expectedVersion,
          );
          if (index < 0) {
            throw new ConcurrencyConflictError('stale wallet');
          }
          t.wallets[index] = fromWallet(wallet);
        },
      },
      transactions: {
        claim: async (stored): Promise<IdempotencyClaim> => {
          const { transaction } = stored;
          const existing =
            findTx(
              (r) =>
                r.providerId === transaction.providerId &&
                r.idempotencyKey === transaction.idempotencyKey,
            ) ??
            findTx(
              (r) =>
                r.providerId === transaction.providerId &&
                r.externalTransactionId === transaction.externalTransactionId,
            );
          if (existing === undefined) {
            t.transactions.push(fromStoredTransaction(stored));
            return { outcome: 'CREATED' };
          }
          const same =
            existing.transaction.idempotencyKey ===
              transaction.idempotencyKey &&
            existing.transaction.matchesPayload(transaction.payloadHash);
          return same
            ? { outcome: 'REPLAY', existing }
            : { outcome: 'CONFLICT', existing };
        },
        insert: async (stored) => {
          t.transactions.push(fromStoredTransaction(stored));
        },
        update: async (stored, expectedStatus) => {
          fail('transactions.update');
          const record = fromStoredTransaction(stored);
          const index = t.transactions.findIndex(
            (r) => r.id === record.id && r.status === expectedStatus,
          );
          if (index < 0) {
            throw new ConcurrencyConflictError('stale transaction');
          }
          if (
            record.status === WagerTransactionStatus.Processed &&
            record.referenceTransactionId !== null &&
            (record.kind === WagerTransactionKind.Refund ||
              record.kind === WagerTransactionKind.Rollback) &&
            t.transactions.some(
              (r) =>
                r.id !== record.id &&
                r.status === WagerTransactionStatus.Processed &&
                r.referenceTransactionId === record.referenceTransactionId &&
                (r.kind === WagerTransactionKind.Refund ||
                  r.kind === WagerTransactionKind.Rollback),
            )
          ) {
            throw new UniqueConstraintViolationError(
              'wager_tx_single_reversal_uq',
            );
          }
          t.transactions[index] = record;
        },
        findById: async (id) => findTx((r) => r.id === id),
        findByIdempotencyKey: async (providerId, key) =>
          findTx(
            (r) => r.providerId === providerId && r.idempotencyKey === key,
          ),
        findByExternalId: async (providerId, external) =>
          findTx(
            (r) =>
              r.providerId === providerId &&
              r.externalTransactionId === external,
          ),
        findProcessedReversalOf: async (referenceTransactionId) =>
          findTx(
            (r) =>
              r.referenceTransactionId === referenceTransactionId &&
              r.status === WagerTransactionStatus.Processed &&
              (r.kind === WagerTransactionKind.Refund ||
                r.kind === WagerTransactionKind.Rollback),
          ),
        listDuePendingReferences: async (now, limit) =>
          t.transactions
            .filter(
              (r) =>
                r.status === WagerTransactionStatus.PendingReference &&
                r.nextReferenceAttemptAt !== null &&
                r.nextReferenceAttemptAt <= now,
            )
            .slice(0, limit)
            .map((r) => ({
              transactionId: r.id,
              walletId: r.walletId,
              referenceAttempts: r.referenceAttempts,
            })),
      },
      ledger: {
        append: async (entry: WalletLedgerEntry) => {
          fail('ledger.append');
          t.ledger.push(fromLedgerEntry(entry));
        },
        findByWalletAndTransaction: async (walletId, transactionId) => {
          const record = t.ledger.find(
            (e) => e.walletId === walletId && e.transactionId === transactionId,
          );
          return record ? toLedgerEntry(record) : undefined;
        },
        listByWallet: async (
          walletId,
          page: { after?: LedgerCursor; limit: number },
        ) =>
          t.ledger
            .filter((e) => e.walletId === walletId)
            .sort(
              (a, b) =>
                a.createdAt.getTime() - b.createdAt.getTime() ||
                (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
            )
            .filter((e) => {
              const after = page.after;
              if (after === undefined) {
                return true;
              }
              const time = e.createdAt.getTime();
              const cursorTime = after.createdAt.getTime();
              return (
                time > cursorTime || (time === cursorTime && e.id > after.id)
              );
            })
            .slice(0, page.limit)
            .map(toLedgerEntry),
      },
      inbox: {
        receive: async (message: InboxMessage): Promise<InboxReceipt> => {
          const record = t.inbox.find(
            (r) =>
              r.consumerName === message.consumerName &&
              r.messageId === message.messageId,
          );
          if (record) {
            return { outcome: 'DUPLICATE', existing: toInboxMessage(record) };
          }
          t.inbox.push(fromInboxMessage(message));
          return { outcome: 'RECEIVED' };
        },
        find: async (consumerName, messageId) => {
          const record = t.inbox.find(
            (r) => r.consumerName === consumerName && r.messageId === messageId,
          );
          return record ? toInboxMessage(record) : undefined;
        },
        markProcessed: async (message) => {
          const index = t.inbox.findIndex(
            (r) =>
              r.consumerName === message.consumerName &&
              r.messageId === message.messageId,
          );
          t.inbox[index] = fromInboxMessage(message);
        },
      },
      outbox: {
        enqueue: async (message: OutboxMessage) => {
          fail('outbox.enqueue');
          t.outbox.push(fromOutboxMessage(message));
        },
        findLatestByAggregate: async (aggregateId) => {
          const record = t.outbox
            .filter((r) => r.aggregateId === aggregateId)
            .at(-1);
          return record ? toOutboxMessage(record) : undefined;
        },
      },
    };
  }
}

export class TestClock implements Clock {
  #ms: number;

  constructor(start = '2026-10-31T12:00:00.000Z') {
    this.#ms = new Date(start).getTime();
  }

  now(): Date {
    return new Date(this.#ms);
  }

  advance(ms: number): void {
    this.#ms += ms;
  }
}

export class SequentialIds implements IdGenerator {
  #next = 0;

  next(): string {
    this.#next += 1;
    return `00000000-0000-7000-8000-${this.#next.toString().padStart(12, '0')}`;
  }
}
