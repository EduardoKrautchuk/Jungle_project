import { ConnectionException } from '@mikro-orm/postgresql';
import {
  ConcurrencyConflictError,
  IntegrityConstraintViolationError,
  PersistenceError,
  PersistenceUnavailableError,
  UniqueConstraintViolationError,
} from '../../application/ports/persistence.errors.js';

const UNIQUE_VIOLATION = '23505';
const INTEGRITY_VIOLATIONS = new Set(['23001', '23502', '23503', '23514']);
const CONCURRENCY_FAILURES = new Set(['40001', '40P01', '55P03']);
const UNAVAILABLE_SQL_STATES = new Set([
  '53000',
  '53300',
  '57P01',
  '57P02',
  '57P03',
]);
const NETWORK_ERROR_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ENOTFOUND',
  'EPIPE',
]);

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

function networkErrorCode(error: unknown): string | undefined {
  if (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof error.code === 'string' &&
    NETWORK_ERROR_CODES.has(error.code)
  ) {
    return error.code;
  }
  return undefined;
}

export function translateDatabaseError(error: unknown): unknown {
  if (error instanceof PersistenceError) {
    return error;
  }
  if (error instanceof ConnectionException) {
    return new PersistenceUnavailableError('connection failed', {
      cause: error,
    });
  }
  const networkCode = networkErrorCode(error);
  if (networkCode !== undefined) {
    return new PersistenceUnavailableError(networkCode, { cause: error });
  }
  if (!hasSqlState(error)) {
    return error;
  }
  const options = { cause: error };
  if (error.code.startsWith('08') || UNAVAILABLE_SQL_STATES.has(error.code)) {
    return new PersistenceUnavailableError(
      `database reported ${error.code}`,
      options,
    );
  }
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
