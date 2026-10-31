import { DomainError } from '../shared/domain-error.js';

export type LedgerErrorCode =
  'LEDGER_INVALID_ENTRY' | 'LEDGER_UNBALANCED_ENTRY';

export abstract class LedgerError extends DomainError<LedgerErrorCode> {}

export class InvalidLedgerEntryError extends LedgerError {
  constructor(reason: string) {
    super('LEDGER_INVALID_ENTRY', `Invalid ledger entry: ${reason}`);
  }
}

export class UnbalancedLedgerEntryError extends LedgerError {
  constructor() {
    super(
      'LEDGER_UNBALANCED_ENTRY',
      'Ledger entry is unbalanced: balanceBefore ± money must equal balanceAfter',
    );
  }
}
