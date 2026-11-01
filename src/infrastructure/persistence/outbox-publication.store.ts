import type { EntityManager } from '@mikro-orm/postgresql';
import type {
  ClaimedOutboxMessage,
  ClaimRequest,
  OutboxBacklog,
  OutboxClaim,
  OutboxPublicationStore,
} from '../../application/ports/outbox-publication.js';
import { OutboxMessage } from '../../domain/messaging/outbox-message.js';
import { translateDatabaseError } from './database-errors.js';
import { PersistenceMappingError } from './mappers.js';

const MAX_ERROR_LENGTH = 1_000;

const CLAIM_SQL = `
  WITH heads AS (
    SELECT o.id, o.group_key
      FROM outbox_messages o
     WHERE o.published_at IS NULL
       AND o.dead_lettered_at IS NULL
       AND o.next_attempt_at <= now()
       AND (o.lease_expires_at IS NULL OR o.lease_expires_at <= now())
       AND NOT EXISTS (
         SELECT 1 FROM outbox_messages p
          WHERE p.group_key = o.group_key
            AND p.published_at IS NULL
            AND p.dead_lettered_at IS NULL
            AND p.publish_sequence < o.publish_sequence
       )
     ORDER BY o.next_attempt_at, o.publish_sequence
     LIMIT ?
     FOR UPDATE OF o SKIP LOCKED
  ),
  members AS (
    SELECT m.id,
           m.lease_owner AS previous_owner,
           row_number() OVER (PARTITION BY m.group_key ORDER BY m.publish_sequence) AS position
      FROM outbox_messages m
      JOIN heads h ON h.group_key = m.group_key
     WHERE m.published_at IS NULL
       AND m.dead_lettered_at IS NULL
  )
  UPDATE outbox_messages t
     SET lease_owner = ?,
         lease_token = ?,
         lease_expires_at = now() + (? * interval '1 millisecond')
    FROM members
   WHERE t.id = members.id
     AND members.position <= ?
  RETURNING t.id, t.aggregate_id, t.event_type, t.payload, t.occurred_at,
            t.attempts, t.next_attempt_at, t.group_key,
            t.publish_sequence::text AS publish_sequence,
            members.previous_owner`;

const CONFIRM_SQL = `
  UPDATE outbox_messages
     SET published_at = greatest(now(), occurred_at),
         attempts = attempts + 1,
         last_attempt_at = now(),
         last_error = NULL,
         transport_message_id = ?,
         lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL
   WHERE id = ? AND lease_token = ?
     AND published_at IS NULL AND dead_lettered_at IS NULL`;

const RESCHEDULE_SQL = `
  UPDATE outbox_messages
     SET attempts = ?,
         next_attempt_at = now() + (? * interval '1 millisecond'),
         last_attempt_at = now(),
         last_error = ?,
         lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL
   WHERE id = ? AND lease_token = ?
     AND published_at IS NULL AND dead_lettered_at IS NULL`;

const DEAD_LETTER_SQL = `
  UPDATE outbox_messages
     SET dead_lettered_at = now(),
         attempts = attempts + 1,
         last_attempt_at = now(),
         last_error = ?,
         lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL
   WHERE id = ? AND lease_token = ?
     AND published_at IS NULL AND dead_lettered_at IS NULL`;

const BACKLOG_SQL = `
  SELECT
    count(*) FILTER (WHERE published_at IS NULL AND dead_lettered_at IS NULL)::int AS pending,
    count(*) FILTER (WHERE published_at IS NULL AND dead_lettered_at IS NULL
                       AND next_attempt_at <= now()
                       AND (lease_expires_at IS NULL OR lease_expires_at <= now()))::int AS due,
    count(*) FILTER (WHERE published_at IS NULL AND dead_lettered_at IS NULL AND attempts > 0)::int AS retrying,
    count(*) FILTER (WHERE lease_expires_at > now())::int AS leased,
    count(*) FILTER (WHERE lease_expires_at <= now())::int AS expired_leases,
    count(*) FILTER (WHERE published_at IS NOT NULL)::int AS published,
    count(*) FILTER (WHERE dead_lettered_at IS NOT NULL)::int AS dead_lettered,
    floor(extract(epoch FROM now() - min(occurred_at)
      FILTER (WHERE published_at IS NULL AND dead_lettered_at IS NULL)) * 1000)::bigint::text AS oldest_pending_age_ms
  FROM outbox_messages`;

type Row = Readonly<Record<string, unknown>>;

export class SqlOutboxPublicationStore implements OutboxPublicationStore {
  constructor(private readonly em: EntityManager) {}

