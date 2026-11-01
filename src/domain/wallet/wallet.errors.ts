import { DomainError } from '../shared/domain-error.js';

export type WalletErrorCode =
  | 'WALLET_INVALID'
  | 'WALLET_INSUFFICIENT_FUNDS'
  | 'WALLET_BALANCE_LIMIT_EXCEEDED';

export abstract class WalletError extends DomainError<WalletErrorCode> {}

export class InvalidWalletError extends WalletError {
  constructor(reason: string) {
    super('WALLET_INVALID', `Invalid wallet operation: ${reason}`);
  }
}

export class InsufficientFundsError extends WalletError {
  constructor() {
    super('WALLET_INSUFFICIENT_FUNDS', 'Insufficient funds for debit');
  }
}

export class BalanceLimitExceededError extends WalletError {
  constructor() {
    super(
      'WALLET_BALANCE_LIMIT_EXCEEDED',
      'Credit would exceed the maximum supported wallet balance',
    );
  }
}
