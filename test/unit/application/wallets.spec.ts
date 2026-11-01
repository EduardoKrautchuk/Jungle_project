import { beforeEach, describe, expect, it } from 'bun:test';
import {
  InvalidRequestError,
  WalletAlreadyExistsError,
  WalletNotFoundError,
} from '../../../src/application/application.errors.js';
import {
  decodeLedgerCursor,
  encodeLedgerCursor,
} from '../../../src/application/wallets/ledger-cursor.js';
import {
  createHarness,
  eventsFor,
  ledgerOf,
  openWallet,
  wager,
  type Harness,
} from './support/wagering-harness.js';

let h: Harness;

beforeEach(() => {
  h = createHarness();
});

async function caught(action: Promise<unknown>): Promise<unknown> {
  try {
    await action;
  } catch (error) {
    return error;
  }
  return undefined;
}

describe('CreateWallet', () => {
  it('opens the wallet with an OPENING transaction, a CREDIT entry and events in one unit of work', async () => {
    const commits = h.uow.commits;
    const wallet = await openWallet(h, '1000.00', 'player-x');

    expect(h.uow.commits).toBe(commits + 1);
    expect(wallet.version).toBe(1);
    expect(wallet.balance.toJSON()).toEqual({
      amount: '1000.00',
      currency: 'BRL',
    });
    const [opening] = h.uow.tables.transactions;
    expect(opening).toMatchObject({
      kind: 'OPENING',
      status: 'PROCESSED',
      providerId: '_internal',
      walletId: wallet.id,
      amount: '1000.00',
      resultBalance: '1000.00',
    });
    expect(ledgerOf(h, wallet.id)).toMatchObject([
      { direction: 'CREDIT', balanceBefore: '0.00', balanceAfter: '1000.00' },
    ]);
    expect(eventsFor(h, wallet.id)).toEqual(['WalletBalanceChanged']);
    expect(eventsFor(h, opening?.id ?? '')).toEqual([
      'WagerTransactionProcessed',
    ]);
  });

  it('opens a zero balance wallet without transaction, ledger or events', async () => {
    const wallet = await openWallet(h, '0.00');
    expect(wallet.balance.isZero()).toBe(true);
    expect(h.uow.tables.transactions).toHaveLength(0);
    expect(h.uow.tables.ledger).toHaveLength(0);
    expect(h.uow.tables.outbox).toHaveLength(0);
  });

  it('refuses a second wallet for the same player and currency', async () => {
    await openWallet(h, '10.00', 'player-dup');
    const error = await caught(openWallet(h, '20.00', 'player-dup'));
    expect(error).toBeInstanceOf(WalletAlreadyExistsError);
    expect(h.uow.tables.wallets).toHaveLength(1);
    expect(h.uow.tables.transactions).toHaveLength(1);
  });

  it.each(['-1.00', '1.5', '1e2', ''])(
    'rejects initial balance %p',
    async (amount) => {
      const error = await caught(openWallet(h, amount));
      expect(error).toBeInstanceOf(InvalidRequestError);
      expect(h.uow.commits).toBe(0);
    },
  );
});

describe('WalletQueries', () => {
  it('pages the ledger with a stable opaque cursor', async () => {
    const wallet = await openWallet(h);
    for (let i = 0; i < 4; i += 1) {
      await h.submit.execute(
        wager(wallet, { money: { amount: '1.00', currency: 'BRL' } }),
      );
    }
    const first = await h.queries.listLedger(wallet.id, {
      cursor: undefined,
      limit: 2,
    });
    const second = await h.queries.listLedger(wallet.id, {
      cursor: first.nextCursor,
      limit: 2,
    });
    const third = await h.queries.listLedger(wallet.id, {
      cursor: second.nextCursor,
      limit: 2,
    });
    const ids = [...first.entries, ...second.entries, ...third.entries].map(
      (e) => e.id,
    );
    expect(ids).toEqual(ledgerOf(h, wallet.id).map((e) => e.id));
    expect(third.entries).toHaveLength(1);
    expect(third.nextCursor).toBeUndefined();
    expect(
      [...first.entries, ...second.entries, ...third.entries].map(
        (e) => e.balanceAfter.toJSON().amount,
      ),
    ).toEqual(['100.00', '99.00', '98.00', '97.00', '96.00']);
  });

  it('rejects tampered cursors', async () => {
    const wallet = await openWallet(h);
    for (const cursor of [
      '%%%',
      'e30',
      encodeLedgerCursor({ createdAt: new Date(0), id: 'x' }),
    ]) {
      const error = await caught(
        h.queries.listLedger(wallet.id, { cursor, limit: 2 }),
      );
      expect(error).toBeInstanceOf(InvalidRequestError);
    }
  });

  it('round-trips cursors', () => {
    const cursor = {
      createdAt: new Date('2026-10-31T12:00:00.123Z'),
      id: '00000000-0000-7000-8000-000000000001',
    };
    expect(decodeLedgerCursor(encodeLedgerCursor(cursor))).toEqual(cursor);
  });

  it('reports a consistent wallet', async () => {
    const wallet = await openWallet(h);
    await h.submit.execute(wager(wallet));
    await h.submit.execute(
      wager(wallet, {
        kind: 'WIN',
        money: { amount: '5.50', currency: 'BRL' },
      }),
    );
    const report = await h.queries.reconcile(wallet.id);
    expect(report.consistent).toBe(true);
    expect(report.storedBalance.toJSON().amount).toBe('80.50');
    expect(report.calculatedBalance.toJSON().amount).toBe('80.50');
    expect(report.difference.toJSON().amount).toBe('0.00');
    expect(report.checkedEntries).toBe(3);
  });

  it('reconciles a wallet whose lifetime credits exceed the Money range', async () => {
    const max = '999999999999999999.99';
    const wallet = await openWallet(h, max);
    await h.submit.execute(
      wager(wallet, { money: { amount: max, currency: 'BRL' } }),
    );
    await h.submit.execute(
      wager(wallet, { kind: 'WIN', money: { amount: max, currency: 'BRL' } }),
    );
    const report = await h.queries.reconcile(wallet.id);
    expect(report.consistent).toBe(true);
    expect(report.calculatedBalance.toJSON().amount).toBe(max);
    expect(report.checkedEntries).toBe(3);
  });

  it('flags a divergence without correcting it', async () => {
    const wallet = await openWallet(h);
    h.uow.tables.wallets = h.uow.tables.wallets.map((w) =>
      w.id === wallet.id ? { ...w, balance: '90.00' } : w,
    );
    const report = await h.queries.reconcile(wallet.id);
    expect(report.consistent).toBe(false);
    expect(report.difference.toJSON().amount).toBe('-10.00');
    expect(h.uow.tables.wallets.find((w) => w.id === wallet.id)?.balance).toBe(
      '90.00',
    );
  });

  it('reports unknown wallets', async () => {
    const missing = '00000000-0000-7000-8000-999999999999';
    expect(await caught(h.queries.getWallet(missing))).toBeInstanceOf(
      WalletNotFoundError,
    );
    expect(
      await caught(
        h.queries.listLedger(missing, { cursor: undefined, limit: 1 }),
      ),
    ).toBeInstanceOf(WalletNotFoundError);
    expect(await caught(h.queries.reconcile(missing))).toBeInstanceOf(
      WalletNotFoundError,
    );
  });
});
