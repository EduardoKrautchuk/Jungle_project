import { Money } from '../money/money.js';
import { LedgerDirection } from '../ledger/ledger-direction.js';
import {
  FailureCode,
  WAGER_TRANSACTION_TRANSITIONS,
  WagerTransactionKind,
  WagerTransactionStatus,
  isEnumValue,
} from './wager-transaction.enums.js';
import {
  InvalidTransactionReferenceError,
  InvalidTransactionStateError,
  InvalidWagerTransactionError,
} from './wager-transaction.errors.js';

export interface CreateWagerTransactionProps {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: Money;
  referenceExternalTransactionId?: string;
  createdAt: Date;
}

export interface WagerTransactionState extends CreateWagerTransactionProps {
  status: WagerTransactionStatus;
  referenceTransactionId?: string;
  failureCode?: FailureCode;
  processedAt?: Date;
}

const REFERENCE_KINDS: Readonly<
  Partial<Record<WagerTransactionKind, ReadonlySet<WagerTransactionKind>>>
> = {
  [WagerTransactionKind.Win]: new Set([WagerTransactionKind.Bet]),
  [WagerTransactionKind.Refund]: new Set([WagerTransactionKind.Bet]),
  [WagerTransactionKind.Rollback]: new Set([
    WagerTransactionKind.Bet,
    WagerTransactionKind.Win,
    WagerTransactionKind.Refund,
  ]),
};

export type ReferenceCheck =
  | { readonly outcome: 'VALID' }
  | { readonly outcome: 'WAIT' }
  | { readonly outcome: 'REJECT'; readonly failureCode: FailureCode };

const VALID: ReferenceCheck = Object.freeze({ outcome: 'VALID' });
const WAIT: ReferenceCheck = Object.freeze({ outcome: 'WAIT' });
const reject = (failureCode: FailureCode): ReferenceCheck =>
  Object.freeze({ outcome: 'REJECT', failureCode });

const TERMINAL_STATUSES: ReadonlySet<WagerTransactionStatus> = new Set([
  WagerTransactionStatus.Processed,
  WagerTransactionStatus.Rejected,
  WagerTransactionStatus.Failed,
]);

export class WagerTransaction {
  readonly id: string;
  readonly providerId: string;
  readonly externalTransactionId: string;
  readonly idempotencyKey: string;
  readonly payloadHash: string;
  readonly walletId: string;
  readonly playerId: string;
  readonly roundId: string;
  readonly gameId: string;
  readonly kind: WagerTransactionKind;
  readonly money: Money;
  readonly referenceExternalTransactionId: string | undefined;
  readonly #createdAtMs: number;
  #status: WagerTransactionStatus;
  #referenceTransactionId: string | undefined;
  #failureCode: FailureCode | undefined;
  #processedAtMs: number | undefined;

  private constructor(state: WagerTransactionState) {
    this.id = state.id;
    this.providerId = state.providerId;
    this.externalTransactionId = state.externalTransactionId;
    this.idempotencyKey = state.idempotencyKey;
    this.payloadHash = state.payloadHash;
    this.walletId = state.walletId;
    this.playerId = state.playerId;
    this.roundId = state.roundId;
    this.gameId = state.gameId;
    this.kind = state.kind;
    this.money = state.money;
    this.referenceExternalTransactionId = state.referenceExternalTransactionId;
    this.#createdAtMs = state.createdAt.getTime();
    this.#status = state.status;
    this.#referenceTransactionId = state.referenceTransactionId;
    this.#failureCode = state.failureCode;
    this.#processedAtMs = state.processedAt?.getTime();
    Object.freeze(this);
  }

  static create(props: CreateWagerTransactionProps): WagerTransaction {
    WagerTransaction.assertStructure(props);

    const reference = props.referenceExternalTransactionId;
    const referenceKinds = REFERENCE_KINDS[props.kind];
    if (referenceKinds === undefined && reference !== undefined) {
      throw new InvalidWagerTransactionError(
        `${props.kind} does not accept a reference`,
      );
    }
    if (kindRequiresReference(props.kind) && reference === undefined) {
      throw new InvalidWagerTransactionError(
        `${props.kind} requires referenceExternalTransactionId`,
      );
    }
    if (reference === props.externalTransactionId) {
      throw new InvalidWagerTransactionError(
        'a transaction cannot reference itself',
      );
    }
    if (props.money.isNegative()) {
      throw new InvalidWagerTransactionError('money must not be negative');
    }
    if (props.kind !== WagerTransactionKind.Loss && props.money.isZero()) {
      throw new InvalidWagerTransactionError(
        `${props.kind} money must be positive`,
      );
    }

    return new WagerTransaction({
      ...props,
      status: WagerTransactionStatus.Pending,
    });
  }

