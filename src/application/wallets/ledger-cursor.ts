import { InvalidRequestError } from '../application.errors.js';
import type { LedgerCursor } from '../ports/persistence.js';

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ISO_INSTANT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export function encodeLedgerCursor(cursor: LedgerCursor): string {
  return Buffer.from(
    JSON.stringify({ t: cursor.createdAt.toISOString(), id: cursor.id }),
    'utf8',
  ).toString('base64url');
}

export function decodeLedgerCursor(encoded: string): LedgerCursor {
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
  } catch {
    throw invalidCursor();
  }
  if (
    typeof decoded !== 'object' ||
    decoded === null ||
    !('t' in decoded) ||
    !('id' in decoded) ||
    typeof decoded.t !== 'string' ||
    typeof decoded.id !== 'string' ||
    !ISO_INSTANT_PATTERN.test(decoded.t) ||
    !UUID_PATTERN.test(decoded.id)
  ) {
    throw invalidCursor();
  }
  const createdAt = new Date(decoded.t);
  if (
    Number.isNaN(createdAt.getTime()) ||
    createdAt.toISOString() !== decoded.t
  ) {
    throw invalidCursor();
  }
  return { createdAt, id: decoded.id };
}

function invalidCursor(): InvalidRequestError {
  return new InvalidRequestError([
    {
      field: 'cursor',
      code: 'INVALID_CURSOR',
      message: 'cursor is not a valid ledger cursor',
    },
  ]);
}
