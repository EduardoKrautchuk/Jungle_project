import type { StoredWagerTransaction } from '../ports/persistence.js';
import type { Money } from '../../domain/money/money.js';
import type {
  FailureCode,
  WagerTransactionStatus,
} from '../../domain/wagering/wager-transaction.enums.js';

export interface WagerTransactionResult {
  readonly transactionId: string;
  readonly status: WagerTransactionStatus;
  readonly failureCode: FailureCode | undefined;
  readonly balance: Money | undefined;
  readonly idempotentReplay: boolean;
}

export function toWagerTransactionResult(
  stored: StoredWagerTransaction,
  idempotentReplay: boolean,
): WagerTransactionResult {
  return {
    transactionId: stored.transaction.id,
    status: stored.transaction.status,
    failureCode: stored.transaction.failureCode,
    balance: stored.resultBalance,
    idempotentReplay,
  };
}
