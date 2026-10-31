import { Migration } from '@mikro-orm/migrations';

export class Migration20261031190100_create_messaging_schema extends Migration {
  override up(): void {
    this.addSql(`
      CREATE TABLE inbox_messages (
        consumer_name identifier NOT NULL,
        message_id identifier NOT NULL,
        payload_hash sha256_hex NOT NULL,
        received_at timestamptz NOT NULL,
        processed_at timestamptz,
        CONSTRAINT inbox_messages_pk PRIMARY KEY (consumer_name, message_id),
        CONSTRAINT inbox_processed_after_received_ck
          CHECK (processed_at IS NULL OR processed_at >= received_at)
      )
    `);

    this.addSql(`
      CREATE TABLE outbox_messages (
        id uuid NOT NULL,
        aggregate_id identifier NOT NULL,
        event_type identifier NOT NULL,
        payload jsonb NOT NULL,
        occurred_at timestamptz NOT NULL,
        attempts integer NOT NULL DEFAULT 0,
        next_attempt_at timestamptz NOT NULL,
        published_at timestamptz,
        CONSTRAINT outbox_messages_pk PRIMARY KEY (id),
        CONSTRAINT outbox_payload_object_ck CHECK (jsonb_typeof(payload) = 'object'),
        CONSTRAINT outbox_attempts_ck CHECK (attempts >= 0),
        CONSTRAINT outbox_published_after_occurred_ck
          CHECK (published_at IS NULL OR published_at >= occurred_at)
      )
    `);
    this.addSql(`
      CREATE INDEX outbox_pending_due_idx
        ON outbox_messages (next_attempt_at, occurred_at)
        WHERE published_at IS NULL
    `);
  }

  override down(): void {
    this.addSql('DROP TABLE outbox_messages');
    this.addSql('DROP TABLE inbox_messages');
  }
}
