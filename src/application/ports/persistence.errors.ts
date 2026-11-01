export type PersistenceErrorCode =
  | 'PERSISTENCE_UNIQUE_VIOLATION'
  | 'PERSISTENCE_INTEGRITY_VIOLATION'
  | 'PERSISTENCE_CONCURRENCY_CONFLICT';

export abstract class PersistenceError extends Error {
  protected constructor(
    readonly code: PersistenceErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = new.target.name;
  }
}

export class UniqueConstraintViolationError extends PersistenceError {
  constructor(
    readonly constraint: string | undefined,
    options?: ErrorOptions,
  ) {
    super(
      'PERSISTENCE_UNIQUE_VIOLATION',
      `Unique constraint violated: ${constraint ?? 'unknown'}`,
      options,
    );
  }
}

export class IntegrityConstraintViolationError extends PersistenceError {
  constructor(
    readonly constraint: string | undefined,
    readonly sqlState: string,
    options?: ErrorOptions,
  ) {
    super(
      'PERSISTENCE_INTEGRITY_VIOLATION',
      `Integrity constraint violated (${sqlState}): ${constraint ?? 'unknown'}`,
      options,
    );
  }
}

export class ConcurrencyConflictError extends PersistenceError {
  constructor(reason: string, options?: ErrorOptions) {
    super(
      'PERSISTENCE_CONCURRENCY_CONFLICT',
      `Concurrency conflict: ${reason}`,
      options,
    );
  }
}
