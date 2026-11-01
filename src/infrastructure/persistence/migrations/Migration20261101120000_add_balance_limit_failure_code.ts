import { Migration } from '@mikro-orm/migrations';

const BASE_FAILURE_CODES = `
  'INSUFFICIENT_FUNDS', 'REVERSAL_WOULD_OVERDRAW', 'REFERENCE_NOT_FOUND',
  'REFERENCE_MISMATCH', 'INVALID_REFERENCE_KIND', 'REFERENCE_NOT_PROCESSED',
  'ALREADY_REVERSED', 'REVERSAL_AMOUNT_MISMATCH', 'CURRENCY_MISMATCH',
  'WALLET_NOT_FOUND', 'WALLET_PLAYER_MISMATCH', 'PROCESSING_FAILED'
`;

export class Migration20261101120000_add_balance_limit_failure_code extends Migration {
  override up(): void {
    this.replaceFailureCodeCheck(
      `${BASE_FAILURE_CODES}, 'BALANCE_LIMIT_EXCEEDED'`,
    );
  }

  override down(): void {
    this.replaceFailureCodeCheck(BASE_FAILURE_CODES, 'NOT VALID');
  }

  private replaceFailureCodeCheck(codes: string, validation = ''): void {
    this.addSql(
      'ALTER TABLE wager_transactions DROP CONSTRAINT wager_tx_failure_code_ck',
    );
    this.addSql(`
      ALTER TABLE wager_transactions
        ADD CONSTRAINT wager_tx_failure_code_ck
          CHECK (failure_code IN (${codes})) ${validation}
    `);
  }
}
