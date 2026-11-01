import { describe, expect, it } from 'bun:test';
import { Money } from '../../../src/domain/money/money.js';
import { CurrencyMismatchError } from '../../../src/domain/money/money.errors.js';
import { LedgerDirection } from '../../../src/domain/ledger/ledger-direction.js';
import { InvalidLedgerEntryError } from '../../../src/domain/ledger/ledger.errors.js';
import type { WalletLedgerEntry } from '../../../src/domain/ledger/wallet-ledger-entry.js';
import {
  Wallet,
  type OpenWalletProps,
  type WalletMovement,
  type WalletState,
} from '../../../src/domain/wallet/wallet.js';
import {
  BalanceLimitExceededError,
  InsufficientFundsError,
  InvalidWalletError,
} from '../../../src/domain/wallet/wallet.errors.js';

const brl = (amount: string): Money => Money.from({ amount, currency: 'BRL' });
const usd = (amount: string): Money => Money.from({ amount, currency: 'USD' });
const MAX = '999999999999999999.99';
const OPENED_AT = new Date('2026-10-31T12:00:00.000Z');
const LATER = new Date('2026-10-31T12:05:00.000Z');

const openProps = (
  overrides: Partial<OpenWalletProps> = {},
): OpenWalletProps => ({
  id: 'wallet-1',
  playerId: 'player-1',
  initialBalance: brl('100.00'),
  at: OPENED_AT,
  opening: { entryId: 'entry-opening', transactionId: 'tx-opening' },
  ...overrides,
});

const openWallet = (initialBalance = '100.00'): Wallet =>
  Wallet.open(
    initialBalance === '0.00'
      ? openProps({ initialBalance: brl('0.00'), opening: undefined })
      : openProps({ initialBalance: brl(initialBalance) }),
  ).wallet;

let sequence = 0;
const movement = (at: Date = LATER): WalletMovement => {
  sequence += 1;
  return { entryId: `entry-${sequence}`, transactionId: `tx-${sequence}`, at };
};

const snapshot = (wallet: Wallet) => ({
  balance: wallet.balance.toJSON(),
  version: wallet.version,
  updatedAt: wallet.updatedAt.getTime(),
});

const state = (overrides: Partial<WalletState> = {}): WalletState => ({
  id: 'wallet-1',
  playerId: 'player-1',
  currency: 'BRL',
  balance: brl('250.00'),
  version: 7,
  createdAt: OPENED_AT,
  updatedAt: LATER,
  ...overrides,
});

