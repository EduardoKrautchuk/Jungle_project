import {
  ConcurrencyConflictError,
  IntegrityConstraintViolationError,
  PersistenceError,
  UniqueConstraintViolationError,
} from '../../application/ports/persistence.errors.js';

const UNIQUE_VIOLATION = '23505';
const INTEGRITY_VIOLATIONS = new Set(['23001', '23502', '23503', '23514']);
const CONCURRENCY_FAILURES = new Set(['40001', '40P01', '55P03']);

interface SqlStateError {
  code: string;
  constraint?: unknown;
}

function hasSqlState(error: unknown): error is SqlStateError {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof error.code === 'string' &&
    /^[0-9A-Z]{5}$/.test(error.code)
  );
}

function constraintOf(error: SqlStateError): string | undefined {
  return typeof error.constraint === 'string' ? error.constraint : undefined;
}

export function translateDatabaseError(error: unknown): unknown {
  if (error instanceof PersistenceError || !hasSqlState(error)) {
    return error;
  }
  const options = { cause: error };
  if (error.code === UNIQUE_VIOLATION) {
    return new UniqueConstraintViolationError(constraintOf(error), options);
  }
  if (INTEGRITY_VIOLATIONS.has(error.code)) {
    return new IntegrityConstraintViolationError(
      constraintOf(error),
      error.code,
      options,
    );
  }
  if (CONCURRENCY_FAILURES.has(error.code)) {
    return new ConcurrencyConflictError(
      `database reported ${error.code}`,
      options,
    );
  }
  return error;
}
