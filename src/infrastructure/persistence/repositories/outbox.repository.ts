import type { EntityManager } from '@mikro-orm/postgresql';
import type { OutboxRepository } from '../../../application/ports/persistence.js';
import type { OutboxMessage } from '../../../domain/messaging/outbox-message.js';
import { fromOutboxMessage, toOutboxMessage } from '../mappers.js';
import { OutboxMessageSchema } from '../schemas.js';

export class MikroOrmOutboxRepository implements OutboxRepository {
  constructor(private readonly em: EntityManager) {}

  async enqueue(message: OutboxMessage): Promise<void> {
    await this.em.insert(OutboxMessageSchema, fromOutboxMessage(message));
  }

  async findLatestByAggregate(
    aggregateId: string,
  ): Promise<OutboxMessage | undefined> {
    const record = await this.em.findOne(
      OutboxMessageSchema,
      { aggregateId },
      { orderBy: { occurredAt: 'desc', id: 'desc' }, disableIdentityMap: true },
    );
    return record ? toOutboxMessage(record) : undefined;
  }
}
