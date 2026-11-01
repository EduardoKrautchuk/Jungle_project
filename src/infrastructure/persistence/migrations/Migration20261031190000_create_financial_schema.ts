import { Migration } from '@mikro-orm/migrations';

export class Migration20261031190000_create_financial_schema extends Migration {
  override up(): void {
    this.addSql(`
      CREATE DOMAIN money_amount AS numeric
        CONSTRAINT money_amount_scale_ck CHECK (scale(VALUE) = 2)
        CONSTRAINT money_amount_range_ck CHECK (abs(VALUE) <= 999999999999999999.99)
    `);
    this.addSql(`
      CREATE DOMAIN currency_code AS text
        CONSTRAINT currency_code_format_ck CHECK (VALUE ~ '^[A-Z]{3}$')
    `);
    this.addSql(`
      CREATE DOMAIN identifier AS varchar(256)
        CONSTRAINT identifier_not_blank_ck CHECK (btrim(VALUE) <> '')
    `);
    this.addSql(`
      CREATE DOMAIN sha256_hex AS text
        CONSTRAINT sha256_hex_format_ck CHECK (VALUE ~ '^[0-9a-f]{64}$')
    `);

    this.addSql(`
      CREATE TABLE wallets (
        id uuid NOT NULL,
        player_id identifier NOT NULL,
        currency currency_code NOT NULL,
        balance money_amount NOT NULL,
        version integer NOT NULL,
        created_at timestamptz NOT NULL,
        updated_at timestamptz NOT NULL,
        CONSTRAINT wallets_pk PRIMARY KEY (id),
        CONSTRAINT wallets_player_currency_uq UNIQUE (player_id, currency),
        CONSTRAINT wallets_id_currency_uq UNIQUE (id, currency),
        CONSTRAINT wallets_balance_non_negative_ck CHECK (balance >= 0),
        CONSTRAINT wallets_version_ck CHECK (version >= 1),
        CONSTRAINT wallets_updated_after_created_ck CHECK (updated_at >= created_at)
      )
    `);

    this.addSql(`
      CREATE TABLE wager_transactions (
        id uuid NOT NULL,
        provider_id identifier NOT NULL,
        external_transaction_id identifier NOT NULL,
        idempotency_key identifier NOT NULL,
        payload_hash sha256_hex NOT NULL,
        wallet_id uuid NOT NULL,
        player_id identifier NOT NULL,
        round_id identifier NOT NULL,
        game_id identifier NOT NULL,
        kind text NOT NULL,
        status text NOT NULL,
        amount money_amount NOT NULL,
        currency currency_code NOT NULL,
        reference_external_transaction_id identifier,
        reference_transaction_id uuid,
        failure_code text,
        result_balance money_amount,
        reference_attempts integer NOT NULL DEFAULT 0,
        next_reference_attempt_at timestamptz,
        created_at timestamptz NOT NULL,
        processed_at timestamptz,
        CONSTRAINT wager_tx_pk PRIMARY KEY (id),
        CONSTRAINT wager_tx_provider_external_uq UNIQUE (provider_id, external_transaction_id),
        CONSTRAINT wager_tx_provider_idempotency_uq UNIQUE (provider_id, idempotency_key),
        CONSTRAINT wager_tx_wallet_currency_uq UNIQUE (id, wallet_id, currency),
        CONSTRAINT wager_tx_reference_scope_uq
          UNIQUE (id, external_transaction_id, provider_id, player_id, wallet_id, currency, round_id),
        CONSTRAINT wager_tx_reference_scope_fk
          FOREIGN KEY (reference_transaction_id, reference_external_transaction_id, provider_id, player_id, wallet_id, currency, round_id)
          REFERENCES wager_transactions (id, external_transaction_id, provider_id, player_id, wallet_id, currency, round_id),
        CONSTRAINT wager_tx_kind_ck
          CHECK (kind IN ('OPENING', 'BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK')),
        CONSTRAINT wager_tx_status_ck
          CHECK (status IN ('PENDING', 'PENDING_REFERENCE', 'PROCESSED', 'REJECTED', 'FAILED')),
        CONSTRAINT wager_tx_failure_code_ck
          CHECK (failure_code IN (
            'INSUFFICIENT_FUNDS', 'REVERSAL_WOULD_OVERDRAW', 'REFERENCE_NOT_FOUND',
            'REFERENCE_MISMATCH', 'INVALID_REFERENCE_KIND', 'REFERENCE_NOT_PROCESSED',
            'ALREADY_REVERSED', 'REVERSAL_AMOUNT_MISMATCH', 'CURRENCY_MISMATCH',
            'WALLET_NOT_FOUND', 'WALLET_PLAYER_MISMATCH', 'PROCESSING_FAILED'
          )),
        CONSTRAINT wager_tx_amount_ck
          CHECK (amount > 0 OR (kind = 'LOSS' AND amount = 0)),
        CONSTRAINT wager_tx_reference_required_ck
          CHECK (kind NOT IN ('REFUND', 'ROLLBACK') OR reference_external_transaction_id IS NOT NULL),
        CONSTRAINT wager_tx_reference_forbidden_ck
          CHECK (kind NOT IN ('OPENING', 'BET', 'LOSS') OR reference_external_transaction_id IS NULL),
        CONSTRAINT wager_tx_not_self_reference_ck
          CHECK (
            reference_external_transaction_id IS DISTINCT FROM external_transaction_id
            AND reference_transaction_id IS DISTINCT FROM id
          ),
        CONSTRAINT wager_tx_resolved_reference_ck
          CHECK (reference_transaction_id IS NULL OR reference_external_transaction_id IS NOT NULL),
        CONSTRAINT wager_tx_processed_at_ck
          CHECK ((status = 'PROCESSED') = (processed_at IS NOT NULL)),
        CONSTRAINT wager_tx_failure_code_status_ck
          CHECK ((status IN ('REJECTED', 'FAILED')) = (failure_code IS NOT NULL)),
        CONSTRAINT wager_tx_processed_reference_ck
          CHECK (
            status <> 'PROCESSED'
            OR reference_external_transaction_id IS NULL
            OR reference_transaction_id IS NOT NULL
          ),
        CONSTRAINT wager_tx_pending_reference_ck
          CHECK (
            status <> 'PENDING_REFERENCE'
            OR (reference_external_transaction_id IS NOT NULL AND next_reference_attempt_at IS NOT NULL)
          ),
        CONSTRAINT wager_tx_result_balance_ck
          CHECK (result_balance IS NULL OR result_balance >= 0),
        CONSTRAINT wager_tx_processed_result_ck
          CHECK (status <> 'PROCESSED' OR result_balance IS NOT NULL),
        CONSTRAINT wager_tx_reference_attempts_ck CHECK (reference_attempts >= 0),
        CONSTRAINT wager_tx_processed_after_created_ck
          CHECK (processed_at IS NULL OR processed_at >= created_at)
      )
    `);
    this.addSql(`
      CREATE UNIQUE INDEX wager_tx_single_reversal_uq
        ON wager_transactions (reference_transaction_id, kind)
        WHERE kind IN ('REFUND', 'ROLLBACK') AND status = 'PROCESSED'
    `);
    this.addSql(`
      CREATE INDEX wager_tx_pending_reference_due_idx
        ON wager_transactions (next_reference_attempt_at)
        WHERE status = 'PENDING_REFERENCE'
    `);

    this.addSql(`
      CREATE TABLE wallet_ledger_entries (
        id uuid NOT NULL,
        wallet_id uuid NOT NULL,
        transaction_id uuid NOT NULL,
        direction text NOT NULL,
        amount money_amount NOT NULL,
        currency currency_code NOT NULL,
        balance_before money_amount NOT NULL,
        balance_after money_amount NOT NULL,
        created_at timestamptz NOT NULL,
        CONSTRAINT ledger_pk PRIMARY KEY (id),
        CONSTRAINT ledger_wallet_transaction_uq UNIQUE (wallet_id, transaction_id),
        CONSTRAINT ledger_wallet_fk
          FOREIGN KEY (wallet_id, currency) REFERENCES wallets (id, currency),
        CONSTRAINT ledger_transaction_fk
          FOREIGN KEY (transaction_id, wallet_id, currency)
          REFERENCES wager_transactions (id, wallet_id, currency),
        CONSTRAINT ledger_direction_ck CHECK (direction IN ('DEBIT', 'CREDIT')),
        CONSTRAINT ledger_amount_positive_ck CHECK (amount > 0),
        CONSTRAINT ledger_balance_before_non_negative_ck CHECK (balance_before >= 0),
        CONSTRAINT ledger_balance_after_non_negative_ck CHECK (balance_after >= 0),
        CONSTRAINT ledger_arithmetic_ck
          CHECK (
            balance_after = CASE direction
              WHEN 'CREDIT' THEN balance_before + amount
              ELSE balance_before - amount
            END
          )
      )
    `);
    this.addSql(`
      CREATE INDEX ledger_wallet_created_idx
        ON wallet_ledger_entries (wallet_id, created_at, id)
    `);
    this.addSql(`
      CREATE INDEX ledger_transaction_idx ON wallet_ledger_entries (transaction_id)
    `);
    this.addSql(`
      CREATE FUNCTION wallet_ledger_entries_append_only() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION 'wallet_ledger_entries is append-only: % is not allowed', TG_OP
          USING ERRCODE = 'restrict_violation';
      END;
      $$
    `);
    this.addSql(`
      CREATE TRIGGER wallet_ledger_entries_no_update_delete
        BEFORE UPDATE OR DELETE ON wallet_ledger_entries
        FOR EACH ROW EXECUTE FUNCTION wallet_ledger_entries_append_only()
    `);
    this.addSql(`
      CREATE TRIGGER wallet_ledger_entries_no_truncate
        BEFORE TRUNCATE ON wallet_ledger_entries
        FOR EACH STATEMENT EXECUTE FUNCTION wallet_ledger_entries_append_only()
    `);
  }

  override down(): void {
    this.addSql('DROP TABLE wallet_ledger_entries');
    this.addSql('DROP FUNCTION wallet_ledger_entries_append_only()');
    this.addSql('DROP TABLE wager_transactions');
    this.addSql('DROP TABLE wallets');
    this.addSql('DROP DOMAIN sha256_hex');
    this.addSql('DROP DOMAIN identifier');
    this.addSql('DROP DOMAIN currency_code');
    this.addSql('DROP DOMAIN money_amount');
  }
}