  static rehydrate(state: WagerTransactionState): WagerTransaction {
    WagerTransaction.assertStructure(state);
    if (!isEnumValue(WagerTransactionStatus, state.status)) {
      throw new InvalidWagerTransactionError('status is invalid');
    }
    if (
      state.failureCode !== undefined &&
      !isEnumValue(FailureCode, state.failureCode)
    ) {
      throw new InvalidWagerTransactionError('failureCode is invalid');
    }
    if (state.referenceTransactionId !== undefined) {
      assertNonEmptyString(
        state.referenceTransactionId,
        'referenceTransactionId',
      );
    }
    if (state.processedAt !== undefined) {
      assertValidDate(state.processedAt, 'processedAt');
    }

    const processed = state.status === WagerTransactionStatus.Processed;
    const failed =
      state.status === WagerTransactionStatus.Rejected ||
      state.status === WagerTransactionStatus.Failed;
    if (processed !== (state.processedAt !== undefined)) {
      throw new InvalidWagerTransactionError(
        'processedAt must be set only for PROCESSED transactions',
      );
    }
    if (failed !== (state.failureCode !== undefined)) {
      throw new InvalidWagerTransactionError(
        'failureCode must be set only for REJECTED or FAILED transactions',
      );
    }
    return new WagerTransaction(state);
  }

