import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { MikroORM } from '@mikro-orm/postgresql';
import {
  Db,
  HASH,
  SQLSTATE,
  T0,
  T1,
  expectViolation,
  migrateFresh,
  openTestOrm,
  type Row,
} from './support.js';

let orm: MikroORM;
let db: Db;

const inbox = (overrides: Row = {}): Row => ({
  consumer_name: 'wager-transactions-consumer',
  message_id: `msg-${randomUUID()}`,
  payload_hash: HASH,
  received_at: T0,
  ...overrides,
});

const outbox = (overrides: Row = {}): Row => ({
  id: randomUUID(),
  aggregate_id: randomUUID(),
  event_type: 'WagerTransactionProcessed',
  payload: JSON.stringify({ eventId: 'e-1', data: { amount: '25.00' } }),
  occurred_at: T0,
  next_attempt_at: T0,
  ...overrides,
});

describe('messaging schema constraints', () => {
  beforeAll(async () => {
    orm = await openTestOrm();
    db = new Db(orm);
    await migrateFresh(orm);
  });

  afterAll(async () => {
    await orm.close(true);
  });

  describe('inbox_messages', () => {
    it('deduplicates by consumer and message id', async () => {
      const message = inbox();
      await db.insert('inbox_messages', message);
      await expectViolation(db.insert('inbox_messages', message), {
        code: SQLSTATE.uniqueViolation,
        constraint: 'inbox_messages_pk',
      });
    });

    it('allows the same message for another consumer', async () => {
      const message = inbox();
      await db.insert('inbox_messages', message);
      await db.insert('inbox_messages', {
        ...message,
        consumer_name: 'audit-consumer',
      });
    });

    it.each([
      ['blank consumer', { consumer_name: ' ' }, 'identifier_not_blank_ck'],
      ['blank message id', { message_id: '' }, 'identifier_not_blank_ck'],
      ['invalid payload hash', { payload_hash: 'abc' }, 'sha256_hex_format_ck'],
      [
        'processed before received',
        { received_at: T1, processed_at: T0 },
        'inbox_processed_after_received_ck',
      ],
    ] as const)('rejects %s', async (_label, overrides, constraint) => {
      await expectViolation(db.insert('inbox_messages', inbox(overrides)), {
        code: SQLSTATE.checkViolation,
        constraint,
      });
    });

    it('requires received_at', async () => {
      await expectViolation(
        db.insert('inbox_messages', inbox({ received_at: null })),
        { code: SQLSTATE.notNullViolation },
      );
    });
  });

  describe('outbox_messages', () => {
    it('stores a pending event with zero attempts and the payload intact', async () => {
      const event = outbox();
      await db.insert('outbox_messages', event);
      const [stored] = await db.query(
        `SELECT attempts, published_at, payload->'data'->>'amount' AS amount
         FROM outbox_messages WHERE id = ?`,
        [event.id],
      );
      expect(stored).toEqual({
        attempts: 0,
        published_at: null,
        amount: '25.00',
      });
    });

    it('rejects a duplicate event id', async () => {
      const event = outbox();
      await db.insert('outbox_messages', event);
      await expectViolation(db.insert('outbox_messages', event), {
        code: SQLSTATE.uniqueViolation,
        constraint: 'outbox_messages_pk',
      });
    });

    it.each([
      ['negative attempts', { attempts: -1 }, 'outbox_attempts_ck'],
      ['array payload', { payload: '[1, 2]' }, 'outbox_payload_object_ck'],
      ['scalar payload', { payload: '"text"' }, 'outbox_payload_object_ck'],
      [
        'published before occurred',
        { occurred_at: T1, published_at: T0 },
        'outbox_published_after_occurred_ck',
      ],
      ['blank event type', { event_type: '' }, 'identifier_not_blank_ck'],
    ] as const)('rejects %s', async (_label, overrides, constraint) => {
      await expectViolation(db.insert('outbox_messages', outbox(overrides)), {
        code: SQLSTATE.checkViolation,
        constraint,
      });
    });

    it('requires next_attempt_at so due events can be found', async () => {
      await expectViolation(
        db.insert('outbox_messages', outbox({ next_attempt_at: null })),
        { code: SQLSTATE.notNullViolation },
      );
    });

    it('finds only unpublished due events through the partial index', async () => {
      const due = outbox({ next_attempt_at: T0 });
      const later = outbox({ next_attempt_at: '2099-01-01T00:00:00.000Z' });
      const published = outbox({ published_at: T1 });
      for (const event of [due, later, published]) {
        await db.insert('outbox_messages', event);
      }
      const rows = await db.query(
        `SELECT id FROM outbox_messages
         WHERE published_at IS NULL AND next_attempt_at <= ? AND id IN (?, ?, ?)`,
        [T1, due.id, later.id, published.id],
      );
      expect(rows.map((row) => row.id)).toEqual([due.id]);

      const [plan] = await db.query(
        `SELECT indexdef AS definition FROM pg_indexes WHERE indexname = 'outbox_pending_due_idx'`,
      );
      expect(String(plan?.definition)).toContain(
        'WHERE (published_at IS NULL)',
      );
    });
  });
});
