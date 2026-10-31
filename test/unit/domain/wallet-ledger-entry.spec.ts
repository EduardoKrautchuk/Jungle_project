import { describe, expect, it } from 'bun:test';
import { Money } from '../../../src/domain/money/money.js';
import { CurrencyMismatchError } from '../../../src/domain/money/money.errors.js';
import { LedgerDirection } from '../../../src/domain/ledger/ledger-direction.js';
import {
  InvalidLedgerEntryError,
  UnbalancedLedgerEntryError,
} from '../../../src/domain/ledger/ledger.errors.js';
import {
  WalletLedgerEntry,
  type LedgerEntryState,
} from '../../../src/domain/ledger/wallet-ledger-entry.js';

const brl = (amount: string): Money => Money.from({ amount, currency: 'BRL' });
const usd = (amount: string): Money => Money.from({ amount, currency: 'USD' });
const MAX = '999999999999999999.99';
const AT = new Date('2026-10-31T12:00:00.000Z');

const credit = (
  overrides: Partial<LedgerEntryState> = {},
): LedgerEntryState => ({
  id: 'entry-1',
  walletId: 'wallet-1',
  transactionId: 'tx-1',
  direction: LedgerDirection.Credit,
  money: brl('25.00'),
  balanceBefore: brl('100.00'),
  balanceAfter: brl('125.00'),
  createdAt: AT,
  ...overrides,
});

const debit = (
  overrides: Partial<LedgerEntryState> = {},
): LedgerEntryState => ({
  ...credit(),
  direction: LedgerDirection.Debit,
  balanceAfter: brl('75.00'),
  ...overrides,
});

