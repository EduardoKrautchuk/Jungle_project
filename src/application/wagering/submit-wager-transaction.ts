import { OutboxMessage } from '../../domain/messaging/outbox-message.js';
import { MoneyError } from '../../domain/money/money.errors.js';
import { Money } from '../../domain/money/money.js';
import {
  FailureCode,
  isProviderSubmittableKind,
} from '../../domain/wagering/wager-transaction.enums.js';
import { WagerTransactionError } from '../../domain/wagering/wager-transaction.errors.js';
import { WagerTransaction } from '../../domain/wagering/wager-transaction.js';
import type { Wallet } from '../../domain/wallet/wallet.js';
import {
  IdempotencyConflictError,
  InvalidRequestError,
} from '../application.errors.js';
import { WagerTransactionRejected } from '../events/wagering-events.js';
import type {
  StoredWagerTransaction,
  TransactionalRepositories,
  UnitOfWork,
} from '../ports/persistence.js';
import type { Clock, IdGenerator } from '../ports/runtime.js';
import {
  eventContext,
  type SettlementContext,
  type WagerSettlement,
} from './wager-settlement.js';
import { wagerPayloadHash, type WagerRequestPayload } from './wager-request.js';
import {
  toWagerTransactionResult,
  type WagerTransactionResult,
} from './wager-transaction-result.js';

export interface SubmitWagerTransactionCommand extends WagerRequestPayload {
  readonly idempotencyKey: string;
  readonly correlationId: string;
  readonly causationId?: string;
}

export class SubmitWagerTransaction {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly settlement: WagerSettlement,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
  ) {}

  async execute(
    command: SubmitWagerTransactionCommand,
  ): Promise<WagerTransactionResult> {
    const incoming = this.#createTransaction(command);

    const known = await this.uow.run((repositories) =>
      findKnown(repositories, incoming),
    );
    if (known !== undefined) {
      return replayOf(known, incoming);
    }

    return this.uow.runWithWalletLock(
      incoming.walletId,
      async ({ wallet, repositories }) => {
        const context: SettlementContext = {
          now: this.clock.now(),
          correlationId: command.correlationId,
          causationId: command.causationId,
        };
        const access = checkWallet(wallet, incoming);
        if (access.outcome === 'REJECT') {
          incoming.reject(access.failureCode);
        }

        const record = initialRecord(incoming);
        const claim = await repositories.transactions.claim(record);
        if (claim.outcome !== 'CREATED') {
          return replayOf(claim.existing, incoming);
        }

        if (access.outcome === 'REJECT') {
          await repositories.outbox.enqueue(
            OutboxMessage.enqueue(
              WagerTransactionRejected.from(
                incoming,
                access.failureCode,
                eventContext(this.ids, context),
              ),
            ),
          );
          return toWagerTransactionResult(record, false);
        }

        const settled = await this.settlement.settle(
          repositories,
          access.wallet,
          record,
          context,
        );
        return toWagerTransactionResult(settled, false);
      },
    );
  }

  #createTransaction(command: SubmitWagerTransactionCommand): WagerTransaction {
    if (!isProviderSubmittableKind(command.kind)) {
      throw new InvalidRequestError([
        {
          field: 'kind',
          code: 'UNSUPPORTED_KIND',
          message: 'kind must be one of BET, WIN, LOSS, REFUND, ROLLBACK',
        },
      ]);
    }
    try {
      return WagerTransaction.create({
        id: this.ids.next(),
        providerId: command.providerId,
        externalTransactionId: command.externalTransactionId,
        idempotencyKey: command.idempotencyKey,
        payloadHash: wagerPayloadHash(command),
        walletId: command.walletId,
        playerId: command.playerId,
        roundId: command.roundId,
        gameId: command.gameId,
        kind: command.kind,
        money: Money.from(command.money),
        referenceExternalTransactionId: command.referenceExternalTransactionId,
        createdAt: this.clock.now(),
      });
    } catch (error) {
      if (error instanceof MoneyError) {
        throw new InvalidRequestError([
          { field: 'money', code: error.code, message: error.message },
        ]);
      }
      if (error instanceof WagerTransactionError) {
        throw new InvalidRequestError([
          { field: 'body', code: error.code, message: error.message },
        ]);
      }
      throw error;
    }
  }
}

function initialRecord(transaction: WagerTransaction): StoredWagerTransaction {
  return {
    transaction,
    resultBalance: undefined,
    referenceAttempts: 0,
    nextReferenceAttemptAt: undefined,
  };
}

async function findKnown(
  repositories: TransactionalRepositories,
  incoming: WagerTransaction,
): Promise<StoredWagerTransaction | undefined> {
  return (
    (await repositories.transactions.findByIdempotencyKey(
      incoming.providerId,
      incoming.idempotencyKey,
    )) ??
    (await repositories.transactions.findByExternalId(
      incoming.providerId,
      incoming.externalTransactionId,
    ))
  );
}

function replayOf(
  existing: StoredWagerTransaction,
  incoming: WagerTransaction,
): WagerTransactionResult {
  if (existing.transaction.idempotencyKey !== incoming.idempotencyKey) {
    throw new IdempotencyConflictError(
      'externalTransactionId was already submitted with another Idempotency-Key',
    );
  }
  if (!existing.transaction.matchesPayload(incoming.payloadHash)) {
    throw new IdempotencyConflictError(
      'Idempotency-Key was already used with a different payload',
    );
  }
  return toWagerTransactionResult(existing, true);
}

type WalletAccess =
  | { readonly outcome: 'ALLOWED'; readonly wallet: Wallet }
  | { readonly outcome: 'REJECT'; readonly failureCode: FailureCode };

function checkWallet(
  wallet: Wallet | undefined,
  transaction: WagerTransaction,
): WalletAccess {
  if (wallet === undefined) {
    return { outcome: 'REJECT', failureCode: FailureCode.WalletNotFound };
  }
  if (wallet.playerId !== transaction.playerId) {
    return { outcome: 'REJECT', failureCode: FailureCode.WalletPlayerMismatch };
  }
  if (wallet.currency !== transaction.money.currency) {
    return { outcome: 'REJECT', failureCode: FailureCode.CurrencyMismatch };
  }
  return { outcome: 'ALLOWED', wallet };
}