  async claim(request: ClaimRequest): Promise<OutboxClaim> {
    const rows = await this.#query(CLAIM_SQL, [
      request.maxGroups,
      request.owner,
      request.token,
      request.leaseMs,
      request.maxPerGroup,
    ]);
    const claimed = rows.map(toClaimed).sort(bySequence);
    const groups = new Map<string, ClaimedOutboxMessage[]>();
    for (const item of claimed) {
      const group = groups.get(item.groupKey);
      if (group === undefined) {
        groups.set(item.groupKey, [item]);
      } else {
        group.push(item);
      }
    }
    return {
      token: request.token,
      owner: request.owner,
      leaseMs: request.leaseMs,
      groups: [...groups.values()],
    };
  }

  async confirm(
    id: string,
    token: string,
    transportMessageId: string,
  ): Promise<boolean> {
    return (
      (await this.#update(CONFIRM_SQL, [transportMessageId, id, token])) === 1
    );
  }

  async reschedule(
    message: OutboxMessage,
    token: string,
    delayMs: number,
    error: string,
  ): Promise<boolean> {
    return (
      (await this.#update(RESCHEDULE_SQL, [
        message.attempts,
        Math.max(0, Math.round(delayMs)),
        truncate(error),
        message.id,
        token,
      ])) === 1
    );
  }

  async deadLetter(id: string, token: string, error: string): Promise<boolean> {
    return (
      (await this.#update(DEAD_LETTER_SQL, [truncate(error), id, token])) === 1
    );
  }

  async release(ids: readonly string[], token: string): Promise<void> {
    if (ids.length === 0) {
      return;
    }
    await this.#update(
      `UPDATE outbox_messages
          SET lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL
        WHERE lease_token = ? AND id IN (${ids.map(() => '?').join(', ')})`,
      [token, ...ids],
    );
  }

  async backlog(): Promise<OutboxBacklog> {
    const [row] = await this.#query(BACKLOG_SQL, []);
    const oldest = row?.oldest_pending_age_ms;
    return {
      pending: integer(row?.pending),
      due: integer(row?.due),
      retrying: integer(row?.retrying),
      leased: integer(row?.leased),
      expiredLeases: integer(row?.expired_leases),
      published: integer(row?.published),
      deadLettered: integer(row?.dead_lettered),
      oldestPendingAgeMs:
        typeof oldest === 'string' ? Number(oldest) : undefined,
    };
  }

  async #query(sql: string, params: readonly unknown[]): Promise<Row[]> {
    try {
      const rows: unknown = await this.em
        .getConnection()
        .execute(sql, [...params], 'all');
      if (!Array.isArray(rows)) {
        throw new PersistenceMappingError('expected a row list');
      }
      return rows.filter(isRow);
    } catch (error) {
      throw translateDatabaseError(error);
    }
  }

  async #update(sql: string, params: readonly unknown[]): Promise<number> {
    try {
      const result: unknown = await this.em
        .getConnection()
        .execute(sql, [...params], 'run');
      if (
        typeof result === 'object' &&
        result !== null &&
        'affectedRows' in result &&
        typeof result.affectedRows === 'number'
      ) {
        return result.affectedRows;
      }
      throw new PersistenceMappingError('expected an affected row count');
    } catch (error) {
      throw translateDatabaseError(error);
    }
  }
}

function isRow(value: unknown): value is Row {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function integer(value: unknown): number {
  return typeof value === 'number' ? value : Number(value ?? 0);
}

function truncate(error: string): string {
  return error.slice(0, MAX_ERROR_LENGTH);
}

function date(value: unknown, field: string): Date {
  const parsed =
    value instanceof Date
      ? value
      : typeof value === 'string'
        ? new Date(value)
        : undefined;
  if (parsed === undefined || Number.isNaN(parsed.getTime())) {
    throw new PersistenceMappingError(`${field} is not a timestamp`);
  }
  return parsed;
}

function text(value: unknown, field: string): string {
  if (typeof value !== 'string') {
    throw new PersistenceMappingError(`${field} is not text`);
  }
  return value;
}

function payloadOf(value: unknown): Record<string, unknown> {
  const parsed: unknown = typeof value === 'string' ? JSON.parse(value) : value;
  if (!isRow(parsed)) {
    throw new PersistenceMappingError('payload is not a JSON object');
  }
  return { ...parsed };
}

function toClaimed(row: Row): ClaimedOutboxMessage {
  return {
    message: OutboxMessage.rehydrate({
      id: text(row.id, 'id'),
      aggregateId: text(row.aggregate_id, 'aggregate_id'),
      eventType: text(row.event_type, 'event_type'),
      payload: payloadOf(row.payload),
      occurredAt: date(row.occurred_at, 'occurred_at'),
      attempts: integer(row.attempts),
      nextAttemptAt: date(row.next_attempt_at, 'next_attempt_at'),
    }),
    groupKey: text(row.group_key, 'group_key'),
    publishSequence: text(row.publish_sequence, 'publish_sequence'),
    previousOwner:
      typeof row.previous_owner === 'string' ? row.previous_owner : undefined,
  };
}

function bySequence(
  left: ClaimedOutboxMessage,
  right: ClaimedOutboxMessage,
): number {
  const a = BigInt(left.publishSequence);
  const b = BigInt(right.publishSequence);
  return a < b ? -1 : a > b ? 1 : 0;
}
