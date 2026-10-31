import { describe, expect, it } from 'bun:test';
import { Money } from '../../../src/domain/money/money.js';
import { LedgerDirection } from '../../../src/domain/ledger/ledger-direction.js';
import {
  FailureCode,
  WAGER_TRANSACTION_TRANSITIONS,
  WagerTransactionKind as Kind,
  WagerTransactionStatus as Status,
  isProviderSubmittableKind,
} from '../../../src/domain/wagering/wager-transaction.enums.js';
import {
  InvalidTransactionReferenceError,
  InvalidTransactionStateError,
  InvalidWagerTransactionError,
} from '../../../src/domain/wagering/wager-transaction.errors.js';
import {
  WagerTransaction,
  type CreateWagerTransactionProps,
  type ReferenceCheck,
  type WagerTransactionState,
} from '../../../src/domain/wagering/wager-transaction.js';

const brl = (amount: string): Money => Money.from({ amount, currency: 'BRL' });
const usd = (amount: string): Money => Money.from({ amount, currency: 'USD' });
const CREATED_AT = new Date('2026-10-31T12:00:00.000Z');
const PROCESSED_AT = new Date('2026-10-31T12:00:01.000Z');
const HASH = 'a'.repeat(64);

const props = (
  overrides: Partial<CreateWagerTransactionProps> = {},
): CreateWagerTransactionProps => ({
  id: 'tx-internal-1',
  providerId: 'provider-a',
  externalTransactionId: 'ext-1',
  idempotencyKey: 'provider-a:ext-1',
  payloadHash: HASH,
  walletId: 'wallet-1',
  playerId: 'player-1',
  roundId: 'round-1',
  gameId: 'fortune-chimp',
  kind: Kind.Bet,
  money: brl('25.00'),
  createdAt: CREATED_AT,
  ...overrides,
});

const create = (overrides: Partial<CreateWagerTransactionProps> = {}) =>
  WagerTransaction.create(props(overrides));

const referencing = (
  kind: Kind,
  overrides: Partial<CreateWagerTransactionProps> = {},
) =>
  create({
    id: 'tx-internal-2',
    externalTransactionId: 'ext-2',
    idempotencyKey: 'provider-a:ext-2',
    kind,
    referenceExternalTransactionId: 'ext-1',
    ...overrides,
  });

const processed = (overrides: Partial<CreateWagerTransactionProps> = {}) => {
  const transaction = create(overrides);
  transaction.markProcessed(undefined, PROCESSED_AT);
  return transaction;
};

const processedReferencing = (
  kind: Kind,
  reference: WagerTransaction,
  overrides: Partial<CreateWagerTransactionProps> = {},
) => {
  const transaction = create({
    referenceExternalTransactionId: reference.externalTransactionId,
    ...overrides,
    kind,
  });
  transaction.markProcessed(reference.id, PROCESSED_AT);
  return transaction;
};

const processedOfKind = (kind: Kind): WagerTransaction => {
  if (kind === Kind.Refund || kind === Kind.Rollback) {
    const transaction = create({
      kind,
      referenceExternalTransactionId: 'ext-0',
    });
    transaction.markProcessed('tx-internal-0', PROCESSED_AT);
    return transaction;
  }
  return processed({ kind });
};

const inStatus = (status: Status): WagerTransaction => {
  const transaction = referencing(Kind.Refund);
  switch (status) {
    case Status.Pending:
      break;
    case Status.PendingReference:
      transaction.markPendingReference();
      break;
    case Status.Processed:
      transaction.markProcessed('tx-internal-1', PROCESSED_AT);
      break;
    case Status.Rejected:
      transaction.reject(FailureCode.ReferenceNotFound);
      break;
    case Status.Failed:
      transaction.fail(FailureCode.ProcessingFailed);
      break;
  }
  return transaction;
};

const transitions: Record<Status, (tx: WagerTransaction) => void> = {
  [Status.Pending]: () => {
    throw new Error('no transition back to PENDING exists');
  },
  [Status.PendingReference]: (tx) => tx.markPendingReference(),
  [Status.Processed]: (tx) => tx.markProcessed('tx-internal-1', PROCESSED_AT),
  [Status.Rejected]: (tx) => tx.reject(FailureCode.ReferenceNotFound),
  [Status.Failed]: (tx) => tx.fail(FailureCode.ProcessingFailed),
};

