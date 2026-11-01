import { LedgerDirection } from '../../domain/ledger/ledger-direction.js';
import type { WalletLedgerEntry } from '../../domain/ledger/wallet-ledger-entry.js';
import {
  OutboxMessage,
  type OutboxEvent,
} from '../../domain/messaging/outbox-message.js';
import {
  FailureCode,
  WagerTransactionStatus,
} from '../../domain/wagering/wager-transaction.enums.js';
import type { WagerTransaction } from '../../domain/wagering/wager-transaction.js';
import {
  BalanceLimitExceededError,
  InsufficientFundsError,
} from '../../domain/wallet/wallet.errors.js';
import type { Wallet } from '../../domain/wallet/wallet.js';
import type { EventContext } from '../events/integration-event.js';
import {
  WagerTransactionPendingReference,
  WagerTransactionProcessed,
  WagerTransactionRejected,
  WalletBalanceChanged,
} from '../events/wagering-events.js';
import type {
  StoredWagerTransaction,
  TransactionalRepositories,
} from '../ports/persistence.js';
import type { IdGenerator } from '../ports/runtime.js';

export const PENDING_REFERENCE_RETRY_DELAY_MS = 1_000;

export interface SettlementContext {
  readonly now: Date;
  readonly correlationId: string;
  readonly causationId?: string;
}

export class WagerSettlement {
  constructor(private readonly ids: IdGenerator) {}

  async settle(
    repositories: TransactionalRepositories,
    wallet: Wallet,
    stored: StoredWagerTransaction,
    context: SettlementContext,
  ): Promise<StoredWagerTransaction> {
    const { transaction } = stored;
    const previousStatus = transaction.status;
    if (
      previousStatus !== WagerTransactionStatus.Pending &&
      previousStatus !== WagerTransactionStatus.PendingReference
    ) {
      return stored;
    }

    let reference: WagerTransaction | undefined;
    if (transaction.referenceExternalTransactionId !== undefined) {
      const found = await repositories.transactions.findByExternalId(
        transaction.providerId,
        transaction.referenceExternalTransactionId,
      );
      reference = found?.transaction;
      const check = transaction.validateReference(reference);
      if (check.outcome === 'WAIT') {
        return previousStatus === WagerTransactionStatus.Pending
          ? this.#waitForReference(repositories, wallet, stored, context)
          : stored;
      }
      if (check.outcome === 'REJECT') {
        return this.#reject(
          repositories,
          wallet,
          stored,
          check.failureCode,
          context,
        );
      }
      if (
        reference !== undefined &&
        transaction.requiresReference() &&
        (await repositories.transactions.findProcessedReversalOf(
          reference.id,
        )) !== undefined
      ) {
        return this.#reject(
          repositories,
          wallet,
          stored,
          FailureCode.AlreadyReversed,
          context,
        );
      }
    }

    if (!transaction.affectsBalance()) {
      transaction.markProcessed(reference?.id, context.now);
      const settled = {
        ...stored,
        resultBalance: wallet.balance,
        nextReferenceAttemptAt: undefined,
      };
      await repositories.transactions.update(settled, previousStatus);
      await this.#publish(repositories, context, (event) =>
        WagerTransactionProcessed.from(
          transaction,
          wallet.balance.toJSON(),
          context.now,
          event,
        ),
      );
      return settled;
    }

    const expectedVersion = wallet.version;
    const at = nextMovementTime(wallet, context.now);
    let entry: WalletLedgerEntry;
    try {
      const movement = {
        entryId: this.ids.next(),
        transactionId: transaction.id,
        at,
      };
      entry =
        transaction.ledgerDirectionFor(reference) === LedgerDirection.Debit
          ? wallet.debit(transaction.money, movement)
          : wallet.credit(transaction.money, movement);
    } catch (error) {
      if (error instanceof InsufficientFundsError) {
        return this.#reject(
          repositories,
          wallet,
          stored,
          transaction.insufficientFundsFailureCode(),
          context,
        );
      }
      if (error instanceof BalanceLimitExceededError) {
        return this.#reject(
          repositories,
          wallet,
          stored,
          FailureCode.BalanceLimitExceeded,
          context,
        );
      }
      throw error;
    }

    transaction.markProcessed(reference?.id, at);
    const settled = {
      ...stored,
      resultBalance: wallet.balance,
      nextReferenceAttemptAt: undefined,
    };
    await repositories.wallets.update(wallet, expectedVersion);
    await repositories.ledger.append(entry);
    await repositories.transactions.update(settled, previousStatus);
    await this.#publish(repositories, context, (event) =>
      WagerTransactionProcessed.from(
        transaction,
        wallet.balance.toJSON(),
        at,
        event,
      ),
    );
    await this.#publish(repositories, context, (event) =>
      WalletBalanceChanged.from(wallet, entry, event),
    );
    return settled;
  }

  expireReference(
    repositories: TransactionalRepositories,
    wallet: Wallet,
    stored: StoredWagerTransaction,
    failureCode: FailureCode,
    context: SettlementContext,
  ): Promise<StoredWagerTransaction> {
    return this.#reject(repositories, wallet, stored, failureCode, context);
  }

  async #waitForReference(
    repositories: TransactionalRepositories,
    wallet: Wallet,
    stored: StoredWagerTransaction,
    context: SettlementContext,
  ): Promise<StoredWagerTransaction> {
    const { transaction } = stored;
    transaction.markPendingReference();
    const nextReferenceAttemptAt = new Date(
      context.now.getTime() + PENDING_REFERENCE_RETRY_DELAY_MS,
    );
    const pending = {
      ...stored,
      resultBalance: wallet.balance,
      nextReferenceAttemptAt,
    };
    await repositories.transactions.update(
      pending,
      WagerTransactionStatus.Pending,
    );
    await this.#publish(repositories, context, (event) =>
      WagerTransactionPendingReference.from(
        transaction,
        nextReferenceAttemptAt,
        event,
      ),
    );
    return pending;
  }

  async #reject(
    repositories: TransactionalRepositories,
    wallet: Wallet,
    stored: StoredWagerTransaction,
    failureCode: FailureCode,
    context: SettlementContext,
  ): Promise<StoredWagerTransaction> {
    const { transaction } = stored;
    const previousStatus = transaction.status;
    transaction.reject(failureCode);
    const rejected = {
      ...stored,
      resultBalance: wallet.balance,
      nextReferenceAttemptAt: undefined,
    };
    await repositories.transactions.update(rejected, previousStatus);
    await this.#publish(repositories, context, (event) =>
      WagerTransactionRejected.from(transaction, failureCode, event),
    );
    return rejected;
  }

  async #publish(
    repositories: TransactionalRepositories,
    context: SettlementContext,
    build: (event: EventContext) => OutboxEvent,
  ): Promise<void> {
    await repositories.outbox.enqueue(
      OutboxMessage.enqueue(build(eventContext(this.ids, context))),
    );
  }
}

export function eventContext(
  ids: IdGenerator,
  context: SettlementContext,
): EventContext {
  return {
    eventId: ids.next(),
    correlationId: context.correlationId,
    causationId: context.causationId,
    occurredAt: context.now,
  };
}

function nextMovementTime(wallet: Wallet, now: Date): Date {
  return new Date(Math.max(now.getTime(), wallet.updatedAt.getTime() + 1));
}
