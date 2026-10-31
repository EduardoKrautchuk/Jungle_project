import { describe, expect, it } from 'bun:test';
import { DomainError } from '../../../src/domain/shared/domain-error.js';
import {
  CurrencyMismatchError,
  InvalidCurrencyError,
  InvalidMoneyAmountError,
  MoneyError,
  MoneyOutOfRangeError,
} from '../../../src/domain/money/money.errors.js';
import {
  InvalidLedgerEntryError,
  LedgerError,
  UnbalancedLedgerEntryError,
} from '../../../src/domain/ledger/ledger.errors.js';
import {
  InsufficientFundsError,
  InvalidWalletError,
  WalletError,
} from '../../../src/domain/wallet/wallet.errors.js';

describe('DomainError hierarchy', () => {
  it.each([
    [new InvalidMoneyAmountError(), MoneyError, 'MONEY_INVALID_AMOUNT'],
    [new InvalidCurrencyError(), MoneyError, 'MONEY_INVALID_CURRENCY'],
    [
      new CurrencyMismatchError('BRL', 'USD'),
      MoneyError,
      'MONEY_CURRENCY_MISMATCH',
    ],
    [new MoneyOutOfRangeError(), MoneyError, 'MONEY_OUT_OF_RANGE'],
    [new InvalidLedgerEntryError('x'), LedgerError, 'LEDGER_INVALID_ENTRY'],
    [new UnbalancedLedgerEntryError(), LedgerError, 'LEDGER_UNBALANCED_ENTRY'],
    [new InvalidWalletError('x'), WalletError, 'WALLET_INVALID'],
    [new InsufficientFundsError(), WalletError, 'WALLET_INSUFFICIENT_FUNDS'],
  ] as const)('%p keeps its stable code', (error, family, code) => {
    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(DomainError);
    expect(error).toBeInstanceOf(family);
    expect(error.code).toBe(code);
    expect(error.name).toBe(error.constructor.name);
  });
});
