export type ApplicationErrorCode =
  | 'VALIDATION_FAILED'
  | 'IDEMPOTENCY_CONFLICT'
  | 'MESSAGE_PAYLOAD_MISMATCH'
  | 'WALLET_ALREADY_EXISTS'
  | 'WALLET_NOT_FOUND'
  | 'TRANSACTION_NOT_FOUND';

export interface ValidationIssue {
  readonly field: string;
  readonly code: string;
  readonly message: string;
}

export abstract class ApplicationError extends Error {
  protected constructor(
    readonly code: ApplicationErrorCode,
    message: string,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class InvalidRequestError extends ApplicationError {
  constructor(readonly issues: readonly ValidationIssue[]) {
    super('VALIDATION_FAILED', 'The request is invalid');
  }
}

export class IdempotencyConflictError extends ApplicationError {
  constructor(reason: string) {
    super('IDEMPOTENCY_CONFLICT', reason);
  }
}

export class WalletAlreadyExistsError extends ApplicationError {
  constructor() {
    super(
      'WALLET_ALREADY_EXISTS',
      'A wallet already exists for this player and currency',
    );
  }
}

export class WalletNotFoundError extends ApplicationError {
  constructor() {
    super('WALLET_NOT_FOUND', 'Wallet not found');
  }
}

export class TransactionNotFoundError extends ApplicationError {
  constructor() {
    super('TRANSACTION_NOT_FOUND', 'Transaction not found');
  }
}

export class MessagePayloadMismatchError extends ApplicationError {
  constructor() {
    super(
      'MESSAGE_PAYLOAD_MISMATCH',
      'messageId was already received with a different payload',
    );
  }
}
