import { Migration } from '@mikro-orm/migrations';

export class Migration20261031200000_enforce_single_reversal_and_wallet_link extends Migration {
  override up(): void {
    this.addSql('DROP INDEX wager_tx_single_reversal_uq');
    this.addSql(`
      CREATE UNIQUE INDEX wager_tx_single_reversal_uq
        ON wager_transactions (reference_transaction_id)
        WHERE kind IN ('REFUND', 'ROLLBACK') AND status = 'PROCESSED'
    `);

    this.addSql(`
      ALTER TABLE wallets
        ADD CONSTRAINT wallets_id_player_currency_uq UNIQUE (id, player_id, currency)
    `);
    this.addSql(`
      ALTER TABLE wager_transactions
        ADD COLUMN wallet_link_id uuid GENERATED ALWAYS AS (
          CASE
            WHEN failure_code IN ('WALLET_NOT_FOUND', 'WALLET_PLAYER_MISMATCH', 'CURRENCY_MISMATCH')
              THEN NULL
            ELSE wallet_id
          END
        ) STORED
    `);
    this.addSql(`
      ALTER TABLE wager_transactions
        ADD CONSTRAINT wager_tx_wallet_fk
          FOREIGN KEY (wallet_link_id, player_id, currency)
          REFERENCES wallets (id, player_id, currency)
    `);
    this.addSql(`
      CREATE INDEX wager_tx_wallet_link_idx ON wager_transactions (wallet_link_id)
    `);
  }

  override down(): void {
    this.addSql('DROP INDEX wager_tx_wallet_link_idx');
    this.addSql(
      'ALTER TABLE wager_transactions DROP CONSTRAINT wager_tx_wallet_fk',
    );
    this.addSql('ALTER TABLE wager_transactions DROP COLUMN wallet_link_id');
    this.addSql(
      'ALTER TABLE wallets DROP CONSTRAINT wallets_id_player_currency_uq',
    );
    this.addSql('DROP INDEX wager_tx_single_reversal_uq');
    this.addSql(`
      CREATE UNIQUE INDEX wager_tx_single_reversal_uq
        ON wager_transactions (reference_transaction_id, kind)
        WHERE kind IN ('REFUND', 'ROLLBACK') AND status = 'PROCESSED'
    `);
  }
}
