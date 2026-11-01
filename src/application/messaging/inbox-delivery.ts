import { InboxMessage } from '../../domain/messaging/inbox-message.js';
import { MessagePayloadMismatchError } from '../application.errors.js';
import type { TransactionalRepositories } from '../ports/persistence.js';

export interface InboxDelivery {
  readonly consumerName: string;
  readonly messageId: string;
  readonly payloadHash: string;
}

export async function isAlreadyProcessed(
  repositories: TransactionalRepositories,
  delivery: InboxDelivery,
): Promise<boolean> {
  const existing = await repositories.inbox.find(
    delivery.consumerName,
    delivery.messageId,
  );
  if (existing === undefined) {
    return false;
  }
  assertSamePayload(existing, delivery);
  return existing.isProcessed();
}

export async function admitDelivery(
  repositories: TransactionalRepositories,
  delivery: InboxDelivery,
  now: Date,
): Promise<InboxMessage | undefined> {
  const incoming = InboxMessage.receive({ ...delivery, receivedAt: now });
  const receipt = await repositories.inbox.receive(incoming);
  if (receipt.outcome === 'RECEIVED') {
    return incoming;
  }
  assertSamePayload(receipt.existing, delivery);
  return receipt.existing.isProcessed() ? undefined : receipt.existing;
}

export async function completeDelivery(
  repositories: TransactionalRepositories,
  message: InboxMessage,
  now: Date,
): Promise<void> {
  message.markProcessed(
    new Date(Math.max(now.getTime(), message.receivedAt.getTime())),
  );
  await repositories.inbox.markProcessed(message);
}

function assertSamePayload(
  existing: InboxMessage,
  delivery: InboxDelivery,
): void {
  if (!existing.matchesPayload(delivery.payloadHash)) {
    throw new MessagePayloadMismatchError();
  }
}
