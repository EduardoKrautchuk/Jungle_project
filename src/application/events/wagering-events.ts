import type { LedgerDirection } from '../../domain/ledger/ledger-direction.js';
import type { WalletLedgerEntry } from '../../domain/ledger/wallet-ledger-entry.js';
import type { MoneyProps } from '../../domain/money/money.js';
import type { WagerTransaction } from '../../domain/wagering/wager-transaction.js';
import type { Wallet } from '../../domain/wallet/wallet.js';
import { IntegrationEvent, type EventContext } from './integration-event.js';

type WagerTransactionData = {
  transactionId: string;
  providerId: string;
  externalTransactionId: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: string;
  money: MoneyProps;
  referenceExternalTransactionId: string | null;
};

export type WagerTransactionProcessedData = WagerTransactionData & {
  referenceTransactionId: string | null;
  balance: MoneyProps;
  processedAt: string;
};

export type WagerTransactionRejectedData = WagerTransactionData & {
  failureCode: string;
};

export type WagerTransactionPendingReferenceData = WagerTransactionData & {
  nextReferenceAttemptAt: string;
};

export type WalletBalanceChangedData = {
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: MoneyProps;
  balanceBefore: MoneyProps;
  balanceAfter: MoneyProps;
  walletVersion: number;
};

function describe(transaction: WagerTransaction): WagerTransactionData {
  return {
    transactionId: transaction.id,
    providerId: transaction.providerId,
    externalTransactionId: transaction.externalTransactionId,
    walletId: transaction.walletId,
    playerId: transaction.playerId,
    roundId: transaction.roundId,
    gameId: transaction.gameId,
    kind: transaction.kind,
    money: transaction.money.toJSON(),
    referenceExternalTransactionId:
      transaction.referenceExternalTransactionId ?? null,
  };
}

export class WagerTransactionProcessed extends IntegrationEvent<WagerTransactionProcessedData> {
  readonly eventType = 'WagerTransactionProcessed';
  readonly version = 1;

  static from(
    transaction: WagerTransaction,
    balance: MoneyProps,
    processedAt: Date,
    context: EventContext,
  ): WagerTransactionProcessed {
    return new WagerTransactionProcessed({
      ...context,
      aggregateId: transaction.id,
      data: {
        ...describe(transaction),
        referenceTransactionId: transaction.referenceTransactionId ?? null,
        balance,
        processedAt: processedAt.toISOString(),
      },
    });
  }
}

export class WagerTransactionRejected extends IntegrationEvent<WagerTransactionRejectedData> {
  readonly eventType = 'WagerTransactionRejected';
  readonly version = 1;

  static from(
    transaction: WagerTransaction,
    failureCode: string,
    context: EventContext,
  ): WagerTransactionRejected {
    return new WagerTransactionRejected({
      ...context,
      aggregateId: transaction.id,
      data: { ...describe(transaction), failureCode },
    });
  }
}

export class WagerTransactionPendingReference extends IntegrationEvent<WagerTransactionPendingReferenceData> {
  readonly eventType = 'WagerTransactionPendingReference';
  readonly version = 1;

  static from(
    transaction: WagerTransaction,
    nextReferenceAttemptAt: Date,
    context: EventContext,
  ): WagerTransactionPendingReference {
    return new WagerTransactionPendingReference({
      ...context,
      aggregateId: transaction.id,
      data: {
        ...describe(transaction),
        nextReferenceAttemptAt: nextReferenceAttemptAt.toISOString(),
      },
    });
  }
}

export class WalletBalanceChanged extends IntegrationEvent<WalletBalanceChangedData> {
  readonly eventType = 'WalletBalanceChanged';
  readonly version = 1;

  static from(
    wallet: Wallet,
    entry: WalletLedgerEntry,
    context: EventContext,
  ): WalletBalanceChanged {
    return new WalletBalanceChanged({
      ...context,
      aggregateId: wallet.id,
      data: {
        walletId: wallet.id,
        transactionId: entry.transactionId,
        direction: entry.direction,
        money: entry.money.toJSON(),
        balanceBefore: entry.balanceBefore.toJSON(),
        balanceAfter: entry.balanceAfter.toJSON(),
        walletVersion: wallet.version,
      },
    });
  }
}
