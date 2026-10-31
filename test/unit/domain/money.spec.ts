import { describe, expect, it } from 'bun:test';
import { Money } from '../../../src/domain/money/money.js';
import {
  CurrencyMismatchError,
  InvalidCurrencyError,
  InvalidMoneyAmountError,
  MoneyOutOfRangeError,
} from '../../../src/domain/money/money.errors.js';

const MAX = '999999999999999999.99';

const brl = (amount: string): Money => Money.from({ amount, currency: 'BRL' });
const usd = (amount: string): Money => Money.from({ amount, currency: 'USD' });

describe('Money', () => {
  describe('from', () => {
    it.each(['0.00', '0.01', '25.00', '1000.50', MAX])(
      'accepts %p and keeps it exact',
      (amount) => {
        expect(brl(amount).toJSON()).toEqual({ amount, currency: 'BRL' });
      },
    );

    it.each([
      '',
      ' ',
      'NaN',
      'Infinity',
      '-Infinity',
      '1e3',
      '1E3',
      '1.00e2',
      '10.005',
      '10.5',
      '10',
      '10.',
      '.50',
      '-1.00',
      '-0.00',
      '+1.00',
      ' 1.00',
      '1.00 ',
      '01.00',
      '00.00',
      '1,00',
      '1_000.00',
      '0x10',
      '1000000000000000000.00',
    ])('rejects invalid amount %p', (amount) => {
      expect(() => brl(amount)).toThrow(InvalidMoneyAmountError);
    });

    it.each([[25], [25.5], [null], [undefined], [{}], [['1.00']]])(
      'rejects non-string amount %p',
      (amount) => {
        expect(() =>
          Money.from({ amount: amount as any, currency: 'BRL' }),
        ).toThrow(InvalidMoneyAmountError);
      },
    );

    it.each(['', 'brl', 'Brl', 'BR', 'BRLL', 'R$', ' BRL', '123'])(
      'rejects invalid currency %p',
      (currency) => {
        expect(() => Money.from({ amount: '1.00', currency })).toThrow(
          InvalidCurrencyError,
        );
      },
    );

    it('rejects non-string currency', () => {
      expect(() =>
        Money.from({ amount: '1.00', currency: 986 as any }),
      ).toThrow(InvalidCurrencyError);
    });

    it('exposes stable machine-readable error codes', () => {
      expect(() => brl('1.5')).toThrow(
        expect.objectContaining({ code: 'MONEY_INVALID_AMOUNT' }),
      );
      expect(() => Money.zero('xx')).toThrow(
        expect.objectContaining({ code: 'MONEY_INVALID_CURRENCY' }),
      );
    });
  });

  describe('zero', () => {
    it('creates zero in the given currency', () => {
      const zero = Money.zero('BRL');
      expect(zero.isZero()).toBe(true);
      expect(zero.toJSON()).toEqual({ amount: '0.00', currency: 'BRL' });
    });

    it('validates the currency', () => {
      expect(() => Money.zero('brl')).toThrow(InvalidCurrencyError);
    });
  });

  describe('arithmetic', () => {
    it('adds without floating point error', () => {
      expect(brl('0.10').add(brl('0.20')).equals(brl('0.30'))).toBe(true);
    });

    it('accumulates cents exactly', () => {
      let total = Money.zero('BRL');
      for (let i = 0; i < 1000; i++) {
        total = total.add(brl('0.01'));
      }
      expect(total.toJSON().amount).toBe('10.00');
    });

    it('subtracts', () => {
      expect(brl('100.00').subtract(brl('80.00')).toJSON().amount).toBe(
        '20.00',
      );
    });

    it('allows negative results internally', () => {
      const result = brl('20.00').subtract(brl('80.00'));
      expect(result.isNegative()).toBe(true);
      expect(result.toJSON()).toEqual({ amount: '-60.00', currency: 'BRL' });
    });

    it('negates', () => {
      const negated = brl('25.00').negate();
      expect(negated.toJSON().amount).toBe('-25.00');
      expect(negated.negate().equals(brl('25.00'))).toBe(true);
    });

    it('never produces negative zero', () => {
      expect(Money.zero('BRL').negate().toJSON().amount).toBe('0.00');
      expect(brl('5.00').subtract(brl('5.00')).toJSON().amount).toBe('0.00');
      expect(brl('5.00').negate().add(brl('5.00')).toJSON().amount).toBe(
        '0.00',
      );
    });

    it('handles the maximum value exactly', () => {
      expect(brl(MAX).subtract(brl('0.01')).toJSON().amount).toBe(
        '999999999999999999.98',
      );
      expect(brl(MAX).subtract(brl(MAX)).isZero()).toBe(true);
      expect(brl(MAX).negate().toJSON().amount).toBe(`-${MAX}`);
    });

    it('rejects results above the supported range', () => {
      expect(() => brl(MAX).add(brl('0.01'))).toThrow(MoneyOutOfRangeError);
    });

    it('rejects results below the supported negative range', () => {
      expect(() => brl(MAX).negate().subtract(brl('0.01'))).toThrow(
        MoneyOutOfRangeError,
      );
    });
  });

  describe('predicates', () => {
    it.each([
      ['10.00', false, true, false],
      ['0.00', true, false, false],
    ])('%p -> zero=%p positive=%p negative=%p', (amount, zero, pos, neg) => {
      const money = brl(amount);
      expect(money.isZero()).toBe(zero);
      expect(money.isPositive()).toBe(pos);
      expect(money.isNegative()).toBe(neg);
    });

    it('classifies negative values', () => {
      const money = brl('10.00').negate();
      expect(money.isZero()).toBe(false);
      expect(money.isPositive()).toBe(false);
      expect(money.isNegative()).toBe(true);
    });

    it('compares with isLessThan', () => {
      expect(brl('79.99').isLessThan(brl('80.00'))).toBe(true);
      expect(brl('80.00').isLessThan(brl('80.00'))).toBe(false);
      expect(brl('80.01').isLessThan(brl('80.00'))).toBe(false);
      expect(brl('1.00').negate().isLessThan(Money.zero('BRL'))).toBe(true);
    });

    it('compares equality by value and currency', () => {
      expect(brl('10.00').equals(brl('10.00'))).toBe(true);
      expect(brl('10.00').equals(brl('10.01'))).toBe(false);
      expect(brl('10.00').equals(usd('10.00'))).toBe(false);
    });
  });

  describe('currency mismatch', () => {
    it.each([
      ['add', (a: Money, b: Money) => a.add(b)],
      ['subtract', (a: Money, b: Money) => a.subtract(b)],
      ['isLessThan', (a: Money, b: Money) => a.isLessThan(b)],
    ])('%s throws CurrencyMismatchError', (_name, operation) => {
      expect(() => operation(brl('1.00'), usd('1.00'))).toThrow(
        CurrencyMismatchError,
      );
      expect(() => operation(brl('1.00'), usd('1.00'))).toThrow(
        expect.objectContaining({ code: 'MONEY_CURRENCY_MISMATCH' }),
      );
    });
  });

  describe('immutability', () => {
    it('does not mutate operands', () => {
      const a = brl('10.00');
      const b = brl('3.00');
      const result = a.add(b);
      a.subtract(b);
      a.negate();
      expect(a.toJSON().amount).toBe('10.00');
      expect(b.toJSON().amount).toBe('3.00');
      expect(result).not.toBe(a);
      expect(result.toJSON().amount).toBe('13.00');
    });

    it('is frozen at runtime', () => {
      const money = brl('10.00');
      expect(Object.isFrozen(money)).toBe(true);
      expect(() => {
        (money as any).currency = 'USD';
      }).toThrow(TypeError);
      expect(money.currency).toBe('BRL');
    });
  });

  describe('serialization', () => {
    it('serializes to JSON with fixed scale', () => {
      expect(JSON.stringify(brl('25.00'))).toBe(
        '{"amount":"25.00","currency":"BRL"}',
      );
    });

    it('never uses exponential notation', () => {
      expect(brl(MAX).toJSON().amount).toBe(MAX);
      expect(brl('0.01').toJSON().amount).toBe('0.01');
    });

    it('formats toString with amount and currency', () => {
      expect(brl('25.00').toString()).toBe('25.00 BRL');
    });

    it('round-trips through toJSON and from', () => {
      const original = brl('1234.56');
      expect(Money.from(original.toJSON()).equals(original)).toBe(true);
    });
  });
});