const ALL_STATUSES = Object.values(Status);
const TARGETS = ALL_STATUSES.filter((status) => status !== Status.Pending);

describe('WagerTransaction', () => {
  describe('create', () => {
    it.each([
      [Kind.Opening, undefined],
      [Kind.Bet, undefined],
      [Kind.Win, undefined],
      [Kind.Win, 'ext-1'],
      [Kind.Loss, undefined],
      [Kind.Refund, 'ext-1'],
      [Kind.Rollback, 'ext-1'],
    ] as const)(
      'creates %s (reference %p) in PENDING with no outcome yet',
      (kind, reference) => {
        const transaction = create({
          kind,
          referenceExternalTransactionId: reference,
          externalTransactionId: 'ext-9',
        });

        expect(transaction.kind).toBe(kind);
        expect(transaction.status).toBe(Status.Pending);
        expect(transaction.isTerminal()).toBe(false);
        expect(transaction.referenceExternalTransactionId).toBe(reference);
        expect(transaction.referenceTransactionId).toBeUndefined();
        expect(transaction.failureCode).toBeUndefined();
        expect(transaction.processedAt).toBeUndefined();
        expect(transaction.createdAt).toEqual(CREATED_AT);
      },
    );

    it('exposes all identifiers and business fields', () => {
      const transaction = create();
      expect(transaction.id).toBe('tx-internal-1');
      expect(transaction.providerId).toBe('provider-a');
      expect(transaction.externalTransactionId).toBe('ext-1');
      expect(transaction.idempotencyKey).toBe('provider-a:ext-1');
      expect(transaction.payloadHash).toBe(HASH);
      expect(transaction.walletId).toBe('wallet-1');
      expect(transaction.playerId).toBe('player-1');
      expect(transaction.roundId).toBe('round-1');
      expect(transaction.gameId).toBe('fortune-chimp');
      expect(transaction.money.equals(brl('25.00'))).toBe(true);
    });

    it.each([[Kind.Refund], [Kind.Rollback]])(
      '%s requires referenceExternalTransactionId',
      (kind) => {
        expect(() => create({ kind })).toThrow(InvalidWagerTransactionError);
      },
    );

    it.each([[Kind.Bet], [Kind.Loss], [Kind.Opening]])(
      '%s does not accept a reference',
      (kind) => {
        expect(() =>
          create({ kind, referenceExternalTransactionId: 'ext-0' }),
        ).toThrow(InvalidWagerTransactionError);
      },
    );

    it('rejects a transaction that references itself', () => {
      expect(() =>
        create({ kind: Kind.Refund, referenceExternalTransactionId: 'ext-1' }),
      ).toThrow(InvalidWagerTransactionError);
    });

    it.each([
      [Kind.Opening],
      [Kind.Bet],
      [Kind.Win],
      [Kind.Refund],
      [Kind.Rollback],
    ])('%s with zero money is rejected', (kind) => {
      expect(() =>
        create({
          kind,
          money: brl('0.00'),
          referenceExternalTransactionId:
            kind === Kind.Refund || kind === Kind.Rollback
              ? 'ext-0'
              : undefined,
        }),
      ).toThrow(InvalidWagerTransactionError);
    });

    it('LOSS accepts zero money because it never moves balance', () => {
      expect(
        create({ kind: Kind.Loss, money: brl('0.00') }).money.isZero(),
      ).toBe(true);
    });

    it.each([[Kind.Bet], [Kind.Loss]])('%s rejects negative money', (kind) => {
      expect(() => create({ kind, money: brl('1.00').negate() })).toThrow(
        InvalidWagerTransactionError,
      );
    });

    it.each([
      ['id', ''],
      ['providerId', ' '],
      ['externalTransactionId', undefined],
      ['idempotencyKey', ''],
      ['payloadHash', ''],
      ['walletId', ''],
      ['playerId', 42],
      ['roundId', ''],
      ['gameId', ''],
      ['kind', 'JACKPOT'],
      ['kind', 'bet'],
      ['money', '25.00'],
      ['money', { amount: '25.00', currency: 'BRL' }],
      ['referenceExternalTransactionId', ''],
      ['createdAt', new Date('invalid')],
      ['createdAt', '2026-10-31'],
    ] as const)('rejects invalid %s %p', (field, value) => {
      expect(() => create({ [field]: value as any })).toThrow(
        InvalidWagerTransactionError,
      );
    });
  });

  describe('OPENING is internal', () => {
    it('can be created by the domain and credits the wallet', () => {
      const opening = create({ kind: Kind.Opening, money: brl('1000.00') });
      expect(opening.affectsBalance()).toBe(true);
      expect(opening.ledgerDirectionFor()).toBe(LedgerDirection.Credit);
      opening.markProcessed(undefined, PROCESSED_AT);
      expect(opening.status).toBe(Status.Processed);
    });

    it('is not submittable by providers', () => {
      expect(isProviderSubmittableKind(Kind.Opening)).toBe(false);
      expect(isProviderSubmittableKind('OPENING')).toBe(false);
    });

    it.each([
      [Kind.Bet],
      [Kind.Win],
      [Kind.Loss],
      [Kind.Refund],
      [Kind.Rollback],
    ])('%s is submittable by providers', (kind) => {
      expect(isProviderSubmittableKind(kind)).toBe(true);
    });

    it.each([['bet'], ['JACKPOT'], [''], [undefined], [1]])(
      'rejects unknown kind %p',
      (kind) => {
        expect(isProviderSubmittableKind(kind)).toBe(false);
      },
    );
  });

  describe('state machine', () => {
    it('declares exactly the documented transitions', () => {
      const table = Object.fromEntries(
        ALL_STATUSES.map((status) => [
          status,
          [...WAGER_TRANSACTION_TRANSITIONS[status]].map(String).sort(),
        ]),
      );
      expect(table).toEqual({
        PENDING: ['FAILED', 'PENDING_REFERENCE', 'PROCESSED', 'REJECTED'],
        PENDING_REFERENCE: ['FAILED', 'PROCESSED', 'REJECTED'],
        PROCESSED: [],
        REJECTED: [],
        FAILED: [],
      });
    });

    const cases = ALL_STATUSES.flatMap((from) =>
      TARGETS.map((to) => [from, to] as const),
    );

    it.each(cases)('%s -> %s follows the transition table', (from, to) => {
      const transaction = inStatus(from);
      const allowed = WAGER_TRANSACTION_TRANSITIONS[from].has(to);

      if (allowed) {
        transitions[to](transaction);
        expect(transaction.status).toBe(to);
      } else {
        const before = {
          status: transaction.status,
          failureCode: transaction.failureCode,
          processedAt: transaction.processedAt,
          referenceTransactionId: transaction.referenceTransactionId,
        };
        expect(() => transitions[to](transaction)).toThrow(
          InvalidTransactionStateError,
        );
        expect({
          status: transaction.status,
          failureCode: transaction.failureCode,
          processedAt: transaction.processedAt,
          referenceTransactionId: transaction.referenceTransactionId,
        }).toEqual(before);
      }
    });

    it.each([
      [Status.Pending, false],
      [Status.PendingReference, false],
      [Status.Processed, true],
      [Status.Rejected, true],
      [Status.Failed, true],
    ] as const)('isTerminal() for %s is %p', (status, terminal) => {
      expect(inStatus(status).isTerminal()).toBe(terminal);
    });

    it('reports from/to on illegal transitions', () => {
      const transaction = inStatus(Status.Processed);
      try {
        transaction.reject(FailureCode.InsufficientFunds);
        throw new Error('expected reject to throw');
      } catch (error) {
        expect(error).toBeInstanceOf(InvalidTransactionStateError);
        const stateError = error as InvalidTransactionStateError;
        expect(stateError.code).toBe('WAGER_INVALID_STATE_TRANSITION');
        expect(stateError.from).toBe(Status.Processed);
        expect(stateError.to).toBe(Status.Rejected);
      }
    });
  });

  describe('markProcessed', () => {
    it('records processedAt and no reference for a plain BET', () => {
      const bet = create();
      bet.markProcessed(undefined, PROCESSED_AT);

      expect(bet.status).toBe(Status.Processed);
      expect(bet.processedAt).toEqual(PROCESSED_AT);
      expect(bet.referenceTransactionId).toBeUndefined();
      expect(bet.failureCode).toBeUndefined();
    });

    it('records the resolved internal reference id', () => {
      const refund = referencing(Kind.Refund);
      refund.markProcessed('tx-internal-1', PROCESSED_AT);
      expect(refund.referenceTransactionId).toBe('tx-internal-1');
    });

    it('processes from PENDING_REFERENCE once the reference arrives', () => {
      const rollback = referencing(Kind.Rollback);
      rollback.markPendingReference();
      rollback.markProcessed('tx-internal-1', PROCESSED_AT);
      expect(rollback.status).toBe(Status.Processed);
    });

    it.each([[undefined], ['']])(
      'requires the resolved reference id when a reference exists (%p)',
      (referenceId) => {
        const refund = referencing(Kind.Refund);
        expect(() => refund.markProcessed(referenceId, PROCESSED_AT)).toThrow(
          InvalidWagerTransactionError,
        );
        expect(refund.status).toBe(Status.Pending);
      },
    );

    it('rejects a reference id for a transaction without reference', () => {
      const bet = create();
      expect(() => bet.markProcessed('tx-x', PROCESSED_AT)).toThrow(
        InvalidWagerTransactionError,
      );
      expect(bet.status).toBe(Status.Pending);
    });

    it('rejects an invalid date without changing state', () => {
      const bet = create();
      expect(() => bet.markProcessed(undefined, new Date(NaN))).toThrow(
        InvalidWagerTransactionError,
      );
      expect(bet.status).toBe(Status.Pending);
      expect(bet.processedAt).toBeUndefined();
    });
  });

  describe('markPendingReference', () => {
    it.each([[Kind.Win], [Kind.Refund], [Kind.Rollback]])(
      '%s with reference can wait for it',
      (kind) => {
        const transaction = referencing(kind);
        transaction.markPendingReference();
        expect(transaction.status).toBe(Status.PendingReference);
        expect(transaction.isTerminal()).toBe(false);
      },
    );

    it.each([[Kind.Bet], [Kind.Win], [Kind.Loss], [Kind.Opening]])(
      '%s without reference cannot wait for one',
      (kind) => {
        const transaction = create({ kind });
        expect(() => transaction.markPendingReference()).toThrow(
          InvalidWagerTransactionError,
        );
        expect(transaction.status).toBe(Status.Pending);
      },
    );

    it('cannot be re-entered while already waiting', () => {
      const transaction = inStatus(Status.PendingReference);
      expect(() => transaction.markPendingReference()).toThrow(
        InvalidTransactionStateError,
      );
    });
  });

  describe('failure codes', () => {
    it('reject() stores the failure code and keeps it after further attempts', () => {
      const bet = create();
      bet.reject(FailureCode.InsufficientFunds);

      expect(bet.status).toBe(Status.Rejected);
      expect(bet.failureCode).toBe(FailureCode.InsufficientFunds);
      expect(bet.processedAt).toBeUndefined();
      expect(() => bet.reject(FailureCode.WalletNotFound)).toThrow(
        InvalidTransactionStateError,
      );
      expect(() => bet.fail(FailureCode.ProcessingFailed)).toThrow(
        InvalidTransactionStateError,
      );
      expect(bet.failureCode).toBe(FailureCode.InsufficientFunds);
    });

    it('fail() stores the failure code as FAILED', () => {
      const bet = create();
      bet.fail(FailureCode.ProcessingFailed);
      expect(bet.status).toBe(Status.Failed);
      expect(bet.failureCode).toBe(FailureCode.ProcessingFailed);
    });

    it('PENDING_REFERENCE expires to REJECTED with REFERENCE_NOT_FOUND', () => {
      const refund = inStatus(Status.PendingReference);
      refund.reject(FailureCode.ReferenceNotFound);
      expect(refund.status).toBe(Status.Rejected);
      expect(refund.failureCode).toBe(FailureCode.ReferenceNotFound);
    });

    it.each([['NOPE'], [''], [undefined]])(
      'rejects unknown failure code %p without changing state',
      (code) => {
        const bet = create();
        expect(() => bet.reject(code as any)).toThrow(
          InvalidWagerTransactionError,
        );
        expect(() => bet.fail(code as any)).toThrow(
          InvalidWagerTransactionError,
        );
        expect(bet.status).toBe(Status.Pending);
        expect(bet.failureCode).toBeUndefined();
      },
    );

    it('distinguishes insufficient funds on BET from overdraw on reversal', () => {
      expect(create().insufficientFundsFailureCode()).toBe(
        FailureCode.InsufficientFunds,
      );
      expect(referencing(Kind.Rollback).insufficientFundsFailureCode()).toBe(
        FailureCode.ReversalWouldOverdraw,
      );
      expect(FailureCode.InsufficientFunds).not.toBe(
        FailureCode.ReversalWouldOverdraw,
      );
    });

    it.each([[Kind.Opening], [Kind.Win], [Kind.Loss], [Kind.Refund]])(
      '%s never debits, so it has no insufficient funds code',
      (kind) => {
        const transaction =
          kind === Kind.Refund ? referencing(kind) : create({ kind });
        expect(() => transaction.insufficientFundsFailureCode()).toThrow(
          InvalidWagerTransactionError,
        );
      },
    );

    it('uses stable machine-readable codes', () => {
      expect((Object.values(FailureCode) as string[]).sort()).toEqual([
        'ALREADY_REVERSED',
        'CURRENCY_MISMATCH',
        'INSUFFICIENT_FUNDS',
        'INVALID_REFERENCE_KIND',
        'PROCESSING_FAILED',
        'REFERENCE_MISMATCH',
        'REFERENCE_NOT_FOUND',
        'REFERENCE_NOT_PROCESSED',
        'REVERSAL_AMOUNT_MISMATCH',
        'REVERSAL_WOULD_OVERDRAW',
        'WALLET_NOT_FOUND',
        'WALLET_PLAYER_MISMATCH',
      ]);
    });
  });

  describe('balance effect and ledger direction', () => {
    it('LOSS has no financial effect and no ledger direction', () => {
      const loss = create({ kind: Kind.Loss });
      expect(loss.affectsBalance()).toBe(false);
      expect(() => loss.ledgerDirectionFor()).toThrow(
        InvalidWagerTransactionError,
      );
      loss.markProcessed(undefined, PROCESSED_AT);
      expect(loss.status).toBe(Status.Processed);
    });

    it.each([
      [Kind.Bet, LedgerDirection.Debit],
      [Kind.Win, LedgerDirection.Credit],
      [Kind.Opening, LedgerDirection.Credit],
    ] as const)('%s moves balance as %s', (kind, direction) => {
      const transaction = create({ kind });
      expect(transaction.affectsBalance()).toBe(true);
      expect(transaction.ledgerDirectionFor()).toBe(direction);
    });

    it('REFUND credits the wallet', () => {
      const refund = referencing(Kind.Refund);
      expect(refund.affectsBalance()).toBe(true);
      expect(refund.ledgerDirectionFor()).toBe(LedgerDirection.Credit);
    });

    it.each([
      [Kind.Bet, LedgerDirection.Credit],
      [Kind.Win, LedgerDirection.Debit],
      [Kind.Refund, LedgerDirection.Debit],
    ] as const)(
      'ROLLBACK of %s moves balance as %s',
      (referenceKind, direction) => {
        const reference =
          referenceKind === Kind.Refund
            ? processedReferencing(Kind.Refund, processed(), {
                id: 'tx-internal-0',
                externalTransactionId: 'ext-refund',
              })
            : processed({ kind: referenceKind });
        const rollback = referencing(Kind.Rollback, {
          externalTransactionId: 'ext-rollback',
          referenceExternalTransactionId: reference.externalTransactionId,
        });

        expect(rollback.ledgerDirectionFor(reference)).toBe(direction);
      },
    );

    it('ROLLBACK direction requires the referenced transaction', () => {
      expect(() => referencing(Kind.Rollback).ledgerDirectionFor()).toThrow(
        InvalidWagerTransactionError,
      );
    });

    it.each([[Kind.Loss], [Kind.Opening]])(
      'ROLLBACK of %s is an invalid reference',
      (referenceKind) => {
        const reference = processedOfKind(referenceKind);
        const rollback = referencing(Kind.Rollback);
        try {
          rollback.ledgerDirectionFor(reference);
          throw new Error('expected ledgerDirectionFor to throw');
        } catch (error) {
          expect(error).toBeInstanceOf(InvalidTransactionReferenceError);
          expect((error as InvalidTransactionReferenceError).failureCode).toBe(
            FailureCode.InvalidReferenceKind,
          );
        }
      },
    );

    it('ROLLBACK of a reference that is not PROCESSED is invalid', () => {
      const rollback = referencing(Kind.Rollback);
      expect(() => rollback.ledgerDirectionFor(create())).toThrow(
        InvalidTransactionReferenceError,
      );
    });
  });

  describe('validateReference', () => {
    const VALID: ReferenceCheck = { outcome: 'VALID' };
    const WAIT: ReferenceCheck = { outcome: 'WAIT' };
    const rejected = (failureCode: FailureCode): ReferenceCheck => ({
      outcome: 'REJECT',
      failureCode,
    });

    it.each([
      [Kind.Refund, Kind.Bet],
      [Kind.Rollback, Kind.Bet],
      [Kind.Win, Kind.Bet],
    ] as const)(
      '%s accepts a processed %s of the same scope',
      (kind, refKind) => {
        const reference = processed({ kind: refKind });
        const money = kind === Kind.Win ? brl('80.00') : brl('25.00');
        expect(
          referencing(kind, { money }).validateReference(reference),
        ).toEqual(VALID);
      },
    );

    it('ROLLBACK may reference a processed REFUND', () => {
      const refund = processedReferencing(Kind.Refund, processed(), {
        id: 'tx-internal-0',
        externalTransactionId: 'ext-refund',
      });
      const rollback = referencing(Kind.Rollback, {
        externalTransactionId: 'ext-rollback',
        referenceExternalTransactionId: 'ext-refund',
      });
      expect(rollback.validateReference(refund)).toEqual(VALID);
    });

    it('asks to wait when the reference does not exist yet', () => {
      expect(referencing(Kind.Refund).validateReference(undefined)).toEqual(
        WAIT,
      );
    });

    it('asks to wait while the reference is PENDING', () => {
      expect(referencing(Kind.Refund).validateReference(create())).toEqual(
        WAIT,
      );
    });

    it('asks to wait while the reference is PENDING_REFERENCE', () => {
      const win = create({
        kind: Kind.Win,
        referenceExternalTransactionId: 'ext-0',
      });
      win.markPendingReference();
      expect(referencing(Kind.Rollback).validateReference(win)).toEqual(WAIT);
    });

    it.each([[Status.Rejected], [Status.Failed]] as const)(
      'rejects a reference that ended %s',
      (status) => {
        const reference = create();
        if (status === Status.Rejected) {
          reference.reject(FailureCode.InsufficientFunds);
        } else {
          reference.fail(FailureCode.ProcessingFailed);
        }
        expect(referencing(Kind.Refund).validateReference(reference)).toEqual(
          rejected(FailureCode.ReferenceNotProcessed),
        );
      },
    );

    it.each([
      ['providerId', { providerId: 'provider-b' }],
      ['playerId', { playerId: 'player-2' }],
      ['walletId', { walletId: 'wallet-2' }],
      ['roundId', { roundId: 'round-2' }],
      ['currency', { money: usd('25.00') }],
    ] as const)(
      'rejects a reference with different %s',
      (_field, overrides) => {
        const reference = processed(overrides);
        expect(referencing(Kind.Refund).validateReference(reference)).toEqual(
          rejected(FailureCode.ReferenceMismatch),
        );
      },
    );

    it.each([
      [Kind.Refund, Kind.Win],
      [Kind.Refund, Kind.Refund],
      [Kind.Refund, Kind.Loss],
      [Kind.Refund, Kind.Opening],
      [Kind.Rollback, Kind.Loss],
      [Kind.Rollback, Kind.Opening],
      [Kind.Rollback, Kind.Rollback],
      [Kind.Win, Kind.Win],
      [Kind.Win, Kind.Refund],
    ] as const)('%s rejects a reference of kind %s', (kind, refKind) => {
      const reference = processedOfKind(refKind);
      expect(referencing(kind).validateReference(reference)).toEqual(
        rejected(FailureCode.InvalidReferenceKind),
      );
    });

    it.each([[Kind.Refund], [Kind.Rollback]])(
      '%s requires the same amount as the reference',
      (kind) => {
        expect(
          referencing(kind, { money: brl('24.99') }).validateReference(
            processed(),
          ),
        ).toEqual(rejected(FailureCode.ReversalAmountMismatch));
      },
    );

    it('WIN does not need to match the BET amount', () => {
      expect(
        referencing(Kind.Win, { money: brl('500.00') }).validateReference(
          processed(),
        ),
      ).toEqual(VALID);
    });

    it.each([
      [
        'different player',
        { playerId: 'player-2' },
        FailureCode.ReferenceMismatch,
      ],
      [
        'different amount',
        { money: brl('1.00') },
        FailureCode.ReversalAmountMismatch,
      ],
    ] as const)(
      'rejects a still pending reference with %s instead of waiting',
      (_label, overrides, failureCode) => {
        const pendingBet = create(overrides);
        expect(referencing(Kind.Refund).validateReference(pendingBet)).toEqual(
          rejected(failureCode),
        );
      },
    );

    it('does not change either transaction', () => {
      const reference = processed();
      const refund = referencing(Kind.Refund, { money: brl('1.00') });
      refund.validateReference(reference);

      expect(refund.status).toBe(Status.Pending);
      expect(refund.failureCode).toBeUndefined();
      expect(reference.status).toBe(Status.Processed);
    });

    it('throws when given an object that is not the requested reference', () => {
      expect(() =>
        referencing(Kind.Refund).validateReference(
          processed({ externalTransactionId: 'ext-x' }),
        ),
      ).toThrow(InvalidWagerTransactionError);
    });

    it.each([[Kind.Bet], [Kind.Win], [Kind.Loss], [Kind.Opening]])(
      'throws for %s without reference',
      (kind) => {
        expect(() => create({ kind }).validateReference(processed())).toThrow(
          InvalidWagerTransactionError,
        );
      },
    );
  });

  describe('matchesPayload', () => {
    it('matches the same hash and nothing else', () => {
      const bet = create();
      expect(bet.matchesPayload(HASH)).toBe(true);
      expect(bet.matchesPayload('b'.repeat(64))).toBe(false);
      expect(bet.matchesPayload(HASH.toUpperCase())).toBe(false);
      expect(bet.matchesPayload('')).toBe(false);
    });
  });

  describe('rehydrate', () => {
    const state = (
      overrides: Partial<WagerTransactionState> = {},
    ): WagerTransactionState => ({
      ...props({ kind: Kind.Refund, referenceExternalTransactionId: 'ext-0' }),
      status: Status.Processed,
      referenceTransactionId: 'tx-internal-0',
      processedAt: PROCESSED_AT,
      ...overrides,
    });

    it('rebuilds a PROCESSED transaction', () => {
      const transaction = WagerTransaction.rehydrate(state());
      expect(transaction.status).toBe(Status.Processed);
      expect(transaction.referenceTransactionId).toBe('tx-internal-0');
      expect(transaction.processedAt).toEqual(PROCESSED_AT);
      expect(transaction.isTerminal()).toBe(true);
      expect(() => transaction.fail(FailureCode.ProcessingFailed)).toThrow(
        InvalidTransactionStateError,
      );
    });

    it('rebuilds a REJECTED transaction with its failure code', () => {
      const transaction = WagerTransaction.rehydrate(
        state({
          status: Status.Rejected,
          failureCode: FailureCode.ReferenceNotFound,
          referenceTransactionId: undefined,
          processedAt: undefined,
        }),
      );
      expect(transaction.failureCode).toBe(FailureCode.ReferenceNotFound);
    });

    it('rebuilds PENDING_REFERENCE and lets it continue', () => {
      const transaction = WagerTransaction.rehydrate(
        state({
          status: Status.PendingReference,
          referenceTransactionId: undefined,
          processedAt: undefined,
        }),
      );
      transaction.markProcessed('tx-internal-0', PROCESSED_AT);
      expect(transaction.status).toBe(Status.Processed);
    });

    it('does not re-run creation rules', () => {
      const transaction = WagerTransaction.rehydrate(
        state({ kind: Kind.Bet, money: brl('0.00') }),
      );
      expect(transaction.money.isZero()).toBe(true);
    });

    it.each([
      ['unknown status', { status: 'DONE' as any }],
      [
        'unknown failure code',
        {
          status: Status.Rejected,
          failureCode: 'X' as any,
          processedAt: undefined,
        },
      ],
      ['PROCESSED without processedAt', { processedAt: undefined }],
      ['PENDING with processedAt', { status: Status.Pending }],
      [
        'REJECTED without failureCode',
        { status: Status.Rejected, processedAt: undefined },
      ],
      [
        'FAILED without failureCode',
        { status: Status.Failed, processedAt: undefined },
      ],
      [
        'PROCESSED with failureCode',
        { failureCode: FailureCode.ProcessingFailed },
      ],
      ['invalid processedAt', { processedAt: new Date(NaN) }],
      ['empty referenceTransactionId', { referenceTransactionId: '' }],
      ['empty id', { id: '' }],
      ['unknown kind', { kind: 'JACKPOT' as any }],
    ] as const)(
      'rejects structurally invalid state: %s',
      (_label, overrides) => {
        expect(() => WagerTransaction.rehydrate(state(overrides))).toThrow(
          InvalidWagerTransactionError,
        );
      },
    );
  });

  describe('immutability', () => {
    it.each([
      ['id'],
      ['providerId'],
      ['externalTransactionId'],
      ['idempotencyKey'],
      ['payloadHash'],
      ['walletId'],
      ['playerId'],
      ['roundId'],
      ['gameId'],
      ['kind'],
      ['money'],
      ['referenceExternalTransactionId'],
      ['status'],
      ['referenceTransactionId'],
      ['failureCode'],
      ['processedAt'],
      ['createdAt'],
    ] as const)('rejects direct assignment to %s', (field) => {
      const transaction = create();
      expect(() => {
        (transaction as any)[field] = 'tampered';
      }).toThrow(TypeError);
      expect(transaction.status).toBe(Status.Pending);
      expect(transaction.id).toBe('tx-internal-1');
    });

    it('is frozen against new properties', () => {
      const transaction = create();
      expect(Object.isFrozen(transaction)).toBe(true);
      expect(() => {
        (transaction as any).extra = true;
      }).toThrow(TypeError);
    });

    it('protects createdAt and processedAt from external mutation', () => {
      const createdAt = new Date(CREATED_AT.getTime());
      const at = new Date(PROCESSED_AT.getTime());
      const transaction = create({ createdAt });
      transaction.markProcessed(undefined, at);

      createdAt.setFullYear(2000);
      at.setFullYear(2000);
      transaction.createdAt.setFullYear(2000);
      transaction.processedAt?.setFullYear(2000);

      expect(transaction.createdAt).toEqual(CREATED_AT);
      expect(transaction.processedAt).toEqual(PROCESSED_AT);
    });

    it('protects rehydrated dates from external mutation', () => {
      const persisted: WagerTransactionState = {
        ...props({ createdAt: new Date(CREATED_AT.getTime()) }),
        status: Status.Processed,
        processedAt: new Date(PROCESSED_AT.getTime()),
      };
      const transaction = WagerTransaction.rehydrate(persisted);
      persisted.createdAt.setFullYear(2000);
      persisted.processedAt?.setFullYear(2000);

      expect(transaction.createdAt).toEqual(CREATED_AT);
      expect(transaction.processedAt).toEqual(PROCESSED_AT);
    });

    it('does not expose internal state helpers', () => {
      const transaction = create() as any;
      expect(transaction.finishWithFailure).toBeUndefined();
      expect(transaction.assertCanTransitionTo).toBeUndefined();
      expect(Object.keys(transaction)).not.toContain('status');
    });
  });
});
