import type { EntityManager, FilterQuery } from '@mikro-orm/postgresql';
import { ConcurrencyConflictError } from '../../../application/ports/persistence.errors.js';
import type {
  PendingReferenceCandidate,
  IdempotencyClaim,
  StoredWagerTransaction,
  WagerTransactionRepository,
} from '../../../application/ports/persistence.js';
import {
  WagerTransactionKind,
  WagerTransactionStatus,
} from '../../../domain/wagering/wager-transaction.enums.js';
import { fromStoredTransaction, toStoredTransaction } from '../mappers.js';
import {
  WagerTransactionSchema,
  type WagerTransactionRecord,
} from '../schemas.js';

const CLAIMABLE_STATUSES: ReadonlySet<WagerTransactionStatus> = new Set([
  WagerTransactionStatus.Pending,
  WagerTransactionStatus.Rejected,
]);

export class MikroOrmWagerTransactionRepository implements WagerTransactionRepository {
  constructor(private readonly em: EntityManager) {}

  async claim(stored: StoredWagerTransaction): Promise<IdempotencyClaim> {
    const { transaction } = stored;
    if (!CLAIMABLE_STATUSES.has(transaction.status)) {
      throw new ConcurrencyConflictError(
        'only PENDING or REJECTED transactions can claim an idempotency key',
      );
    }
    const result = await this.em
      .createQueryBuilder(WagerTransactionSchema)
      .insert(fromStoredTransaction(stored))
      .onConflict()
      .ignore()
      .execute('run');
    if (result.affectedRows === 1) {
      return { outcome: 'CREATED' };
    }

    const existing =
      (await this.findByIdempotencyKey(
        transaction.providerId,
        transaction.idempotencyKey,
      )) ??
      (await this.findByExternalId(
        transaction.providerId,
        transaction.externalTransactionId,
      ));
    if (existing === undefined) {
      throw new ConcurrencyConflictError(
        `transaction ${transaction.id} conflicted without a visible owner`,
      );
    }
    const sameRequest =
      existing.transaction.idempotencyKey === transaction.idempotencyKey &&
      existing.transaction.matchesPayload(transaction.payloadHash);
    return sameRequest
      ? { outcome: 'REPLAY', existing }
      : { outcome: 'CONFLICT', existing };
  }

  async insert(stored: StoredWagerTransaction): Promise<void> {
    await this.em.insert(WagerTransactionSchema, fromStoredTransaction(stored));
  }

  async update(
    stored: StoredWagerTransaction,
    expectedStatus: WagerTransactionStatus,
  ): Promise<void> {
    const record = fromStoredTransaction(stored);
    const affected = await this.em.nativeUpdate(
      WagerTransactionSchema,
      { id: record.id, status: expectedStatus },
      {
        status: record.status,
        referenceTransactionId: record.referenceTransactionId,
        failureCode: record.failureCode,
        resultBalance: record.resultBalance,
        referenceAttempts: record.referenceAttempts,
        nextReferenceAttemptAt: record.nextReferenceAttemptAt,
        processedAt: record.processedAt,
      },
    );
    if (affected !== 1) {
      throw new ConcurrencyConflictError(
        `transaction ${record.id} is no longer ${expectedStatus}`,
      );
    }
  }

  async findById(id: string): Promise<StoredWagerTransaction | undefined> {
    return this.findOne({ id });
  }

  async findByIdempotencyKey(
    providerId: string,
    idempotencyKey: string,
  ): Promise<StoredWagerTransaction | undefined> {
    return this.findOne({ providerId, idempotencyKey });
  }

  async findByExternalId(
    providerId: string,
    externalTransactionId: string,
  ): Promise<StoredWagerTransaction | undefined> {
    return this.findOne({ providerId, externalTransactionId });
  }

  async findProcessedReversalOf(
    referenceTransactionId: string,
  ): Promise<StoredWagerTransaction | undefined> {
    return this.findOne({
      referenceTransactionId,
      status: WagerTransactionStatus.Processed,
      kind: {
        $in: [WagerTransactionKind.Refund, WagerTransactionKind.Rollback],
      },
    });
  }

  async listDuePendingReferences(
    now: Date,
    limit: number,
    salt: string,
  ): Promise<PendingReferenceCandidate[]> {
    const rows = await this.em.execute<
      { id: string; wallet_id: string; reference_attempts: number }[]
    >(
      `SELECT id, wallet_id, reference_attempts
         FROM wager_transactions
        WHERE status = 'PENDING_REFERENCE'
          AND next_reference_attempt_at <= ?
        ORDER BY next_reference_attempt_at, md5(id::text || ?)
        LIMIT ?`,
      [now, salt, limit],
    );
    return rows.map((row) => ({
      transactionId: row.id,
      walletId: row.wallet_id,
      referenceAttempts: Number(row.reference_attempts),
    }));
  }

  private async findOne(
    where: FilterQuery<WagerTransactionRecord>,
  ): Promise<StoredWagerTransaction | undefined> {
    const record = await this.em.findOne(WagerTransactionSchema, where, {
      disableIdentityMap: true,
    });
    return record ? toStoredTransaction(record) : undefined;
  }
}
