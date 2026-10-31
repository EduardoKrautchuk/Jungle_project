import { DomainError } from '../shared/domain-error.js';
import type {
  FailureCode,
  WagerTransactionStatus,
} from './wager-transaction.enums.js';

export type WagerTransactionErrorCode =
  | 'WAGER_INVALID_TRANSACTION'
  | 'WAGER_INVALID_STATE_TRANSITION'
  | 'WAGER_INVALID_REFERENCE';

export abstract class WagerTransactionError extends DomainError<WagerTransactionErrorCode> {}

export class InvalidWagerTransactionError extends WagerTransactionError {
  constructor(reason: string) {
    super('WAGER_INVALID_TRANSACTION', `Invalid wager transaction: ${reason}`);
  }
}

export class InvalidTransactionStateError extends WagerTransactionError {
  constructor(
    readonly from: WagerTransactionStatus,
    readonly to: WagerTransactionStatus,
  ) {
    super(
      'WAGER_INVALID_STATE_TRANSITION',
      `Invalid wager transaction transition from ${from} to ${to}`,
    );
  }
}

export class InvalidTransactionReferenceError extends WagerTransactionError {
  constructor(readonly failureCode: FailureCode) {
    super(
      'WAGER_INVALID_REFERENCE',
      `Invalid transaction reference: ${failureCode}`,
    );
  }
}
