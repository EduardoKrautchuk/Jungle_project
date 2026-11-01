import { Migration } from '@mikro-orm/migrations';

export class Migration20261102120000_add_outbox_publication_lease extends Migration {
  override up(): void {
    this.addSql(`
      ALTER TABLE outbox_messages
        ADD COLUMN publish_sequence bigint GENERATED ALWAYS AS IDENTITY,
        ADD COLUMN group_key text GENERATED ALWAYS AS (
          coalesce(payload #>> '{data,walletId}', aggregate_id)
        ) STORED,
        ADD COLUMN lease_owner text,
        ADD COLUMN lease_token uuid,
        ADD COLUMN lease_expires_at timestamptz,
        ADD COLUMN last_attempt_at timestamptz,
        ADD COLUMN last_error text,
        ADD COLUMN dead_lettered_at timestamptz,
        ADD COLUMN transport_message_id text
    `);
    this.addSql(`
      ALTER TABLE outbox_messages
        ADD CONSTRAINT outbox_publish_sequence_uq UNIQUE (publish_sequence),
        ADD CONSTRAINT outbox_lease_complete_ck CHECK (
          (lease_token IS NULL) = (lease_expires_at IS NULL)
          AND (lease_token IS NULL) = (lease_owner IS NULL)
        ),
        ADD CONSTRAINT outbox_terminal_state_ck CHECK (
          published_at IS NULL OR dead_lettered_at IS NULL
        ),
        ADD CONSTRAINT outbox_terminal_unleased_ck CHECK (
          (published_at IS NULL AND dead_lettered_at IS NULL) OR lease_token IS NULL
        ),
        ADD CONSTRAINT outbox_last_error_length_ck CHECK (
          last_error IS NULL OR length(last_error) <= 1000
        )
    `);
    this.addSql(`
      CREATE INDEX outbox_unpublished_group_idx
        ON outbox_messages (group_key, publish_sequence)
        WHERE published_at IS NULL AND dead_lettered_at IS NULL
    `);
  }

  override down(): void {
    this.addSql('DROP INDEX outbox_unpublished_group_idx');
    this.addSql(`
      ALTER TABLE outbox_messages
        DROP CONSTRAINT outbox_last_error_length_ck,
        DROP CONSTRAINT outbox_terminal_unleased_ck,
        DROP CONSTRAINT outbox_terminal_state_ck,
        DROP CONSTRAINT outbox_lease_complete_ck,
        DROP CONSTRAINT outbox_publish_sequence_uq
    `);
    this.addSql(`
      ALTER TABLE outbox_messages
        DROP COLUMN transport_message_id,
        DROP COLUMN dead_lettered_at,
        DROP COLUMN last_error,
        DROP COLUMN last_attempt_at,
        DROP COLUMN lease_expires_at,
        DROP COLUMN lease_token,
        DROP COLUMN lease_owner,
        DROP COLUMN group_key,
        DROP COLUMN publish_sequence
    `);
  }
}
