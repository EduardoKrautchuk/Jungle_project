import type { WalletLedgerEntry } from '../../domain/ledger/wallet-ledger-entry.js';
import type { InboxMessage } from '../../domain/messaging/inbox-message.js';
import type { OutboxMessage } from '../../domain/messaging/outbox-message.js';
import type { Money } from '../../domain/money/money.js';
import type { WagerTransactionStatus } from '../../domain/wagering/wager-transaction.enums.js';
import type { WagerTransaction } from '../../domain/wagering/wager-transaction.js';
import type { Wallet } from '../../domain/wallet/wallet.js';

export interface StoredWagerTransaction {
  transaction: WagerTransaction;
  resultBalance: Money | undefined;
  referenceAttempts: number;
  nextReferenceAttemptAt: Date | undefined;
}

export type IdempotencyClaim =
  | { readonly outcome: 'CREATED' }
  | { readonly outcome: 'REPLAY'; readonly existing: StoredWagerTransaction }
  | { readonly outcome: 'CONFLICT'; readonly existing: StoredWagerTransaction };

export type InboxReceipt =
  | { readonly outcome: 'RECEIVED' }
  | { readonly outcome: 'DUPLICATE'; readonly existing: InboxMessage };

export interface LedgerCursor {
  createdAt: Date;
  id: string;
}

export interface WalletBalanceSnapshot {
  wallet: Wallet;
  ledgerBalance: Money;
  ledgerEntries: number;
}

export interface WalletRepository {
  findById(id: string): Promise<Wallet | undefined>;
  findBalanceSnapshot(id: string): Promise<WalletBalanceSnapshot | undefined>;
  findByIdForUpdate(id: string): Promise<Wallet | undefined>;
  findByPlayerAndCurrency(
    playerId: string,
    currency: string,
  ): Promise<Wallet | undefined>;
  insert(wallet: Wallet): Promise<void>;
  update(wallet: Wallet, expectedVersion: number): Promise<void>;
}

export interface WagerTransactionRepository {
  claim(stored: StoredWagerTransaction): Promise<IdempotencyClaim>;
  insert(stored: StoredWagerTransaction): Promise<void>;
  update(
    stored: StoredWagerTransaction,
    expectedStatus: WagerTransactionStatus,
  ): Promise<void>;
  findById(id: string): Promise<StoredWagerTransaction | undefined>;
  findByIdempotencyKey(
    providerId: string,
    idempotencyKey: string,
  ): Promise<StoredWagerTransaction | undefined>;
  findByExternalId(
    providerId: string,
    externalTransactionId: string,
  ): Promise<StoredWagerTransaction | undefined>;
  findProcessedReversalOf(
    referenceTransactionId: string,
  ): Promise<StoredWagerTransaction | undefined>;
  lockDuePendingReferences(
    now: Date,
    limit: number,
  ): Promise<StoredWagerTransaction[]>;
}

export interface LedgerRepository {
  append(entry: WalletLedgerEntry): Promise<void>;
  findByWalletAndTransaction(
    walletId: string,
    transactionId: string,
  ): Promise<WalletLedgerEntry | undefined>;
  listByWallet(
    walletId: string,
    page: { after?: LedgerCursor; limit: number },
  ): Promise<WalletLedgerEntry[]>;
}

export interface InboxRepository {
  receive(message: InboxMessage): Promise<InboxReceipt>;
  find(
    consumerName: string,
    messageId: string,
  ): Promise<InboxMessage | undefined>;
  markProcessed(message: InboxMessage): Promise<void>;
}

export interface OutboxRepository {
  enqueue(message: OutboxMessage): Promise<void>;
  findById(id: string): Promise<OutboxMessage | undefined>;
  lockDue(now: Date, limit: number): Promise<OutboxMessage[]>;
  save(message: OutboxMessage): Promise<void>;
}

export interface TransactionalRepositories {
  readonly wallets: WalletRepository;
  readonly transactions: WagerTransactionRepository;
  readonly ledger: LedgerRepository;
  readonly inbox: InboxRepository;
  readonly outbox: OutboxRepository;
}

export interface WalletLockScope {
  readonly wallet: Wallet | undefined;
  readonly repositories: TransactionalRepositories;
}

export interface UnitOfWork {
  run<T>(
    work: (repositories: TransactionalRepositories) => Promise<T>,
  ): Promise<T>;
  runWithWalletLock<T>(
    walletId: string,
    work: (scope: WalletLockScope) => Promise<T>,
  ): Promise<T>;
}

export const UNIT_OF_WORK = Symbol('UNIT_OF_WORK');
