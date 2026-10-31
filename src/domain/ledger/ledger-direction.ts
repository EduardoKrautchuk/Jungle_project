export enum LedgerDirection {
  Debit = 'DEBIT',
  Credit = 'CREDIT',
}

const DIRECTIONS: ReadonlySet<string> = new Set(Object.values(LedgerDirection));

export function isLedgerDirection(value: unknown): value is LedgerDirection {
  return typeof value === 'string' && DIRECTIONS.has(value);
}
