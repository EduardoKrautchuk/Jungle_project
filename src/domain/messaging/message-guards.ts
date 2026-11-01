import { InvalidMessageError } from './messaging.errors.js';

const SHA256_HEX = /^[0-9a-f]{64}$/;

export function assertNonEmptyString(value: unknown, field: string): void {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new InvalidMessageError(`${field} must be a non-empty string`);
  }
}

export function assertSha256(value: unknown, field: string): void {
  if (typeof value !== 'string' || !SHA256_HEX.test(value)) {
    throw new InvalidMessageError(`${field} must be a lowercase SHA-256 hex`);
  }
}

export function assertValidDate(value: unknown, field: string): void {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new InvalidMessageError(`${field} must be a valid Date`);
  }
}

export function assertNonNegativeInteger(value: unknown, field: string): void {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new InvalidMessageError(`${field} must be a non-negative integer`);
  }
}
