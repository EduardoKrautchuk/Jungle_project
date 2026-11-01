import {
  FailureCode,
  WagerTransactionStatus,
} from '../../domain/wagering/wager-transaction.enums.js';
import type {
  PendingReferenceCandidate,
  StoredWagerTransaction,
  TransactionalRepositories,
  UnitOfWork,
} from '../ports/persistence.js';
import type { Clock, IdGenerator } from '../ports/runtime.js';
import type { SettlementContext, WagerSettlement } from './wager-settlement.js';

export interface PendingReferencePolicy {
  readonly maxAttempts: number;
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
}

export type ResolutionResult =
  'PROCESSED' | 'REJECTED' | 'RESCHEDULED' | 'EXPIRED' | 'SKIPPED';

export interface ResolutionOutcome {
  readonly transactionId: string;
  readonly walletId: string;
  readonly result: ResolutionResult;
  readonly attempt: number;
  readonly providerId: string | undefined;
  readonly referenceTransactionId: string | undefined;
  readonly failureCode: FailureCode | undefined;
  readonly nextAttemptAt: Date | undefined;
  readonly skipReason: string | undefined;
}

export function pendingReferenceDelayMs(
  policy: PendingReferencePolicy,
  attempts: number,
): number {
  return Math.min(
    policy.maxDelayMs,
    policy.baseDelayMs * 2 ** Math.min(attempts, 30),
  );
}

export class ResolvePendingReference {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly settlement: WagerSettlement,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
    private readonly policy: PendingReferencePolicy,
  ) {}

  listDue(limit: number, salt: string): Promise<PendingReferenceCandidate[]> {
    return this.uow.run((repositories) =>
      repositories.transactions.listDuePendingReferences(
        this.clock.now(),
        limit,
        salt,
      ),
    );
  }

  resolve(candidate: PendingReferenceCandidate): Promise<ResolutionOutcome> {
    return this.uow.runWithWalletLock(
      candidate.walletId,
      async ({ wallet, repositories }) => {
        const stored = await repositories.transactions.findById(
          candidate.transactionId,
        );
        const now = this.clock.now();
        const skip = skipReason(stored, candidate, now);
        if (skip !== undefined || stored === undefined) {
          return skipped(candidate, skip ?? 'NOT_FOUND');
        }
        if (wallet === undefined) {
          throw new Error(
            `pending transaction ${candidate.transactionId} has no wallet`,
          );
        }
        const context = await this.#context(repositories, stored, now);
        const attempts = stored.referenceAttempts + 1;
        const settled = await this.settlement.settle(
          repositories,
          wallet,
          { ...stored, referenceAttempts: attempts },
          context,
        );
        const { transaction } = settled;
        if (transaction.status !== WagerTransactionStatus.PendingReference) {
          return outcome(
            settled,
            transaction.status === WagerTransactionStatus.Processed
              ? 'PROCESSED'
              : 'REJECTED',
            attempts,
          );
        }

        if (attempts >= this.policy.maxAttempts) {
          const reference = await repositories.transactions.findByExternalId(
            transaction.providerId,
            transaction.referenceExternalTransactionId ?? '',
          );
          const expired = await this.settlement.expireReference(
            repositories,
            wallet,
            { ...stored, referenceAttempts: attempts },
            reference === undefined
              ? FailureCode.ReferenceNotFound
              : FailureCode.ReferenceNotProcessed,
            context,
          );
          return outcome(expired, 'EXPIRED', attempts);
        }

        const rescheduled: StoredWagerTransaction = {
          ...stored,
          referenceAttempts: attempts,
          nextReferenceAttemptAt: new Date(
            now.getTime() + pendingReferenceDelayMs(this.policy, attempts),
          ),
        };
        await repositories.transactions.update(
          rescheduled,
          WagerTransactionStatus.PendingReference,
        );
        return outcome(rescheduled, 'RESCHEDULED', attempts);
      },
    );
  }

  async #context(
    repositories: TransactionalRepositories,
    stored: StoredWagerTransaction,
    now: Date,
  ): Promise<SettlementContext> {
    const original = await repositories.outbox.findLatestByAggregate(
      stored.transaction.id,
    );
    const correlationId = original?.payload.correlationId;
    const causationId = original?.payload.causationId;
    return {
      now,
      correlationId:
        typeof correlationId === 'string'
          ? correlationId
          : stored.transaction.id,
      causationId:
        typeof causationId === 'string' ? causationId : this.ids.next(),
    };
  }
}

function skipReason(
  stored: StoredWagerTransaction | undefined,
  candidate: PendingReferenceCandidate,
  now: Date,
): string | undefined {
  if (stored === undefined) {
    return 'NOT_FOUND';
  }
  if (stored.transaction.status !== WagerTransactionStatus.PendingReference) {
    return 'ALREADY_RESOLVED';
  }
  if (stored.referenceAttempts !== candidate.referenceAttempts) {
    return 'ATTEMPT_ALREADY_TAKEN';
  }
  if (
    stored.nextReferenceAttemptAt !== undefined &&
    stored.nextReferenceAttemptAt.getTime() > now.getTime()
  ) {
    return 'NOT_DUE';
  }
  return undefined;
}

function skipped(
  candidate: PendingReferenceCandidate,
  reason: string,
): ResolutionOutcome {
  return {
    transactionId: candidate.transactionId,
    walletId: candidate.walletId,
    result: 'SKIPPED',
    attempt: candidate.referenceAttempts,
    providerId: undefined,
    referenceTransactionId: undefined,
    failureCode: undefined,
    nextAttemptAt: undefined,
    skipReason: reason,
  };
}

function outcome(
  stored: StoredWagerTransaction,
  result: ResolutionResult,
  attempt: number,
): ResolutionOutcome {
  const { transaction } = stored;
  return {
    transactionId: transaction.id,
    walletId: transaction.walletId,
    result,
    attempt,
    providerId: transaction.providerId,
    referenceTransactionId: transaction.referenceTransactionId,
    failureCode: transaction.failureCode,
    nextAttemptAt: stored.nextReferenceAttemptAt,
    skipReason: undefined,
  };
}