describe('Wallet', () => {
  describe('open', () => {
    it('opens with zero balance, version 1 and no ledger entry', () => {
      const { wallet, openingEntry } = Wallet.open(
        openProps({ initialBalance: brl('0.00'), opening: undefined }),
      );

      expect(wallet.id).toBe('wallet-1');
      expect(wallet.playerId).toBe('player-1');
      expect(wallet.currency).toBe('BRL');
      expect(wallet.balance.toJSON()).toEqual({
        amount: '0.00',
        currency: 'BRL',
      });
      expect(wallet.version).toBe(1);
      expect(wallet.createdAt).toEqual(OPENED_AT);
      expect(wallet.updatedAt).toEqual(OPENED_AT);
      expect(openingEntry).toBeUndefined();
    });

    it('opens with positive balance, version 1 and an opening CREDIT entry', () => {
      const { wallet, openingEntry } = Wallet.open(openProps());

      expect(wallet.balance.toJSON()).toEqual({
        amount: '100.00',
        currency: 'BRL',
      });
      expect(wallet.version).toBe(1);
      expect(openingEntry).toBeDefined();
      const entry = openingEntry as WalletLedgerEntry;
      expect(entry.id).toBe('entry-opening');
      expect(entry.walletId).toBe('wallet-1');
      expect(entry.transactionId).toBe('tx-opening');
      expect(entry.direction).toBe(LedgerDirection.Credit);
      expect(entry.money.equals(brl('100.00'))).toBe(true);
      expect(entry.balanceBefore.isZero()).toBe(true);
      expect(entry.balanceAfter.equals(wallet.balance)).toBe(true);
      expect(entry.createdAt).toEqual(OPENED_AT);
      expect(entry.isBalanced()).toBe(true);
    });

    it('takes its currency from the initial balance', () => {
      const { wallet } = Wallet.open(
        openProps({ initialBalance: usd('10.00') }),
      );
      expect(wallet.currency).toBe('USD');
    });

    it('rejects a negative initial balance', () => {
      expect(() =>
        Wallet.open(openProps({ initialBalance: brl('10.00').negate() })),
      ).toThrow(InvalidWalletError);
    });

    it('requires opening movement ids for a positive initial balance', () => {
      expect(() => Wallet.open(openProps({ opening: undefined }))).toThrow(
        InvalidWalletError,
      );
    });

    it('rejects opening movement ids for a zero initial balance', () => {
      expect(() =>
        Wallet.open(openProps({ initialBalance: brl('0.00') })),
      ).toThrow(InvalidWalletError);
    });

    it('propagates ledger validation of the opening entry', () => {
      expect(() =>
        Wallet.open(
          openProps({ opening: { entryId: '', transactionId: 'tx' } }),
        ),
      ).toThrow(InvalidLedgerEntryError);
    });

    it.each([
      ['id', ''],
      ['playerId', '  '],
      ['playerId', undefined],
      ['initialBalance', { amount: '1.00', currency: 'BRL' }],
      ['at', new Date('invalid')],
    ] as const)('rejects invalid %s %p', (field, value) => {
      expect(() => Wallet.open(openProps({ [field]: value as any }))).toThrow(
        InvalidWalletError,
      );
    });

    it('opens at the upper Money limit', () => {
      const { wallet, openingEntry } = Wallet.open(
        openProps({ initialBalance: brl(MAX) }),
      );
      expect(wallet.balance.toJSON().amount).toBe(MAX);
      expect(openingEntry?.isBalanced()).toBe(true);
    });
  });

  describe('debit', () => {
    it('subtracts the amount, bumps version, updates updatedAt and returns a DEBIT entry', () => {
      const wallet = openWallet('100.00');
      const move = movement();

      const entry = wallet.debit(brl('25.00'), move);

      expect(wallet.balance.toJSON().amount).toBe('75.00');
      expect(wallet.version).toBe(2);
      expect(wallet.updatedAt).toEqual(LATER);
      expect(entry.id).toBe(move.entryId);
      expect(entry.walletId).toBe(wallet.id);
      expect(entry.transactionId).toBe(move.transactionId);
      expect(entry.direction).toBe(LedgerDirection.Debit);
      expect(entry.money.equals(brl('25.00'))).toBe(true);
      expect(entry.balanceBefore.equals(brl('100.00'))).toBe(true);
      expect(entry.balanceAfter.equals(wallet.balance)).toBe(true);
      expect(entry.createdAt).toEqual(LATER);
      expect(entry.isBalanced()).toBe(true);
    });

    it('allows debiting the full balance down to zero', () => {
      const wallet = openWallet('25.00');
      wallet.debit(brl('25.00'), movement());
      expect(wallet.balance.isZero()).toBe(true);
    });

    it('rejects insufficient funds without changing state', () => {
      const wallet = openWallet('10.00');
      const before = snapshot(wallet);

      expect(() => wallet.debit(brl('10.01'), movement())).toThrow(
        InsufficientFundsError,
      );
      expect(snapshot(wallet)).toEqual(before);
    });

    it('rejects any debit on an empty wallet', () => {
      const wallet = openWallet('0.00');
      expect(() => wallet.debit(brl('0.01'), movement())).toThrow(
        InsufficientFundsError,
      );
    });
  });

  describe('credit', () => {
    it('adds the amount, bumps version, updates updatedAt and returns a CREDIT entry', () => {
      const wallet = openWallet('100.00');
      const move = movement();

      const entry = wallet.credit(brl('40.50'), move);

      expect(wallet.balance.toJSON().amount).toBe('140.50');
      expect(wallet.version).toBe(2);
      expect(wallet.updatedAt).toEqual(LATER);
      expect(entry.id).toBe(move.entryId);
      expect(entry.walletId).toBe(wallet.id);
      expect(entry.transactionId).toBe(move.transactionId);
      expect(entry.direction).toBe(LedgerDirection.Credit);
      expect(entry.money.equals(brl('40.50'))).toBe(true);
      expect(entry.balanceBefore.equals(brl('100.00'))).toBe(true);
      expect(entry.balanceAfter.equals(wallet.balance)).toBe(true);
      expect(entry.isBalanced()).toBe(true);
    });

    it('credits an empty wallet', () => {
      const wallet = openWallet('0.00');
      wallet.credit(brl('0.01'), movement());
      expect(wallet.balance.toJSON().amount).toBe('0.01');
    });
  });

  describe('invalid movements keep state intact', () => {
    it.each([
      ['debit', 'zero', brl('0.00'), InvalidWalletError],
      ['credit', 'zero', brl('0.00'), InvalidWalletError],
      ['debit', 'negative', brl('5.00').negate(), InvalidWalletError],
      ['credit', 'negative', brl('5.00').negate(), InvalidWalletError],
      ['debit', 'other currency', usd('5.00'), CurrencyMismatchError],
      ['credit', 'other currency', usd('5.00'), CurrencyMismatchError],
    ] as const)('%s rejects %s amount', (operation, _label, money, error) => {
      const wallet = openWallet('100.00');
      const before = snapshot(wallet);

      expect(() => wallet[operation](money, movement())).toThrow(error);
      expect(snapshot(wallet)).toEqual(before);
    });

    it.each([
      ['empty entryId', { entryId: '', transactionId: 'tx', at: LATER }],
      ['empty transactionId', { entryId: 'e', transactionId: ' ', at: LATER }],
      [
        'invalid date',
        { entryId: 'e', transactionId: 'tx', at: new Date(NaN) },
      ],
    ] as const)(
      'is atomic when ledger entry creation fails: %s',
      (_label, move) => {
        const wallet = openWallet('100.00');
        const before = snapshot(wallet);

        expect(() => wallet.debit(brl('10.00'), move)).toThrow(
          InvalidLedgerEntryError,
        );
        expect(() => wallet.credit(brl('10.00'), move)).toThrow(
          InvalidLedgerEntryError,
        );
        expect(snapshot(wallet)).toEqual(before);
      },
    );
  });

  describe('version', () => {
    it('increments by exactly one per balance change', () => {
      const wallet = openWallet('100.00');
      wallet.debit(brl('1.00'), movement());
      wallet.credit(brl('2.00'), movement());
      wallet.debit(brl('3.00'), movement());
      expect(wallet.version).toBe(4);
    });

    it('does not change when an operation is rejected', () => {
      const wallet = openWallet('5.00');
      expect(() => wallet.debit(brl('6.00'), movement())).toThrow();
      expect(() => wallet.credit(brl('0.00'), movement())).toThrow();
      expect(() => wallet.credit(usd('1.00'), movement())).toThrow();
      expect(wallet.version).toBe(1);
    });
  });

  describe('Money limit', () => {
    it('credits up to the upper limit', () => {
      const wallet = openWallet('0.00');
      wallet.credit(brl(MAX), movement());
      expect(wallet.balance.toJSON().amount).toBe(MAX);
    });

    it('rejects a credit beyond the upper limit without changing state', () => {
      const wallet = openWallet(MAX);
      const before = snapshot(wallet);

      expect(() => wallet.credit(brl('0.01'), movement())).toThrow(
        BalanceLimitExceededError,
      );
      expect(snapshot(wallet)).toEqual(before);
    });

    it('debits the full upper limit down to zero', () => {
      const wallet = openWallet(MAX);
      const entry = wallet.debit(brl(MAX), movement());
      expect(wallet.balance.isZero()).toBe(true);
      expect(entry.isBalanced()).toBe(true);
    });
  });

  describe('sequential operations', () => {
    it('keeps balance, version and ledger chain consistent', () => {
      const { wallet, openingEntry } = Wallet.open(openProps());
      const entries: WalletLedgerEntry[] = [openingEntry as WalletLedgerEntry];
      const operations = [
        ['debit', '30.00'],
        ['credit', '12.34'],
        ['debit', '0.01'],
        ['debit', '82.33'],
        ['credit', '1000.00'],
        ['debit', '1000.00'],
      ] as const;

      for (const [operation, amount] of operations) {
        entries.push(wallet[operation](brl(amount), movement()));
      }

      for (let i = 1; i < entries.length; i += 1) {
        const previous = entries[i - 1] as WalletLedgerEntry;
        const current = entries[i] as WalletLedgerEntry;
        expect(current.balanceBefore.equals(previous.balanceAfter)).toBe(true);
        expect(current.isBalanced()).toBe(true);
      }

      const replayed = entries.reduce(
        (balance, entry) =>
          entry.direction === LedgerDirection.Credit
            ? balance.add(entry.money)
            : balance.subtract(entry.money),
        Money.zero('BRL'),
      );
      expect(replayed.equals(wallet.balance)).toBe(true);
      expect(wallet.balance.toJSON().amount).toBe('0.00');
      expect(wallet.version).toBe(1 + operations.length);
      expect(
        (entries.at(-1) as WalletLedgerEntry).balanceAfter.equals(
          wallet.balance,
        ),
      ).toBe(true);
    });
  });

  describe('rehydrate', () => {
    it('rebuilds persisted state without resetting version', () => {
      const wallet = Wallet.rehydrate(state());

      expect(wallet.id).toBe('wallet-1');
      expect(wallet.playerId).toBe('player-1');
      expect(wallet.currency).toBe('BRL');
      expect(wallet.balance.toJSON().amount).toBe('250.00');
      expect(wallet.version).toBe(7);
      expect(wallet.createdAt).toEqual(OPENED_AT);
      expect(wallet.updatedAt).toEqual(LATER);
    });

    it('continues operating from the persisted state', () => {
      const wallet = Wallet.rehydrate(state());
      const entry = wallet.debit(brl('50.00'), movement());

      expect(wallet.version).toBe(8);
      expect(entry.balanceBefore.equals(brl('250.00'))).toBe(true);
      expect(wallet.balance.toJSON().amount).toBe('200.00');
    });

    it.each([
      ['id', ''],
      ['playerId', undefined],
      ['balance', '250.00'],
      ['currency', 'USD'],
      ['version', 0],
      ['version', 1.5],
      ['version', Number.NaN],
      ['createdAt', new Date('invalid')],
      ['updatedAt', '2026-10-31'],
    ] as const)('rejects structurally invalid %s %p', (field, value) => {
      expect(() => Wallet.rehydrate(state({ [field]: value as any }))).toThrow(
        InvalidWalletError,
      );
    });
  });

  describe('immutability', () => {
    it.each([
      ['id'],
      ['playerId'],
      ['currency'],
      ['balance'],
      ['version'],
      ['createdAt'],
      ['updatedAt'],
    ] as const)('rejects direct assignment to %s', (field) => {
      const wallet = openWallet('100.00');
      const before = snapshot(wallet);

      expect(() => {
        (wallet as any)[field] = 'tampered';
      }).toThrow(TypeError);
      expect(snapshot(wallet)).toEqual(before);
      expect(wallet.id).toBe('wallet-1');
    });

    it('rejects adding new properties', () => {
      const wallet = openWallet('100.00');
      expect(Object.isFrozen(wallet)).toBe(true);
      expect(() => {
        (wallet as any).extra = 1;
      }).toThrow(TypeError);
    });

    it('is not affected by mutating dates passed in or returned', () => {
      const at = new Date(OPENED_AT.getTime());
      const { wallet } = Wallet.open(openProps({ at }));
      at.setFullYear(2000);
      wallet.createdAt.setFullYear(2000);
      wallet.updatedAt.setFullYear(2000);

      expect(wallet.createdAt).toEqual(OPENED_AT);
      expect(wallet.updatedAt).toEqual(OPENED_AT);
    });

    it('is not affected by mutating the movement date after an operation', () => {
      const wallet = openWallet('100.00');
      const move = movement(new Date(LATER.getTime()));
      wallet.credit(brl('1.00'), move);
      move.at.setFullYear(2000);

      expect(wallet.updatedAt).toEqual(LATER);
    });

    it('is not affected by mutating rehydration state dates', () => {
      const persisted = state({
        createdAt: new Date(OPENED_AT.getTime()),
        updatedAt: new Date(LATER.getTime()),
      });
      const wallet = Wallet.rehydrate(persisted);
      persisted.createdAt.setFullYear(2000);
      persisted.updatedAt.setFullYear(2000);

      expect(wallet.createdAt).toEqual(OPENED_AT);
      expect(wallet.updatedAt).toEqual(LATER);
    });

    it('exposes only debit and credit as mutating operations', () => {
      const wallet = openWallet('100.00');
      const publicMethods = Object.getOwnPropertyNames(Wallet.prototype).filter(
        (name) =>
          name !== 'constructor' &&
          typeof Object.getOwnPropertyDescriptor(Wallet.prototype, name)
            ?.value === 'function',
      );
      expect(publicMethods.sort()).toEqual(['credit', 'debit']);
      expect(Object.keys(wallet)).toEqual([]);
    });
  });
});
