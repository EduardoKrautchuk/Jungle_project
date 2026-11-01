import { LockMode, type EntityManager } from '@mikro-orm/postgresql';
import { ConcurrencyConflictError } from '../../../application/ports/persistence.errors.js';
import type { OutboxRepository } from '../../../application/ports/persistence.js';
import type { OutboxMessage } from '../../../domain/messaging/outbox-message.js';
import { fromOutboxMessage, toOutboxMessage } from '../mappers.js';
import { OutboxMessageSchema } from '../schemas.js';

export class MikroOrmOutboxRepository implements OutboxRepository {
  constructor(private readonly em: EntityManager) {}

  async enqueue(message: OutboxMessage): Promise<void> {
    await this.em.insert(OutboxMessageSchema, fromOutboxMessage(message));
  }

  async findById(id: string): Promise<OutboxMessage | undefined> {
    const record = await this.em.findOne(
      OutboxMessageSchema,
      { id },
      { disableIdentityMap: true },
    );
    return record ? toOutboxMessage(record) : undefined;
  }

  async lockDue(now: Date, limit: number): Promise<OutboxMessage[]> {
    const records = await this.em.find(
      OutboxMessageSchema,
      { publishedAt: null, nextAttemptAt: { $lte: now } },
      {
        orderBy: { nextAttemptAt: 'asc', occurredAt: 'asc', id: 'asc' },
        limit,
        lockMode: LockMode.PESSIMISTIC_PARTIAL_WRITE,
        disableIdentityMap: true,
      },
    );
    return records.map(toOutboxMessage);
  }

  async save(message: OutboxMessage): Promise<void> {
    const record = fromOutboxMessage(message);
    const affected = await this.em.nativeUpdate(
      OutboxMessageSchema,
      { id: record.id, publishedAt: null },
      {
        attempts: record.attempts,
        nextAttemptAt: record.nextAttemptAt,
        publishedAt: record.publishedAt,
      },
    );
    if (affected !== 1) {
      throw new ConcurrencyConflictError(
        `outbox message ${record.id} was already published`,
      );
    }
  }
}
