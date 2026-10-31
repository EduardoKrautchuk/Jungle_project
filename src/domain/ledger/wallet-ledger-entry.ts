import { Money } from '../money/money.js';
import { CurrencyMismatchError } from '../money/money.errors.js';
import { LedgerDirection, isLedgerDirection } from './ledger-direction.js';
import {
  InvalidLedgerEntryError,
  UnbalancedLedgerEntryError,
} from './ledger.errors.js';

/** Persisted shape of a ledger entry. */
export interface LedgerEntryState {
  id: string;
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: Money;
  balanceBefore: Money;
  balanceAfter: Money;
  createdAt: Date;
}

export type CreateLedgerEntryProps = LedgerEntryState;

/**
 * Immutable record of one balance movement of one wallet.
 *
 * - `create` enforces the financial rules: positive movement, single currency,
 *   non-negative balances and exact arithmetic (balanceBefore ± money === balanceAfter).
 * - `rehydrate` rebuilds persisted state and only checks structure (types, ids,
 *   direction, dates). Financial rules are not re-run, so a corrupted row can
 *   still be loaded and detected through `isBalanced()` (e.g. by reconciliation).
 */
export class WalletLedgerEntry {
  private readonly createdAtMs: number;

  private constructor(
    readonly id: string,
    readonly walletId: string,
    readonly transactionId: string,
    readonly direction: LedgerDirection,
    readonly money: Money,
    readonly balanceBefore: Money,
    readonly balanceAfter: Money,
    createdAt: Date,
  ) {
    this.createdAtMs = createdAt.getTime();
    Object.freeze(this);
  }

  static create(props: CreateLedgerEntryProps): WalletLedgerEntry {
    WalletLedgerEntry.assertStructure(props);

    const { money, balanceBefore, balanceAfter } = props;
    switch (findViolation(props)) {
      case null:
        return WalletLedgerEntry.build(props);
      case 'CURRENCY_MISMATCH':
        throw new CurrencyMismatchError(
          money.currency,
          balanceBefore.currency !== money.currency
            ? balanceBefore.currency
            : balanceAfter.currency,
        );
      case 'NON_POSITIVE_MONEY':
        throw new InvalidLedgerEntryError('money must be positive');
      case 'NEGATIVE_BALANCE_BEFORE':
        throw new InvalidLedgerEntryError('balanceBefore must not be negative');
      case 'NEGATIVE_BALANCE_AFTER':
        throw new InvalidLedgerEntryError('balanceAfter must not be negative');
      case 'UNBALANCED':
        throw new UnbalancedLedgerEntryError();
    }
  }

  /** Rebuilds persisted state. Does not re-run financial rules. */
  static rehydrate(state: LedgerEntryState): WalletLedgerEntry {
    WalletLedgerEntry.assertStructure(state);
    return WalletLedgerEntry.build(state);
  }

  get createdAt(): Date {
    return new Date(this.createdAtMs);
  }

  /**
   * True when the entry satisfies every financial rule enforced by `create`:
   * single currency, positive movement, non-negative balances and
   * balanceBefore ± money === balanceAfter. Never throws.
   */
  isBalanced(): boolean {
    return findViolation(this) === null;
  }

  private static build(state: LedgerEntryState): WalletLedgerEntry {
    return new WalletLedgerEntry(
      state.id,
      state.walletId,
      state.transactionId,
      state.direction,
      state.money,
      state.balanceBefore,
      state.balanceAfter,
      state.createdAt,
    );
  }

  private static assertStructure(state: LedgerEntryState): void {
    assertNonEmptyString(state.id, 'id');
    assertNonEmptyString(state.walletId, 'walletId');
    assertNonEmptyString(state.transactionId, 'transactionId');
    if (!isLedgerDirection(state.direction)) {
      throw new InvalidLedgerEntryError('direction must be DEBIT or CREDIT');
    }
    assertMoney(state.money, 'money');
    assertMoney(state.balanceBefore, 'balanceBefore');
    assertMoney(state.balanceAfter, 'balanceAfter');
    if (
      !(state.createdAt instanceof Date) ||
      Number.isNaN(state.createdAt.getTime())
    ) {
      throw new InvalidLedgerEntryError('createdAt must be a valid Date');
    }
  }
}

type Violation =
  | 'CURRENCY_MISMATCH'
  | 'NON_POSITIVE_MONEY'
  | 'NEGATIVE_BALANCE_BEFORE'
  | 'NEGATIVE_BALANCE_AFTER'
  | 'UNBALANCED';

/**
 * Single source of the financial rules, shared by `create` and `isBalanced`.
 * Expects structurally valid state. Arithmetic only runs after the sign checks
 * and only subtracts a positive amount from a non-negative one, so the result
 * always stays inside the Money range and this function never throws.
 */
function findViolation(entry: {
  direction: LedgerDirection;
  money: Money;
  balanceBefore: Money;
  balanceAfter: Money;
}): Violation | null {
  const { direction, money, balanceBefore, balanceAfter } = entry;
  if (
    balanceBefore.currency !== money.currency ||
    balanceAfter.currency !== money.currency
  ) {
    return 'CURRENCY_MISMATCH';
  }
  if (!money.isPositive()) return 'NON_POSITIVE_MONEY';
  if (balanceBefore.isNegative()) return 'NEGATIVE_BALANCE_BEFORE';
  if (balanceAfter.isNegative()) return 'NEGATIVE_BALANCE_AFTER';

  const balanced =
    direction === LedgerDirection.Credit
      ? balanceAfter.subtract(money).equals(balanceBefore)
      : balanceBefore.subtract(money).equals(balanceAfter);
  return balanced ? null : 'UNBALANCED';
}

function assertNonEmptyString(value: unknown, field: string): void {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new InvalidLedgerEntryError(`${field} must be a non-empty string`);
  }
}

function assertMoney(value: unknown, field: string): void {
  if (!(value instanceof Money)) {
    throw new InvalidLedgerEntryError(`${field} must be a Money instance`);
  }
}
