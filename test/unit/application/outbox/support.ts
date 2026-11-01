import type {
  ClaimedOutboxMessage,
  ClaimRequest,
  EventTransport,
  OutboxBacklog,
  OutboxClaim,
  OutboxPublicationStore,
  OutgoingEvent,
} from '../../../../src/application/ports/outbox-publication.js';
import { WalletBalanceChanged } from '../../../../src/application/events/wagering-events.js';
import { OutboxMessage } from '../../../../src/domain/messaging/outbox-message.js';
import { Money } from '../../../../src/domain/money/money.js';
import { Wallet } from '../../../../src/domain/wallet/wallet.js';

let sequence = 0;

export function balanceChanged(
  walletId: string,
  amount = '25.00',
): OutboxMessage {
  sequence += 1;
  const at = new Date('2026-07-29T15:00:00.000Z');
  const { wallet } = Wallet.open({
    id: walletId,
    playerId: 'player-1',
    initialBalance: Money.from({ amount: '100.00', currency: 'BRL' }),
    at,
    opening: {
      entryId: `00000000-0000-7000-b000-${String(sequence).padStart(12, '0')}`,
      transactionId: `00000000-0000-7000-c000-${String(sequence).padStart(12, '0')}`,
    },
  });
  const entry = wallet.debit(Money.from({ amount, currency: 'BRL' }), {
    entryId: `00000000-0000-7000-9000-${String(sequence).padStart(12, '0')}`,
    transactionId: `00000000-0000-7000-a000-${String(sequence).padStart(12, '0')}`,
    at: new Date(at.getTime() + 1),
  });
  return OutboxMessage.enqueue(
    WalletBalanceChanged.from(wallet, entry, {
      eventId: `00000000-0000-7000-8000-${String(sequence).padStart(12, '0')}`,
      correlationId: `corr-${sequence}`,
      causationId: `msg-${sequence}`,
      occurredAt: new Date(at.getTime() + 1),
    }),
  );
}

export function rehydrated(
  base: OutboxMessage,
  payload: Record<string, unknown>,
): OutboxMessage {
  return OutboxMessage.rehydrate({
    id: base.id,
    aggregateId: base.aggregateId,
    eventType: base.eventType,
    payload,
    occurredAt: base.occurredAt,
    attempts: base.attempts,
    nextAttemptAt: base.nextAttemptAt,
  });
}

export function claimed(
  message: OutboxMessage,
  groupKey: string,
  previousOwner?: string,
): ClaimedOutboxMessage {
  return {
    message,
    groupKey,
    publishSequence: String(++sequence),
    previousOwner,
  };
}

export class FakeStore implements OutboxPublicationStore {
  groups: ClaimedOutboxMessage[][] = [];
  readonly requests: ClaimRequest[] = [];
  readonly confirmed: {
    id: string;
    token: string;
    transportMessageId: string;
  }[] = [];
  readonly rescheduled: {
    id: string;
    attempts: number;
    delayMs: number;
    error: string;
  }[] = [];
  readonly deadLettered: { id: string; error: string }[] = [];
  readonly released: string[] = [];
  confirmResult: boolean | Error = true;

  async claim(request: ClaimRequest): Promise<OutboxClaim> {
    this.requests.push(request);
    const groups = this.groups;
    this.groups = [];
    return {
      token: request.token,
      owner: request.owner,
      leaseMs: request.leaseMs,
      groups,
    };
  }

  async confirm(
    id: string,
    token: string,
    transportMessageId: string,
  ): Promise<boolean> {
    if (this.confirmResult instanceof Error) {
      throw this.confirmResult;
    }
    this.confirmed.push({ id, token, transportMessageId });
    return this.confirmResult;
  }

  async reschedule(
    message: OutboxMessage,
    _token: string,
    delayMs: number,
    error: string,
  ): Promise<boolean> {
    this.rescheduled.push({
      id: message.id,
      attempts: message.attempts,
      delayMs,
      error,
    });
    return true;
  }

  async deadLetter(
    id: string,
    _token: string,
    error: string,
  ): Promise<boolean> {
    this.deadLettered.push({ id, error });
    return true;
  }

  async release(ids: readonly string[]): Promise<void> {
    this.released.push(...ids);
  }

  async backlog(): Promise<OutboxBacklog> {
    return {
      pending: 0,
      due: 0,
      retrying: 0,
      leased: 0,
      expiredLeases: 0,
      published: 0,
      deadLettered: 0,
      oldestPendingAgeMs: undefined,
    };
  }
}

export class FakeTransport implements EventTransport {
  readonly sent: OutgoingEvent[] = [];
  failures = new Map<string, Error>();
  delayMs = 0;

  async publish(event: OutgoingEvent): Promise<{ transportMessageId: string }> {
    if (this.delayMs > 0) {
      await Bun.sleep(this.delayMs);
    }
    const failure = this.failures.get(event.eventId);
    if (failure !== undefined) {
      throw failure;
    }
    this.sent.push(event);
    return { transportMessageId: `sqs-${event.eventId}` };
  }
}
