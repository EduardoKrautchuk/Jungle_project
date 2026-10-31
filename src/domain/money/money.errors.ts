import { DomainError } from '../shared/domain-error.js';

export type MoneyErrorCode =
  | 'MONEY_INVALID_AMOUNT'
  | 'MONEY_INVALID_CURRENCY'
  | 'MONEY_CURRENCY_MISMATCH'
  | 'MONEY_OUT_OF_RANGE';

export abstract class MoneyError extends DomainError<MoneyErrorCode> {}

export class InvalidMoneyAmountError extends MoneyError {
  constructor() {
    super(
      'MONEY_INVALID_AMOUNT',
      'Amount must be a non-negative decimal string with exactly 2 decimal places',
    );
  }
}

export class InvalidCurrencyError extends MoneyError {
  constructor() {
    super(
      'MONEY_INVALID_CURRENCY',
      'Currency must be an ISO-4217 code with 3 uppercase letters',
    );
  }
}

export class CurrencyMismatchError extends MoneyError {
  constructor(expected: string, received: string) {
    super(
      'MONEY_CURRENCY_MISMATCH',
      `Currency mismatch: expected ${expected}, received ${received}`,
    );
  }
}

export class MoneyOutOfRangeError extends MoneyError {
  constructor() {
    super('MONEY_OUT_OF_RANGE', 'Money value exceeds the supported range');
  }
}
