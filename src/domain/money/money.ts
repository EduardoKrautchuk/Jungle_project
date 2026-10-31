import { Decimal } from 'decimal.js';
import {
  CurrencyMismatchError,
  InvalidCurrencyError,
  InvalidMoneyAmountError,
  MoneyOutOfRangeError,
} from './money.errors.js';

export interface MoneyProps {
  amount: string;
  currency: string;
}

const MoneyDecimal = Decimal.clone({
  precision: 40,
  rounding: Decimal.ROUND_HALF_EVEN,
  toExpNeg: -40,
  toExpPos: 40,
});

const SCALE = 2;
const AMOUNT_PATTERN = /^(0|[1-9]\d{0,17})\.\d{2}$/;
const CURRENCY_PATTERN = /^[A-Z]{3}$/;
const MAX_ABSOLUTE_VALUE = new MoneyDecimal('999999999999999999.99');

export class Money {
  private constructor(
    private readonly value: Decimal,
    readonly currency: string,
  ) {
    Object.freeze(this);
  }

  static from(props: MoneyProps): Money {
    const currency = Money.parseCurrency(props.currency);
    if (
      typeof props.amount !== 'string' ||
      !AMOUNT_PATTERN.test(props.amount)
    ) {
      throw new InvalidMoneyAmountError();
    }
    return Money.of(new MoneyDecimal(props.amount), currency);
  }

  static zero(currency: string): Money {
    return Money.of(new MoneyDecimal(0), Money.parseCurrency(currency));
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return Money.of(this.value.plus(other.value), this.currency);
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return Money.of(this.value.minus(other.value), this.currency);
  }

  negate(): Money {
    return Money.of(this.value.negated(), this.currency);
  }

  isZero(): boolean {
    return this.value.isZero();
  }

  isPositive(): boolean {
    return this.value.greaterThan(0);
  }

  isNegative(): boolean {
    return this.value.lessThan(0);
  }

  isLessThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.value.lessThan(other.value);
  }

  equals(other: Money): boolean {
    return this.currency === other.currency && this.value.equals(other.value);
  }

  toJSON(): MoneyProps {
    return { amount: this.value.toFixed(SCALE), currency: this.currency };
  }

  toString(): string {
    return `${this.value.toFixed(SCALE)} ${this.currency}`;
  }

  private assertSameCurrency(other: Money): void {
    if (this.currency !== other.currency) {
      throw new CurrencyMismatchError(this.currency, other.currency);
    }
  }

  private static parseCurrency(currency: unknown): string {
    if (typeof currency !== 'string' || !CURRENCY_PATTERN.test(currency)) {
      throw new InvalidCurrencyError();
    }
    return currency;
  }

  private static of(value: Decimal, currency: string): Money {
    if (value.decimalPlaces() > SCALE) {
      throw new InvalidMoneyAmountError();
    }
    if (value.abs().greaterThan(MAX_ABSOLUTE_VALUE)) {
      throw new MoneyOutOfRangeError();
    }
    return new Money(value.isZero() ? new MoneyDecimal(0) : value, currency);
  }
}
