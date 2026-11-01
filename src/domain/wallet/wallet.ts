import { Money } from '../money/money.js';
import {
  CurrencyMismatchError,
  MoneyOutOfRangeError,
} from '../money/money.errors.js';
import { LedgerDirection } from '../ledger/ledger-direction.js';
import { WalletLedgerEntry } from '../ledger/wallet-ledger-entry.js';
import {
  BalanceLimitExceededError,
  InsufficientFundsError,
  InvalidWalletError,
} from './wallet.errors.js';

export interface WalletState {
  id: string;
  playerId: string;
  currency: string;
  balance: Money;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface WalletMovement {
  entryId: string;
  transactionId: string;
  at: Date;
}

export interface OpenWalletProps {
  id: string;
  playerId: string;
  initialBalance: Money;
  at: Date;
  opening?: Omit<WalletMovement, 'at'>;
}

export interface OpenedWallet {
  wallet: Wallet;
  openingEntry: WalletLedgerEntry | undefined;
}

export class Wallet {
  readonly #id: string;
  readonly #playerId: string;
  readonly #currency: string;
  readonly #createdAtMs: number;
  #balance: Money;
  #version: number;
  #updatedAtMs: number;

  private constructor(state: WalletState) {
    this.#id = state.id;
    this.#playerId = state.playerId;
    this.#currency = state.currency;
    this.#balance = state.balance;
    this.#version = state.version;
    this.#createdAtMs = state.createdAt.getTime();
    this.#updatedAtMs = state.updatedAt.getTime();
    Object.freeze(this);
  }

  static open(props: OpenWalletProps): OpenedWallet {
    const { id, playerId, initialBalance, at, opening } = props;
    assertNonEmptyString(id, 'id');
    assertNonEmptyString(playerId, 'playerId');
    assertMoney(initialBalance, 'initialBalance');
    assertValidDate(at, 'at');
    if (initialBalance.isNegative()) {
      throw new InvalidWalletError('initialBalance must not be negative');
    }

    let openingEntry: WalletLedgerEntry | undefined;
    if (initialBalance.isPositive()) {
      if (opening === undefined) {
        throw new InvalidWalletError(
          'opening movement is required for a positive initialBalance',
        );
      }
      openingEntry = WalletLedgerEntry.create({
        id: opening.entryId,
        walletId: id,
        transactionId: opening.transactionId,
        direction: LedgerDirection.Credit,
        money: initialBalance,
        balanceBefore: Money.zero(initialBalance.currency),
        balanceAfter: initialBalance,
        createdAt: at,
      });
    } else if (opening !== undefined) {
      throw new InvalidWalletError(
        'opening movement is only allowed for a positive initialBalance',
      );
    }

    const wallet = new Wallet({
      id,
      playerId,
      currency: initialBalance.currency,
      balance: initialBalance,
      version: 1,
      createdAt: at,
      updatedAt: at,
    });
    return { wallet, openingEntry };
  }

  static rehydrate(state: WalletState): Wallet {
    assertNonEmptyString(state.id, 'id');
    assertNonEmptyString(state.playerId, 'playerId');
    assertMoney(state.balance, 'balance');
    if (state.balance.currency !== state.currency) {
      throw new InvalidWalletError(
        'balance currency must match wallet currency',
      );
    }
    if (!Number.isSafeInteger(state.version) || state.version < 1) {
      throw new InvalidWalletError('version must be a positive integer');
    }
    assertValidDate(state.createdAt, 'createdAt');
    assertValidDate(state.updatedAt, 'updatedAt');
    return new Wallet(state);
  }

  get id(): string {
    return this.#id;
  }

  get playerId(): string {
    return this.#playerId;
  }

  get currency(): string {
    return this.#currency;
  }

  get balance(): Money {
    return this.#balance;
  }

  get version(): number {
    return this.#version;
  }

  get createdAt(): Date {
    return new Date(this.#createdAtMs);
  }

  get updatedAt(): Date {
    return new Date(this.#updatedAtMs);
  }

  debit(money: Money, movement: WalletMovement): WalletLedgerEntry {
    const entry = this.#prepareEntry(LedgerDirection.Debit, money, movement);
    this.#apply(entry);
    return entry;
  }

  credit(money: Money, movement: WalletMovement): WalletLedgerEntry {
    const entry = this.#prepareEntry(LedgerDirection.Credit, money, movement);
    this.#apply(entry);
    return entry;
  }

  #prepareEntry(
    direction: LedgerDirection,
    money: Money,
    movement: WalletMovement,
  ): WalletLedgerEntry {
    this.#assertSameCurrency(money);
    if (!money.isPositive()) {
      throw new InvalidWalletError('movement amount must be positive');
    }
    if (
      direction === LedgerDirection.Debit &&
      this.#balance.isLessThan(money)
    ) {
      throw new InsufficientFundsError();
    }
    const balanceAfter =
      direction === LedgerDirection.Credit
        ? this.#creditedBalance(money)
        : this.#balance.subtract(money);

    return WalletLedgerEntry.create({
      id: movement.entryId,
      walletId: this.#id,
      transactionId: movement.transactionId,
      direction,
      money,
      balanceBefore: this.#balance,
      balanceAfter,
      createdAt: movement.at,
    });
  }

  #creditedBalance(money: Money): Money {
    try {
      return this.#balance.add(money);
    } catch (error) {
      if (error instanceof MoneyOutOfRangeError) {
        throw new BalanceLimitExceededError();
      }
      throw error;
    }
  }

  #apply(entry: WalletLedgerEntry): void {
    this.#balance = entry.balanceAfter;
    this.#version += 1;
    this.#updatedAtMs = entry.createdAt.getTime();
  }

  #assertSameCurrency(money: Money): void {
    if (money.currency !== this.#currency) {
      throw new CurrencyMismatchError(this.#currency, money.currency);
    }
  }
}

function assertNonEmptyString(value: unknown, field: string): void {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new InvalidWalletError(`${field} must be a non-empty string`);
  }
}

function assertMoney(value: unknown, field: string): void {
  if (!(value instanceof Money)) {
    throw new InvalidWalletError(`${field} must be a Money instance`);
  }
}

function assertValidDate(value: unknown, field: string): void {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new InvalidWalletError(`${field} must be a valid Date`);
  }
}
