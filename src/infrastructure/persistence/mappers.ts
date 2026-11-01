import type { StoredWagerTransaction } from '../../application/ports/persistence.js';
import { LedgerDirection } from '../../domain/ledger/ledger-direction.js';
import { WalletLedgerEntry } from '../../domain/ledger/wallet-ledger-entry.js';
import { InboxMessage } from '../../domain/messaging/inbox-message.js';
import { OutboxMessage } from '../../domain/messaging/outbox-message.js';
import { Money } from '../../domain/money/money.js';
import {
  FailureCode,
  WagerTransactionKind,
  WagerTransactionStatus,
  isEnumValue,
} from '../../domain/wagering/wager-transaction.enums.js';
import { WagerTransaction } from '../../domain/wagering/wager-transaction.js';
import { Wallet } from '../../domain/wallet/wallet.js';
import type {
  InboxMessageRecord,
  LedgerEntryRecord,
  OutboxMessageRecord,
  WagerTransactionRecord,
  WalletRecord,
} from './schemas.js';

export class PersistenceMappingError extends Error {
  constructor(reason: string) {
    super(`Cannot map persisted row: ${reason}`);
    this.name = 'PersistenceMappingError';
  }
}

const money = (amount: string, currency: string): Money =>
  Money.from({ amount, currency });

const optional = <T>(value: T | null): T | undefined =>
  value === null ? undefined : value;

function parseEnum<T extends string>(
  enumObject: Record<string, T>,
  value: string,
  field: string,
): T {
  if (!isEnumValue(enumObject, value)) {
    throw new PersistenceMappingError(`${field} "${value}" is not supported`);
  }
  return value;
}

export function toWallet(record: WalletRecord): Wallet {
  return Wallet.rehydrate({
    id: record.id,
    playerId: record.playerId,
    currency: record.currency,
    balance: money(record.balance, record.currency),
    version: record.version,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  });
}

export function fromWallet(wallet: Wallet): WalletRecord {
  return {
    id: wallet.id,
    playerId: wallet.playerId,
    currency: wallet.currency,
    balance: wallet.balance.toJSON().amount,
    version: wallet.version,
    createdAt: wallet.createdAt,
    updatedAt: wallet.updatedAt,
  };
}

export function toStoredTransaction(
  record: WagerTransactionRecord,
): StoredWagerTransaction {
  const transaction = WagerTransaction.rehydrate({
    id: record.id,
    providerId: record.providerId,
    externalTransactionId: record.externalTransactionId,
    idempotencyKey: record.idempotencyKey,
    payloadHash: record.payloadHash,
    walletId: record.walletId,
    playerId: record.playerId,
    roundId: record.roundId,
    gameId: record.gameId,
    kind: parseEnum(WagerTransactionKind, record.kind, 'kind'),
    money: money(record.amount, record.currency),
    referenceExternalTransactionId: optional(
      record.referenceExternalTransactionId,
    ),
    createdAt: record.createdAt,
    status: parseEnum(WagerTransactionStatus, record.status, 'status'),
    referenceTransactionId: optional(record.referenceTransactionId),
    failureCode:
      record.failureCode === null
        ? undefined
        : parseEnum(FailureCode, record.failureCode, 'failureCode'),
    processedAt: optional(record.processedAt),
  });
  return {
    transaction,
    resultBalance:
      record.resultBalance === null
        ? undefined
        : money(record.resultBalance, record.currency),
    referenceAttempts: record.referenceAttempts,
    nextReferenceAttemptAt: optional(record.nextReferenceAttemptAt),
  };
}

export function fromStoredTransaction(
  stored: StoredWagerTransaction,
): WagerTransactionRecord {
  const { transaction, resultBalance } = stored;
  if (
    resultBalance !== undefined &&
    resultBalance.currency !== transaction.money.currency
  ) {
    throw new PersistenceMappingError(
      'resultBalance currency must match the transaction currency',
    );
  }
  return {
    id: transaction.id,
    providerId: transaction.providerId,
    externalTransactionId: transaction.externalTransactionId,
    idempotencyKey: transaction.idempotencyKey,
    payloadHash: transaction.payloadHash,
    walletId: transaction.walletId,
    playerId: transaction.playerId,
    roundId: transaction.roundId,
    gameId: transaction.gameId,
    kind: transaction.kind,
    status: transaction.status,
    amount: transaction.money.toJSON().amount,
    currency: transaction.money.currency,
    referenceExternalTransactionId:
      transaction.referenceExternalTransactionId ?? null,
    referenceTransactionId: transaction.referenceTransactionId ?? null,
    failureCode: transaction.failureCode ?? null,
    resultBalance: resultBalance?.toJSON().amount ?? null,
    referenceAttempts: stored.referenceAttempts,
    nextReferenceAttemptAt: stored.nextReferenceAttemptAt ?? null,
    createdAt: transaction.createdAt,
    processedAt: transaction.processedAt ?? null,
  };
}

export function toLedgerEntry(record: LedgerEntryRecord): WalletLedgerEntry {
  return WalletLedgerEntry.rehydrate({
    id: record.id,
    walletId: record.walletId,
    transactionId: record.transactionId,
    direction: parseEnum(LedgerDirection, record.direction, 'direction'),
    money: money(record.amount, record.currency),
    balanceBefore: money(record.balanceBefore, record.currency),
    balanceAfter: money(record.balanceAfter, record.currency),
    createdAt: record.createdAt,
  });
}

export function fromLedgerEntry(entry: WalletLedgerEntry): LedgerEntryRecord {
  return {
    id: entry.id,
    walletId: entry.walletId,
    transactionId: entry.transactionId,
    direction: entry.direction,
    amount: entry.money.toJSON().amount,
    currency: entry.money.currency,
    balanceBefore: entry.balanceBefore.toJSON().amount,
    balanceAfter: entry.balanceAfter.toJSON().amount,
    createdAt: entry.createdAt,
  };
}

export function toInboxMessage(record: InboxMessageRecord): InboxMessage {
  return InboxMessage.rehydrate({
    consumerName: record.consumerName,
    messageId: record.messageId,
    payloadHash: record.payloadHash,
    receivedAt: record.receivedAt,
    processedAt: optional(record.processedAt),
  });
}

export function fromInboxMessage(message: InboxMessage): InboxMessageRecord {
  return {
    consumerName: message.consumerName,
    messageId: message.messageId,
    payloadHash: message.payloadHash,
    receivedAt: message.receivedAt,
    processedAt: message.processedAt ?? null,
  };
}

export function toOutboxMessage(record: OutboxMessageRecord): OutboxMessage {
  return OutboxMessage.rehydrate({
    id: record.id,
    aggregateId: record.aggregateId,
    eventType: record.eventType,
    payload: record.payload,
    occurredAt: record.occurredAt,
    attempts: record.attempts,
    nextAttemptAt: record.nextAttemptAt,
    publishedAt: optional(record.publishedAt),
  });
}

export function fromOutboxMessage(message: OutboxMessage): OutboxMessageRecord {
  return {
    id: message.id,
    aggregateId: message.aggregateId,
    eventType: message.eventType,
    payload: { ...message.payload },
    occurredAt: message.occurredAt,
    attempts: message.attempts,
    nextAttemptAt: message.nextAttemptAt ?? message.occurredAt,
    publishedAt: message.publishedAt ?? null,
  };
}