describe('WalletLedgerEntry', () => {
  describe('create', () => {
    it('creates a balanced CREDIT entry and exposes all fields', () => {
      const entry = WalletLedgerEntry.create(credit());

      expect(entry.id).toBe('entry-1');
      expect(entry.walletId).toBe('wallet-1');
      expect(entry.transactionId).toBe('tx-1');
      expect(entry.direction).toBe(LedgerDirection.Credit);
      expect(entry.money.toJSON()).toEqual({
        amount: '25.00',
        currency: 'BRL',
      });
      expect(entry.balanceBefore.toJSON()).toEqual({
        amount: '100.00',
        currency: 'BRL',
      });
      expect(entry.balanceAfter.toJSON()).toEqual({
        amount: '125.00',
        currency: 'BRL',
      });
      expect(entry.createdAt).toEqual(AT);
      expect(entry.isBalanced()).toBe(true);
    });

    it('creates a balanced DEBIT entry', () => {
      const entry = WalletLedgerEntry.create(debit());

      expect(entry.direction).toBe(LedgerDirection.Debit);
      expect(entry.isBalanced()).toBe(true);
    });

    it('accepts a CREDIT from zero balance (opening credit)', () => {
      const entry = WalletLedgerEntry.create(
        credit({
          balanceBefore: brl('0.00'),
          money: brl('50.00'),
          balanceAfter: brl('50.00'),
        }),
      );
      expect(entry.isBalanced()).toBe(true);
    });

    it('accepts a DEBIT that leaves the balance at exactly zero', () => {
      const entry = WalletLedgerEntry.create(
        debit({
          balanceBefore: brl('25.00'),
          money: brl('25.00'),
          balanceAfter: brl('0.00'),
        }),
      );
      expect(entry.balanceAfter.isZero()).toBe(true);
    });

    it('keeps cent-level precision exact', () => {
      const entry = WalletLedgerEntry.create(
        credit({
          balanceBefore: brl('0.10'),
          money: brl('0.20'),
          balanceAfter: brl('0.30'),
        }),
      );
      expect(entry.isBalanced()).toBe(true);
    });

    it('accepts movements at the upper Money limit', () => {
      const entry = WalletLedgerEntry.create(
        credit({
          balanceBefore: brl('0.00'),
          money: brl(MAX),
          balanceAfter: brl(MAX),
        }),
      );
      expect(entry.isBalanced()).toBe(true);
    });

    it('rejects a credit whose result cannot be represented, without overflowing', () => {
      expect(() =>
        WalletLedgerEntry.create(
          credit({
            balanceBefore: brl(MAX),
            money: brl('0.01'),
            balanceAfter: brl(MAX),
          }),
        ),
      ).toThrow(UnbalancedLedgerEntryError);
    });

    describe('arithmetic', () => {
      it.each([
        ['CREDIT off by one cent', credit({ balanceAfter: brl('125.01') })],
        ['CREDIT applied as debit', credit({ balanceAfter: brl('75.00') })],
        ['DEBIT off by one cent', debit({ balanceAfter: brl('74.99') })],
        ['DEBIT applied as credit', debit({ balanceAfter: brl('125.00') })],
        ['balance unchanged', credit({ balanceAfter: brl('100.00') })],
      ] as const)('rejects unbalanced entry: %s', (_label, props) => {
        expect(() => WalletLedgerEntry.create(props)).toThrow(
          UnbalancedLedgerEntryError,
        );
      });

      it('exposes a stable error code for unbalanced entries', () => {
        try {
          WalletLedgerEntry.create(credit({ balanceAfter: brl('1.00') }));
          throw new Error('expected create to throw');
        } catch (error) {
          expect(error).toBeInstanceOf(UnbalancedLedgerEntryError);
          expect((error as UnbalancedLedgerEntryError).code).toBe(
            'LEDGER_UNBALANCED_ENTRY',
          );
        }
      });
    });

    describe('movement amount', () => {
      it('rejects a zero movement', () => {
        expect(() =>
          WalletLedgerEntry.create(
            credit({ money: brl('0.00'), balanceAfter: brl('100.00') }),
          ),
        ).toThrow(InvalidLedgerEntryError);
      });

      it('rejects a negative movement', () => {
        const negative = brl('25.00').negate();
        expect(() =>
          WalletLedgerEntry.create(
            credit({ money: negative, balanceAfter: brl('75.00') }),
          ),
        ).toThrow(InvalidLedgerEntryError);
      });
    });

    describe('non-negative balances', () => {
      it('rejects a DEBIT that would make balanceAfter negative', () => {
        const overdrawn = brl('10.00').subtract(brl('25.00'));
        expect(() =>
          WalletLedgerEntry.create(
            debit({ balanceBefore: brl('10.00'), balanceAfter: overdrawn }),
          ),
        ).toThrow(InvalidLedgerEntryError);
      });

      it('rejects a negative balanceBefore', () => {
        const negativeBefore = brl('30.00').negate();
        const after = negativeBefore.add(brl('25.00'));
        expect(() =>
          WalletLedgerEntry.create(
            credit({ balanceBefore: negativeBefore, balanceAfter: after }),
          ),
        ).toThrow(InvalidLedgerEntryError);
      });
    });

    describe('currency', () => {
      it('rejects money in a different currency than balanceBefore', () => {
        expect(() =>
          WalletLedgerEntry.create(
            credit({
              balanceBefore: usd('100.00'),
              balanceAfter: brl('125.00'),
            }),
          ),
        ).toThrow(CurrencyMismatchError);
      });

      it('rejects money in a different currency than balanceAfter', () => {
        expect(() =>
          WalletLedgerEntry.create(credit({ balanceAfter: usd('125.00') })),
        ).toThrow(CurrencyMismatchError);
      });

      it('rejects an entry fully in another currency than its movement', () => {
        expect(() =>
          WalletLedgerEntry.create(credit({ money: usd('25.00') })),
        ).toThrow(CurrencyMismatchError);
      });

      it('accepts a consistent entry in a non-BRL currency', () => {
        const entry = WalletLedgerEntry.create(
          credit({
            money: usd('25.00'),
            balanceBefore: usd('100.00'),
            balanceAfter: usd('125.00'),
          }),
        );
        expect(entry.money.currency).toBe('USD');
      });
    });

    describe('structure', () => {
      it.each([
        ['id', ''],
        ['id', '   '],
        ['walletId', ''],
        ['transactionId', ''],
        ['id', undefined],
        ['walletId', 123],
      ] as const)('rejects invalid %s %p', (field, value) => {
        expect(() =>
          WalletLedgerEntry.create(credit({ [field]: value as any })),
        ).toThrow(InvalidLedgerEntryError);
      });

      it.each([['debit'], ['IN'], [''], [undefined]])(
        'rejects unknown direction %p',
        (direction) => {
          expect(() =>
            WalletLedgerEntry.create(credit({ direction: direction as any })),
          ).toThrow(InvalidLedgerEntryError);
        },
      );

      it.each([['money'], ['balanceBefore'], ['balanceAfter']] as const)(
        'rejects %s that is not a Money instance',
        (field) => {
          expect(() =>
            WalletLedgerEntry.create(
              credit({ [field]: { amount: '25.00', currency: 'BRL' } as any }),
            ),
          ).toThrow(InvalidLedgerEntryError);
        },
      );

      it.each([[new Date('invalid')], ['2026-10-31'], [undefined]])(
        'rejects invalid createdAt %p',
        (createdAt) => {
          expect(() =>
            WalletLedgerEntry.create(credit({ createdAt: createdAt as any })),
          ).toThrow(InvalidLedgerEntryError);
        },
      );
    });
  });

  describe('immutability', () => {
    it('is frozen: assigning a field throws', () => {
      const entry = WalletLedgerEntry.create(credit());
      expect(Object.isFrozen(entry)).toBe(true);
      expect(() => {
        (entry as any).balanceAfter = brl('999.00');
      }).toThrow(TypeError);
      expect(() => {
        (entry as any).direction = LedgerDirection.Debit;
      }).toThrow(TypeError);
      expect(entry.balanceAfter.toJSON().amount).toBe('125.00');
    });

    it('is not affected by mutating the Date passed to create', () => {
      const createdAt = new Date(AT.getTime());
      const entry = WalletLedgerEntry.create(credit({ createdAt }));
      createdAt.setFullYear(2000);
      expect(entry.createdAt).toEqual(AT);
    });

    it('is not affected by mutating the Date returned by createdAt', () => {
      const entry = WalletLedgerEntry.create(credit());
      entry.createdAt.setFullYear(2000);
      expect(entry.createdAt).toEqual(AT);
    });

    it('exposes no transition methods', () => {
      const methods = Object.getOwnPropertyNames(
        WalletLedgerEntry.prototype,
      ).filter((name) => name !== 'constructor');
      expect(methods.sort()).toEqual(['createdAt', 'isBalanced']);
    });
  });

  describe('rehydrate', () => {
    it('rebuilds a valid persisted entry with identical state', () => {
      const original = WalletLedgerEntry.create(debit());
      const restored = WalletLedgerEntry.rehydrate({
        id: original.id,
        walletId: original.walletId,
        transactionId: original.transactionId,
        direction: original.direction,
        money: original.money,
        balanceBefore: original.balanceBefore,
        balanceAfter: original.balanceAfter,
        createdAt: original.createdAt,
      });

      expect(restored).toEqual(original);
      expect(restored.isBalanced()).toBe(true);
      expect(Object.isFrozen(restored)).toBe(true);
    });

    it('does not re-run arithmetic: loads an unbalanced row so isBalanced() can flag it', () => {
      const corrupted = WalletLedgerEntry.rehydrate(
        credit({ balanceAfter: brl('999.00') }),
      );
      expect(corrupted.isBalanced()).toBe(false);
    });

    it('does not re-run currency rules: isBalanced() returns false instead of throwing', () => {
      const corrupted = WalletLedgerEntry.rehydrate(
        credit({ balanceAfter: usd('125.00') }),
      );
      expect(corrupted.isBalanced()).toBe(false);
    });

    it.each([
      [
        'zero money',
        credit({ money: brl('0.00'), balanceAfter: brl('100.00') }),
      ],
      [
        'negative money that still adds up',
        credit({ money: brl('25.00').negate(), balanceAfter: brl('75.00') }),
      ],
      [
        'negative balanceAfter that still adds up',
        debit({
          balanceBefore: brl('10.00'),
          balanceAfter: brl('10.00').subtract(brl('25.00')),
        }),
      ],
      [
        'negative balanceBefore that still adds up',
        credit({
          balanceBefore: brl('30.00').negate(),
          balanceAfter: brl('30.00').negate().add(brl('25.00')),
        }),
      ],
      ['money in another currency', credit({ money: usd('25.00') })],
      [
        'credit beyond the Money range',
        credit({
          balanceBefore: brl(MAX),
          money: brl(MAX),
          balanceAfter: brl(MAX),
        }),
      ],
      [
        'debit of the full range from a negative balance',
        debit({
          balanceBefore: brl(MAX).negate(),
          money: brl(MAX),
          balanceAfter: brl('0.00'),
        }),
      ],
    ] as const)(
      'isBalanced() returns false without throwing for %s',
      (_label, state) => {
        const corrupted = WalletLedgerEntry.rehydrate(state);
        expect(() => corrupted.isBalanced()).not.toThrow();
        expect(corrupted.isBalanced()).toBe(false);
      },
    );

    it('protects createdAt of a rehydrated entry from external mutation', () => {
      const createdAt = new Date(AT.getTime());
      const entry = WalletLedgerEntry.rehydrate(credit({ createdAt }));
      createdAt.setFullYear(2000);
      entry.createdAt.setFullYear(2000);
      expect(entry.createdAt).toEqual(AT);
    });

    it('still enforces structural guarantees', () => {
      expect(() => WalletLedgerEntry.rehydrate(credit({ id: '' }))).toThrow(
        InvalidLedgerEntryError,
      );
      expect(() =>
        WalletLedgerEntry.rehydrate(credit({ direction: 'SIDEWAYS' as any })),
      ).toThrow(InvalidLedgerEntryError);
      expect(() =>
        WalletLedgerEntry.rehydrate(credit({ money: '25.00' as any })),
      ).toThrow(InvalidLedgerEntryError);
      expect(() =>
        WalletLedgerEntry.rehydrate(credit({ createdAt: new Date(NaN) })),
      ).toThrow(InvalidLedgerEntryError);
    });
  });
});
