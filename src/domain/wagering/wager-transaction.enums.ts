export enum WagerTransactionKind {
  Opening = 'OPENING',
  Bet = 'BET',
  Win = 'WIN',
  Loss = 'LOSS',
  Refund = 'REFUND',
  Rollback = 'ROLLBACK',
}

export enum WagerTransactionStatus {
  Pending = 'PENDING',
  PendingReference = 'PENDING_REFERENCE',
  Processed = 'PROCESSED',
  Rejected = 'REJECTED',
  Failed = 'FAILED',
}

export enum FailureCode {
  InsufficientFunds = 'INSUFFICIENT_FUNDS',
  ReversalWouldOverdraw = 'REVERSAL_WOULD_OVERDRAW',
  BalanceLimitExceeded = 'BALANCE_LIMIT_EXCEEDED',
  ReferenceNotFound = 'REFERENCE_NOT_FOUND',
  ReferenceMismatch = 'REFERENCE_MISMATCH',
  InvalidReferenceKind = 'INVALID_REFERENCE_KIND',
  ReferenceNotProcessed = 'REFERENCE_NOT_PROCESSED',
  AlreadyReversed = 'ALREADY_REVERSED',
  ReversalAmountMismatch = 'REVERSAL_AMOUNT_MISMATCH',
  CurrencyMismatch = 'CURRENCY_MISMATCH',
  WalletNotFound = 'WALLET_NOT_FOUND',
  WalletPlayerMismatch = 'WALLET_PLAYER_MISMATCH',
  ProcessingFailed = 'PROCESSING_FAILED',
}

export const WAGER_TRANSACTION_TRANSITIONS: Readonly<
  Record<WagerTransactionStatus, ReadonlySet<WagerTransactionStatus>>
> = {
  [WagerTransactionStatus.Pending]: new Set([
    WagerTransactionStatus.PendingReference,
    WagerTransactionStatus.Processed,
    WagerTransactionStatus.Rejected,
    WagerTransactionStatus.Failed,
  ]),
  [WagerTransactionStatus.PendingReference]: new Set([
    WagerTransactionStatus.Processed,
    WagerTransactionStatus.Rejected,
    WagerTransactionStatus.Failed,
  ]),
  [WagerTransactionStatus.Processed]: new Set(),
  [WagerTransactionStatus.Rejected]: new Set(),
  [WagerTransactionStatus.Failed]: new Set(),
};

const PROVIDER_SUBMITTABLE_KINDS: ReadonlySet<string> = new Set([
  WagerTransactionKind.Bet,
  WagerTransactionKind.Win,
  WagerTransactionKind.Loss,
  WagerTransactionKind.Refund,
  WagerTransactionKind.Rollback,
]);

export function isProviderSubmittableKind(
  value: unknown,
): value is WagerTransactionKind {
  return typeof value === 'string' && PROVIDER_SUBMITTABLE_KINDS.has(value);
}

export function isEnumValue<T extends string>(
  enumObject: Record<string, T>,
  value: unknown,
): value is T {
  return (
    typeof value === 'string' &&
    (Object.values(enumObject) as string[]).includes(value)
  );
}