  get createdAt(): Date {
    return new Date(this.#createdAtMs);
  }

  get status(): WagerTransactionStatus {
    return this.#status;
  }

  get referenceTransactionId(): string | undefined {
    return this.#referenceTransactionId;
  }

  get failureCode(): FailureCode | undefined {
    return this.#failureCode;
  }

  get processedAt(): Date | undefined {
    return this.#processedAtMs === undefined
      ? undefined
      : new Date(this.#processedAtMs);
  }

  markProcessed(referenceTransactionId: string | undefined, at: Date): void {
    this.#assertCanTransitionTo(WagerTransactionStatus.Processed);
    if (this.referenceExternalTransactionId === undefined) {
      if (referenceTransactionId !== undefined) {
        throw new InvalidWagerTransactionError(
          'referenceTransactionId given for a transaction without reference',
        );
      }
    } else {
      assertNonEmptyString(referenceTransactionId, 'referenceTransactionId');
    }
    assertValidDate(at, 'at');

    this.#status = WagerTransactionStatus.Processed;
    this.#referenceTransactionId = referenceTransactionId;
    this.#processedAtMs = at.getTime();
  }

  markPendingReference(): void {
    this.#assertCanTransitionTo(WagerTransactionStatus.PendingReference);
    if (this.referenceExternalTransactionId === undefined) {
      throw new InvalidWagerTransactionError(
        'only transactions with a reference can wait for it',
      );
    }
    this.#status = WagerTransactionStatus.PendingReference;
  }

  reject(code: FailureCode): void {
    this.#finishWithFailure(WagerTransactionStatus.Rejected, code);
  }

  fail(code: FailureCode): void {
    this.#finishWithFailure(WagerTransactionStatus.Failed, code);
  }

  isTerminal(): boolean {
    return TERMINAL_STATUSES.has(this.#status);
  }

  affectsBalance(): boolean {
    return this.kind !== WagerTransactionKind.Loss;
  }

  requiresReference(): boolean {
    return kindRequiresReference(this.kind);
  }

  matchesPayload(payloadHash: string): boolean {
    return this.payloadHash === payloadHash;
  }

  validateReference(reference: WagerTransaction | undefined): ReferenceCheck {
    const allowedKinds = REFERENCE_KINDS[this.kind];
    if (
      allowedKinds === undefined ||
      this.referenceExternalTransactionId === undefined
    ) {
      throw new InvalidWagerTransactionError(
        `${this.kind} ${this.externalTransactionId} has no reference to validate`,
      );
    }
    if (reference === undefined) {
      return WAIT;
    }
    if (
      reference.externalTransactionId !== this.referenceExternalTransactionId
    ) {
      throw new InvalidWagerTransactionError(
        'reference does not match referenceExternalTransactionId',
      );
    }
    if (
      reference.providerId !== this.providerId ||
      reference.playerId !== this.playerId ||
      reference.walletId !== this.walletId ||
      reference.roundId !== this.roundId ||
      reference.money.currency !== this.money.currency
    ) {
      return reject(FailureCode.ReferenceMismatch);
    }
    if (!allowedKinds.has(reference.kind)) {
      return reject(FailureCode.InvalidReferenceKind);
    }
    if (this.requiresReference() && !this.money.equals(reference.money)) {
      return reject(FailureCode.ReversalAmountMismatch);
    }
    if (!reference.isTerminal()) {
      return WAIT;
    }
    if (reference.status !== WagerTransactionStatus.Processed) {
      return reject(FailureCode.ReferenceNotProcessed);
    }
    return VALID;
  }

  ledgerDirectionFor(reference?: WagerTransaction): LedgerDirection {
    switch (this.kind) {
      case WagerTransactionKind.Bet:
        return LedgerDirection.Debit;
      case WagerTransactionKind.Opening:
      case WagerTransactionKind.Win:
      case WagerTransactionKind.Refund:
        return LedgerDirection.Credit;
      case WagerTransactionKind.Loss:
        throw new InvalidWagerTransactionError(
          'LOSS does not produce ledger entries',
        );
      case WagerTransactionKind.Rollback: {
        if (reference === undefined) {
          throw new InvalidWagerTransactionError(
            'ROLLBACK direction requires the referenced transaction',
          );
        }
        const check = this.validateReference(reference);
        if (check.outcome !== 'VALID') {
          throw new InvalidTransactionReferenceError(
            check.outcome === 'REJECT'
              ? check.failureCode
              : FailureCode.ReferenceNotProcessed,
          );
        }
        return reference.kind === WagerTransactionKind.Bet
          ? LedgerDirection.Credit
          : LedgerDirection.Debit;
      }
    }
  }

  insufficientFundsFailureCode(): FailureCode {
    switch (this.kind) {
      case WagerTransactionKind.Bet:
        return FailureCode.InsufficientFunds;
      case WagerTransactionKind.Rollback:
        return FailureCode.ReversalWouldOverdraw;
      default:
        throw new InvalidWagerTransactionError(
          `${this.kind} never debits a wallet`,
        );
    }
  }

  #finishWithFailure(status: WagerTransactionStatus, code: FailureCode): void {
    this.#assertCanTransitionTo(status);
    if (!isEnumValue(FailureCode, code)) {
      throw new InvalidWagerTransactionError('failureCode is invalid');
    }
    this.#status = status;
    this.#failureCode = code;
  }

  #assertCanTransitionTo(next: WagerTransactionStatus): void {
    if (!WAGER_TRANSACTION_TRANSITIONS[this.#status].has(next)) {
      throw new InvalidTransactionStateError(this.#status, next);
    }
  }

  private static assertStructure(state: CreateWagerTransactionProps): void {
    assertNonEmptyString(state.id, 'id');
    assertNonEmptyString(state.providerId, 'providerId');
    assertNonEmptyString(state.externalTransactionId, 'externalTransactionId');
    assertNonEmptyString(state.idempotencyKey, 'idempotencyKey');
    assertNonEmptyString(state.payloadHash, 'payloadHash');
    assertNonEmptyString(state.walletId, 'walletId');
    assertNonEmptyString(state.playerId, 'playerId');
    assertNonEmptyString(state.roundId, 'roundId');
    assertNonEmptyString(state.gameId, 'gameId');
    if (!isEnumValue(WagerTransactionKind, state.kind)) {
      throw new InvalidWagerTransactionError('kind is invalid');
    }
    if (!(state.money instanceof Money)) {
      throw new InvalidWagerTransactionError('money must be a Money instance');
    }
    if (state.referenceExternalTransactionId !== undefined) {
      assertNonEmptyString(
        state.referenceExternalTransactionId,
        'referenceExternalTransactionId',
      );
    }
    assertValidDate(state.createdAt, 'createdAt');
  }
}

function kindRequiresReference(kind: WagerTransactionKind): boolean {
  return (
    kind === WagerTransactionKind.Refund ||
    kind === WagerTransactionKind.Rollback
  );
}

function assertNonEmptyString(value: unknown, field: string): void {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new InvalidWagerTransactionError(
      `${field} must be a non-empty string`,
    );
  }
}

function assertValidDate(value: unknown, field: string): void {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new InvalidWagerTransactionError(`${field} must be a valid Date`);
  }
}
