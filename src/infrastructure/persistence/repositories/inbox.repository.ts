import type { EntityManager } from '@mikro-orm/postgresql';
import { ConcurrencyConflictError } from '../../../application/ports/persistence.errors.js';
import type {
  InboxReceipt,
  InboxRepository,
} from '../../../application/ports/persistence.js';
import type { InboxMessage } from '../../../domain/messaging/inbox-message.js';
import { fromInboxMessage, toInboxMessage } from '../mappers.js';
import { InboxMessageSchema } from '../schemas.js';

export class MikroOrmInboxRepository implements InboxRepository {
  constructor(private readonly em: EntityManager) {}

  async receive(message: InboxMessage): Promise<InboxReceipt> {
    const result = await this.em
      .createQueryBuilder(InboxMessageSchema)
      .insert(fromInboxMessage(message))
      .onConflict()
      .ignore()
      .execute('run');
    if (result.affectedRows === 1) {
      return { outcome: 'RECEIVED' };
    }
    const existing = await this.find(message.consumerName, message.messageId);
    if (existing === undefined) {
      throw new ConcurrencyConflictError(
        `inbox message ${message.messageId} conflicted without a visible owner`,
      );
    }
    return { outcome: 'DUPLICATE', existing };
  }

  async find(
    consumerName: string,
    messageId: string,
  ): Promise<InboxMessage | undefined> {
    const record = await this.em.findOne(
      InboxMessageSchema,
      { consumerName, messageId },
      { disableIdentityMap: true },
    );
    return record ? toInboxMessage(record) : undefined;
  }

  async markProcessed(message: InboxMessage): Promise<void> {
    const processedAt = message.processedAt;
    if (processedAt === undefined) {
      throw new ConcurrencyConflictError(
        `inbox message ${message.messageId} has not been processed`,
      );
    }
    const affected = await this.em.nativeUpdate(
      InboxMessageSchema,
      {
        consumerName: message.consumerName,
        messageId: message.messageId,
        processedAt: null,
      },
      { processedAt },
    );
    if (affected !== 1) {
      throw new ConcurrencyConflictError(
        `inbox message ${message.messageId} was already processed`,
      );
    }
  }
}
