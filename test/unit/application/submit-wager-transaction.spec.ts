import { beforeEach, describe, expect, it } from 'bun:test';
import {
  IdempotencyConflictError,
  InvalidRequestError,
} from '../../../src/application/application.errors.js';
import { WagerTransactionKind } from '../../../src/domain/wagering/wager-transaction.enums.js';
import {
  FailureCode,
  WagerTransactionStatus,
} from '../../../src/domain/wagering/wager-transaction.enums.js';
import { InjectedFault } from './support/in-memory-unit-of-work.js';
import {
  balanceOf,
  createHarness,
  eventsFor,
  ledgerOf,
  openWallet,
  transactionRecord,
  versionOf,
  wager,
  type Harness,
} from './support/wagering-harness.js';

let h: Harness;

beforeEach(() => {
  h = createHarness();
});

const brl = (amount: string) => ({ amount, currency: 'BRL' });

async function expectRejection(
  action: Promise<unknown>,
  type: new (...args: never[]) => Error,
): Promise<Error> {
  let caught: unknown;
  try {
    await action;
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(type);
  if (!(caught instanceof Error)) {
    throw new Error('expected an error');
  }
  return caught;
}

describe('BET', () => {
  it('debits the exact amount once and records ledger, transaction and events', async () => {
    const wallet = await openWallet(h);
    const result = await h.submit.execute(wager(wallet));

    expect(result.status).toBe(WagerTransactionStatus.Processed);
    expect(result.balance?.toJSON()).toEqual(brl('75.00'));
    expect(result.idempotentReplay).toBe(false);
    expect(balanceOf(h, wallet.id)).toBe('75.00');
    expect(versionOf(h, wallet.id)).toBe(2);

    const entry = ledgerOf(h, wallet.id).find(
      (e) => e.transactionId === result.transactionId,
    );
    expect(entry).toMatchObject({
      direction: 'DEBIT',
      amount: '25.00',
      balanceBefore: '100.00',
      balanceAfter: '75.00',
    });
    expect(eventsFor(h, result.transactionId)).toEqual([
      'WagerTransactionProcessed',
    ]);
    expect(eventsFor(h, wallet.id)).toEqual([
      'WalletBalanceChanged',
      'WalletBalanceChanged',
    ]);
    expect(transactionRecord(h, result.transactionId)).toMatchObject({
      status: 'PROCESSED',
      resultBalance: '75.00',
      failureCode: null,
    });
  });

  it('rejects insufficient funds without touching balance or ledger', async () => {
    const wallet = await openWallet(h, '10.00');
    const result = await h.submit.execute(wager(wallet));

    expect(result.status).toBe(WagerTransactionStatus.Rejected);
    expect(result.failureCode).toBe(FailureCode.InsufficientFunds);
    expect(result.balance?.toJSON()).toEqual(brl('10.00'));
    expect(balanceOf(h, wallet.id)).toBe('10.00');
    expect(versionOf(h, wallet.id)).toBe(1);
    expect(ledgerOf(h, wallet.id)).toHaveLength(1);
    expect(eventsFor(h, result.transactionId)).toEqual([
      'WagerTransactionRejected',
    ]);
  });

  it('allows debiting the whole balance down to zero', async () => {
    const wallet = await openWallet(h, '25.00');
    const result = await h.submit.execute(wager(wallet));
    expect(result.status).toBe(WagerTransactionStatus.Processed);
    expect(balanceOf(h, wallet.id)).toBe('0.00');
  });

  it('keeps exactly one debit when two 80.00 bets compete for 100.00', async () => {
    const wallet = await openWallet(h);
    const results = await Promise.all([
      h.submit.execute(wager(wallet, { money: brl('80.00') })),
      h.submit.execute(wager(wallet, { money: brl('80.00') })),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([
      WagerTransactionStatus.Processed,
      WagerTransactionStatus.Rejected,
    ]);
    expect(balanceOf(h, wallet.id)).toBe('20.00');
    expect(
      ledgerOf(h, wallet.id).filter((e) => e.direction === 'DEBIT'),
    ).toHaveLength(1);
  });
});

describe('WIN', () => {
  it('credits the exact amount without a reference', async () => {
    const wallet = await openWallet(h);
    const result = await h.submit.execute(
      wager(wallet, { kind: 'WIN', money: brl('40.50') }),
    );
    expect(result.status).toBe(WagerTransactionStatus.Processed);
    expect(balanceOf(h, wallet.id)).toBe('140.50');
    expect(ledgerOf(h, wallet.id).at(-1)).toMatchObject({
      direction: 'CREDIT',
      amount: '40.50',
    });
  });

  it('links the referenced BET of the same round', async () => {
    const wallet = await openWallet(h);
    const bet = await h.submit.execute(
      wager(wallet, { externalTransactionId: 'b1' }),
    );
    const win = await h.submit.execute(
      wager(wallet, {
        kind: 'WIN',
        money: brl('60.00'),
        referenceExternalTransactionId: 'b1',
      }),
    );
    expect(win.status).toBe(WagerTransactionStatus.Processed);
    expect(
      transactionRecord(h, win.transactionId)?.referenceTransactionId,
    ).toBe(bet.transactionId);
    expect(balanceOf(h, wallet.id)).toBe('135.00');
  });
});

describe('LOSS', () => {
  it('records the result without moving the balance or writing ledger', async () => {
    const wallet = await openWallet(h);
    await h.submit.execute(wager(wallet, { externalTransactionId: 'b-loss' }));
    const ledgerBefore = ledgerOf(h, wallet.id).length;
    const versionBefore = versionOf(h, wallet.id);

    const loss = await h.submit.execute(
      wager(wallet, { kind: 'LOSS', money: brl('0.00') }),
    );
    expect(loss.status).toBe(WagerTransactionStatus.Processed);
    expect(loss.balance?.toJSON()).toEqual(brl('75.00'));
    expect(ledgerOf(h, wallet.id)).toHaveLength(ledgerBefore);
    expect(versionOf(h, wallet.id)).toBe(versionBefore);
    expect(eventsFor(h, loss.transactionId)).toEqual([
      'WagerTransactionProcessed',
    ]);
  });
});

describe('REFUND', () => {
  it('credits the referenced BET exactly once', async () => {
    const wallet = await openWallet(h);
    const bet = await h.submit.execute(
      wager(wallet, { externalTransactionId: 'r-bet' }),
    );
    const refund = await h.submit.execute(
      wager(wallet, {
        kind: 'REFUND',
        referenceExternalTransactionId: 'r-bet',
      }),
    );
    expect(refund.status).toBe(WagerTransactionStatus.Processed);
    expect(balanceOf(h, wallet.id)).toBe('100.00');
    expect(
      transactionRecord(h, refund.transactionId)?.referenceTransactionId,
    ).toBe(bet.transactionId);

    const duplicate = await h.submit.execute(
      wager(wallet, {
        kind: 'REFUND',
        referenceExternalTransactionId: 'r-bet',
      }),
    );
    expect(duplicate.status).toBe(WagerTransactionStatus.Rejected);
    expect(duplicate.failureCode).toBe(FailureCode.AlreadyReversed);
    expect(balanceOf(h, wallet.id)).toBe('100.00');
  });

  it('rejects a REFUND that references a WIN', async () => {
    const wallet = await openWallet(h);
    await h.submit.execute(
      wager(wallet, { kind: 'WIN', externalTransactionId: 'w1' }),
    );
    const refund = await h.submit.execute(
      wager(wallet, { kind: 'REFUND', referenceExternalTransactionId: 'w1' }),
    );
    expect(refund.failureCode).toBe(FailureCode.InvalidReferenceKind);
  });

  it('rejects a partial REFUND amount', async () => {
    const wallet = await openWallet(h);
    await h.submit.execute(wager(wallet, { externalTransactionId: 'p-bet' }));
    const refund = await h.submit.execute(
      wager(wallet, {
        kind: 'REFUND',
        money: brl('10.00'),
        referenceExternalTransactionId: 'p-bet',
      }),
    );
    expect(refund.failureCode).toBe(FailureCode.ReversalAmountMismatch);
    expect(balanceOf(h, wallet.id)).toBe('75.00');
  });

  it('rejects a reference from another round or another wallet', async () => {
    const wallet = await openWallet(h);
    const other = await openWallet(h);
    await h.submit.execute(wager(wallet, { externalTransactionId: 'm-bet' }));

    const otherRound = await h.submit.execute(
      wager(wallet, {
        kind: 'REFUND',
        roundId: 'round-2',
        referenceExternalTransactionId: 'm-bet',
      }),
    );
    const otherWallet = await h.submit.execute(
      wager(other, { kind: 'REFUND', referenceExternalTransactionId: 'm-bet' }),
    );
    expect(otherRound.failureCode).toBe(FailureCode.ReferenceMismatch);
    expect(otherWallet.failureCode).toBe(FailureCode.ReferenceMismatch);
    expect(balanceOf(h, wallet.id)).toBe('75.00');
    expect(balanceOf(h, other.id)).toBe('100.00');
  });

  it('rejects a reference to a BET that was itself rejected', async () => {
    const wallet = await openWallet(h, '10.00');
    await h.submit.execute(wager(wallet, { externalTransactionId: 'x-bet' }));
    const refund = await h.submit.execute(
      wager(wallet, {
        kind: 'REFUND',
        referenceExternalTransactionId: 'x-bet',
      }),
    );
    expect(refund.failureCode).toBe(FailureCode.ReferenceNotProcessed);
    expect(balanceOf(h, wallet.id)).toBe('10.00');
  });
});

describe('ROLLBACK', () => {
  it('credits back a BET', async () => {
    const wallet = await openWallet(h);
    await h.submit.execute(wager(wallet, { externalTransactionId: 'rb-bet' }));
    const rollback = await h.submit.execute(
      wager(wallet, {
        kind: 'ROLLBACK',
        referenceExternalTransactionId: 'rb-bet',
      }),
    );
    expect(rollback.status).toBe(WagerTransactionStatus.Processed);
    expect(ledgerOf(h, wallet.id).at(-1)?.direction).toBe('CREDIT');
    expect(balanceOf(h, wallet.id)).toBe('100.00');
  });

  it('debits back a WIN', async () => {
    const wallet = await openWallet(h);
    await h.submit.execute(
      wager(wallet, {
        kind: 'WIN',
        money: brl('30.00'),
        externalTransactionId: 'rb-win',
      }),
    );
    const rollback = await h.submit.execute(
      wager(wallet, {
        kind: 'ROLLBACK',
        money: brl('30.00'),
        referenceExternalTransactionId: 'rb-win',
      }),
    );
    expect(rollback.status).toBe(WagerTransactionStatus.Processed);
    expect(ledgerOf(h, wallet.id).at(-1)?.direction).toBe('DEBIT');
    expect(balanceOf(h, wallet.id)).toBe('100.00');
  });

  it('debits back a REFUND', async () => {
    const wallet = await openWallet(h);
    await h.submit.execute(wager(wallet, { externalTransactionId: 'rr-bet' }));
    await h.submit.execute(
      wager(wallet, {
        kind: 'REFUND',
        externalTransactionId: 'rr-refund',
        referenceExternalTransactionId: 'rr-bet',
      }),
    );
    const rollback = await h.submit.execute(
      wager(wallet, {
        kind: 'ROLLBACK',
        referenceExternalTransactionId: 'rr-refund',
      }),
    );
    expect(rollback.status).toBe(WagerTransactionStatus.Processed);
    expect(balanceOf(h, wallet.id)).toBe('75.00');
  });

  it('rejects a second reversal of the same transaction', async () => {
    const wallet = await openWallet(h);
    await h.submit.execute(wager(wallet, { externalTransactionId: 'd-bet' }));
    await h.submit.execute(
      wager(wallet, {
        kind: 'ROLLBACK',
        referenceExternalTransactionId: 'd-bet',
      }),
    );
    const second = await h.submit.execute(
      wager(wallet, {
        kind: 'ROLLBACK',
        referenceExternalTransactionId: 'd-bet',
      }),
    );
    const refund = await h.submit.execute(
      wager(wallet, {
        kind: 'REFUND',
        referenceExternalTransactionId: 'd-bet',
      }),
    );
    expect(second.failureCode).toBe(FailureCode.AlreadyReversed);
    expect(refund.failureCode).toBe(FailureCode.AlreadyReversed);
    expect(balanceOf(h, wallet.id)).toBe('100.00');
  });

  it('rejects a reversal that would overdraw with its own failure code', async () => {
    const wallet = await openWallet(h, '0.00');
    await h.submit.execute(
      wager(wallet, {
        kind: 'WIN',
        money: brl('50.00'),
        externalTransactionId: 'o-win',
      }),
    );
    await h.submit.execute(wager(wallet, { money: brl('40.00') }));
    const rollback = await h.submit.execute(
      wager(wallet, {
        kind: 'ROLLBACK',
        money: brl('50.00'),
        referenceExternalTransactionId: 'o-win',
      }),
    );
    expect(rollback.status).toBe(WagerTransactionStatus.Rejected);
    expect(rollback.failureCode).toBe(FailureCode.ReversalWouldOverdraw);
    expect(balanceOf(h, wallet.id)).toBe('10.00');
  });
});

describe('balance limit', () => {
  const MAX = '999999999999999999.99';

  it('credits a WIN up to the exact maximum balance', async () => {
    const wallet = await openWallet(h, '999999999999999899.99');
    const win = await h.submit.execute(
      wager(wallet, { kind: 'WIN', money: brl('100.00') }),
    );
    expect(win.status).toBe(WagerTransactionStatus.Processed);
    expect(balanceOf(h, wallet.id)).toBe(MAX);
  });

  it('rejects a WIN beyond the maximum balance as a stable business failure', async () => {
    const wallet = await openWallet(h, MAX);
    const outboxBefore = h.uow.tables.outbox.length;
    const command = wager(wallet, { kind: 'WIN', money: brl('0.01') });

    const win = await h.submit.execute(command);

    expect(win.status).toBe(WagerTransactionStatus.Rejected);
    expect(win.failureCode).toBe(FailureCode.BalanceLimitExceeded);
    expect(win.balance?.toJSON()).toEqual(brl(MAX));
    expect(balanceOf(h, wallet.id)).toBe(MAX);
    expect(versionOf(h, wallet.id)).toBe(1);
    expect(ledgerOf(h, wallet.id)).toHaveLength(1);
    expect(h.uow.tables.outbox).toHaveLength(outboxBefore + 1);
    expect(eventsFor(h, win.transactionId)).toEqual([
      'WagerTransactionRejected',
    ]);
    expect(transactionRecord(h, win.transactionId)).toMatchObject({
      status: 'REJECTED',
      failureCode: 'BALANCE_LIMIT_EXCEEDED',
      resultBalance: MAX,
      processedAt: null,
    });

    const replay = await h.submit.execute(command);
    expect(replay).toMatchObject({
      transactionId: win.transactionId,
      status: WagerTransactionStatus.Rejected,
      failureCode: FailureCode.BalanceLimitExceeded,
      idempotentReplay: true,
    });
    expect(h.uow.tables.outbox).toHaveLength(outboxBefore + 1);
  });

  it('rejects a reversal credit beyond the maximum balance without consuming the reference', async () => {
    const wallet = await openWallet(h, MAX);
    await h.submit.execute(wager(wallet, { externalTransactionId: 'cap-bet' }));
    await h.submit.execute(wager(wallet, { kind: 'WIN', money: brl('25.00') }));
    const rollback = await h.submit.execute(
      wager(wallet, {
        kind: 'ROLLBACK',
        referenceExternalTransactionId: 'cap-bet',
      }),
    );
    expect(rollback.status).toBe(WagerTransactionStatus.Rejected);
    expect(rollback.failureCode).toBe(FailureCode.BalanceLimitExceeded);
    expect(balanceOf(h, wallet.id)).toBe(MAX);
    expect(versionOf(h, wallet.id)).toBe(3);

    await h.submit.execute(wager(wallet, { money: brl('25.00') }));
    const retry = await h.submit.execute(
      wager(wallet, {
        kind: 'ROLLBACK',
        referenceExternalTransactionId: 'cap-bet',
      }),
    );
    expect(retry.status).toBe(WagerTransactionStatus.Processed);
    expect(balanceOf(h, wallet.id)).toBe(MAX);
  });
});

describe('pending references', () => {
  it('parks a reversal whose reference has not arrived without moving money', async () => {
    const wallet = await openWallet(h);
    const pending = await h.submit.execute(
      wager(wallet, {
        kind: 'REFUND',
        referenceExternalTransactionId: 'late-bet',
      }),
    );
    expect(pending.status).toBe(WagerTransactionStatus.PendingReference);
    expect(balanceOf(h, wallet.id)).toBe('100.00');
    expect(ledgerOf(h, wallet.id)).toHaveLength(1);
    expect(transactionRecord(h, pending.transactionId)).toMatchObject({
      status: 'PENDING_REFERENCE',
      referenceAttempts: 0,
      nextReferenceAttemptAt: new Date('2026-10-31T12:00:01.000Z'),
    });
    expect(eventsFor(h, pending.transactionId)).toEqual([
      'WagerTransactionPendingReference',
    ]);

    const again = await h.submit.execute(
      wager(wallet, {
        kind: 'REFUND',
        externalTransactionId: transactionRecord(h, pending.transactionId)
          ?.externalTransactionId,
        referenceExternalTransactionId: 'late-bet',
      }),
    );
    expect(again).toMatchObject({
      transactionId: pending.transactionId,
      status: WagerTransactionStatus.PendingReference,
      idempotentReplay: true,
    });
    expect(h.uow.tables.transactions).toHaveLength(2);
  });

  it('lets a later settlement resolve the parked transaction through the same rules', async () => {
    const wallet = await openWallet(h);
    const refund = await h.submit.execute(
      wager(wallet, {
        kind: 'REFUND',
        referenceExternalTransactionId: 'later',
      }),
    );
    await h.submit.execute(wager(wallet, { externalTransactionId: 'later' }));
    expect(balanceOf(h, wallet.id)).toBe('75.00');

    const resolved = await h.uow.runWithWalletLock(
      wallet.id,
      async ({ wallet: locked, repositories }) => {
        const stored = await repositories.transactions.findById(
          refund.transactionId,
        );
        if (locked === undefined || stored === undefined) {
          throw new Error('missing state');
        }
        return h.settlement.settle(repositories, locked, stored, {
          now: h.clock.now(),
          correlationId: 'worker',
        });
      },
    );
    expect(resolved.transaction.status).toBe(WagerTransactionStatus.Processed);
    expect(balanceOf(h, wallet.id)).toBe('100.00');
  });

  it('keeps a parked transaction untouched while the reference is still missing', async () => {
    const wallet = await openWallet(h);
    const refund = await h.submit.execute(
      wager(wallet, {
        kind: 'ROLLBACK',
        referenceExternalTransactionId: 'never',
      }),
    );
    const commits = h.uow.tables.outbox.length;
    const result = await h.uow.runWithWalletLock(
      wallet.id,
      async ({ wallet: locked, repositories }) => {
        const stored = await repositories.transactions.findById(
          refund.transactionId,
        );
        if (locked === undefined || stored === undefined) {
          throw new Error('missing state');
        }
        return h.settlement.settle(repositories, locked, stored, {
          now: h.clock.now(),
          correlationId: 'worker',
        });
      },
    );
    expect(result.transaction.status).toBe(
      WagerTransactionStatus.PendingReference,
    );
    expect(h.uow.tables.outbox).toHaveLength(commits);
  });

  it('waits while the reference exists but is itself pending', async () => {
    const wallet = await openWallet(h);
    await h.submit.execute(
      wager(wallet, {
        kind: 'REFUND',
        externalTransactionId: 'chain-refund',
        referenceExternalTransactionId: 'chain-bet',
      }),
    );
    const rollback = await h.submit.execute(
      wager(wallet, {
        kind: 'ROLLBACK',
        referenceExternalTransactionId: 'chain-refund',
      }),
    );
    expect(rollback.status).toBe(WagerTransactionStatus.PendingReference);
  });
});

describe('idempotency', () => {
  it('replays the original success without new ledger, events or balance change', async () => {
    const wallet = await openWallet(h);
    const command = wager(wallet);
    const first = await h.submit.execute(command);
    await h.submit.execute(wager(wallet, { money: brl('5.00') }));
    const snapshot = {
      ledger: h.uow.tables.ledger.length,
      outbox: h.uow.tables.outbox.length,
      transactions: h.uow.tables.transactions.length,
    };

    const replay = await h.submit.execute({
      ...command,
      correlationId: 'other',
    });
    expect(replay).toEqual({ ...first, idempotentReplay: true });
    expect(replay.balance?.toJSON()).toEqual(brl('75.00'));
    expect(balanceOf(h, wallet.id)).toBe('70.00');
    expect({
      ledger: h.uow.tables.ledger.length,
      outbox: h.uow.tables.outbox.length,
      transactions: h.uow.tables.transactions.length,
    }).toEqual(snapshot);
  });

  it('replays the original rejection with its failure code and observed balance', async () => {
    const wallet = await openWallet(h, '10.00');
    const command = wager(wallet);
    const first = await h.submit.execute(command);
    await h.submit.execute(
      wager(wallet, { kind: 'WIN', money: brl('100.00') }),
    );

    const replay = await h.submit.execute(command);
    expect(replay.status).toBe(WagerTransactionStatus.Rejected);
    expect(replay.failureCode).toBe(FailureCode.InsufficientFunds);
    expect(replay.balance?.toJSON()).toEqual(brl('10.00'));
    expect(replay.transactionId).toBe(first.transactionId);
    expect(replay.idempotentReplay).toBe(true);
  });

  it('treats the same key with another payload as a conflict', async () => {
    const wallet = await openWallet(h);
    const command = wager(wallet);
    await h.submit.execute(command);
    const error = await expectRejection(
      h.submit.execute({ ...command, money: brl('26.00') }),
      IdempotencyConflictError,
    );
    expect(error.message).toContain('different payload');
    expect(balanceOf(h, wallet.id)).toBe('75.00');
  });

  it('treats a repeated externalTransactionId under another key as a conflict', async () => {
    const wallet = await openWallet(h);
    const command = wager(wallet);
    await h.submit.execute(command);
    await expectRejection(
      h.submit.execute({ ...command, idempotencyKey: 'another-key' }),
      IdempotencyConflictError,
    );
    expect(h.uow.tables.transactions).toHaveLength(2);
    expect(balanceOf(h, wallet.id)).toBe('75.00');
  });

  it('ignores transport metadata in the payload hash', async () => {
    const wallet = await openWallet(h);
    const command = wager(wallet);
    await h.submit.execute(command);
    const replay = await h.submit.execute({
      ...command,
      correlationId: 'different',
      causationId: 'message-9',
    });
    expect(replay.idempotentReplay).toBe(true);
  });
});

describe('wallet checks', () => {
  it('persists an auditable rejection for an unknown wallet', async () => {
    const wallet = await openWallet(h);
    const result = await h.submit.execute(
      wager(wallet, { walletId: '00000000-0000-7000-8000-999999999999' }),
    );
    expect(result.status).toBe(WagerTransactionStatus.Rejected);
    expect(result.failureCode).toBe(FailureCode.WalletNotFound);
    expect(result.balance).toBeUndefined();
    expect(eventsFor(h, result.transactionId)).toEqual([
      'WagerTransactionRejected',
    ]);
  });

  it('rejects a wallet owned by another player without revealing its balance', async () => {
    const wallet = await openWallet(h);
    const result = await h.submit.execute(
      wager(wallet, { playerId: 'intruder' }),
    );
    expect(result.failureCode).toBe(FailureCode.WalletPlayerMismatch);
    expect(result.balance).toBeUndefined();
    expect(balanceOf(h, wallet.id)).toBe('100.00');
  });

  it('rejects a currency that differs from the wallet currency', async () => {
    const wallet = await openWallet(h);
    const result = await h.submit.execute(
      wager(wallet, { money: { amount: '25.00', currency: 'USD' } }),
    );
    expect(result.failureCode).toBe(FailureCode.CurrencyMismatch);
    expect(balanceOf(h, wallet.id)).toBe('100.00');
  });
});

describe('input validation', () => {
  it.each([
    ['OPENING kind', { kind: WagerTransactionKind.Opening }],
    ['unknown kind', { kind: 'JACKPOT' }],
    ['negative amount', { money: brl('-1.00') }],
    ['three decimals', { money: brl('1.000') }],
    ['scientific notation', { money: brl('1e3') }],
    ['zero BET', { money: brl('0.00') }],
    ['REFUND without reference', { kind: 'REFUND' }],
    [
      'LOSS with reference',
      { kind: 'LOSS', referenceExternalTransactionId: 'b' },
    ],
    ['lowercase currency', { money: { amount: '1.00', currency: 'brl' } }],
  ])('rejects %s before touching storage', async (_label, overrides) => {
    const wallet = await openWallet(h);
    const commits = h.uow.commits;
    await expectRejection(
      h.submit.execute(wager(wallet, overrides)),
      InvalidRequestError,
    );
    expect(h.uow.commits).toBe(commits);
  });
});

describe('failures during persistence', () => {
  it.each(['ledger.append', 'outbox.enqueue', 'transactions.update'] as const)(
    'leaves no partial state when %s fails and processes once on retry',
    async (fault) => {
      const wallet = await openWallet(h);
      const command = wager(wallet);
      const before = structuredClone(h.uow.tables);

      h.uow.faults.add(fault);
      await expectRejection(h.submit.execute(command), InjectedFault);
      expect(h.uow.tables).toEqual(before);

      h.uow.faults.clear();
      const retry = await h.submit.execute(command);
      expect(retry.status).toBe(WagerTransactionStatus.Processed);
      expect(retry.idempotentReplay).toBe(false);
      expect(balanceOf(h, wallet.id)).toBe('75.00');
    },
  );
});

describe('ledger timing', () => {
  it('keeps ledger timestamps strictly increasing per wallet even if the clock stalls', async () => {
    const wallet = await openWallet(h);
    await h.submit.execute(wager(wallet, { money: brl('1.00') }));
    await h.submit.execute(wager(wallet, { money: brl('1.00') }));
    await h.submit.execute(wager(wallet, { money: brl('1.00') }));
    const times = ledgerOf(h, wallet.id).map((e) => e.createdAt.getTime());
    expect(new Set(times).size).toBe(times.length);
    expect([...times].sort((a, b) => a - b)).toEqual(times);
  });
});
