import type { OutboxMessage } from '../../domain/messaging/outbox-message.js';

export interface ClaimedOutboxMessage {
  readonly message: OutboxMessage;
  readonly groupKey: string;
  readonly publishSequence: string;
  readonly previousOwner: string | undefined;
}

export interface OutboxClaim {
  readonly token: string;
  readonly owner: string;
  readonly leaseMs: number;
  readonly groups: readonly (readonly ClaimedOutboxMessage[])[];
}

export interface ClaimRequest {
  readonly owner: string;
  readonly token: string;
  readonly leaseMs: number;
  readonly maxGroups: number;
  readonly maxPerGroup: number;
}

export interface OutboxBacklog {
  readonly pending: number;
  readonly due: number;
  readonly retrying: number;
  readonly leased: number;
  readonly expiredLeases: number;
  readonly published: number;
  readonly deadLettered: number;
  readonly oldestPendingAgeMs: number | undefined;
}

export interface OutboxPublicationStore {
  claim(request: ClaimRequest): Promise<OutboxClaim>;
  confirm(
    id: string,
    token: string,
    transportMessageId: string,
  ): Promise<boolean>;
  reschedule(
    message: OutboxMessage,
    token: string,
    delayMs: number,
    error: string,
  ): Promise<boolean>;
  deadLetter(id: string, token: string, error: string): Promise<boolean>;
  release(ids: readonly string[], token: string): Promise<void>;
  backlog(): Promise<OutboxBacklog>;
}

export type TransportFailureKind = 'TRANSIENT' | 'CONFIGURATION' | 'REJECTED';

export class EventTransportError extends Error {
  constructor(
    readonly kind: TransportFailureKind,
    readonly code: string,
    options?: ErrorOptions,
  ) {
    super(`event transport failed: ${code}`, options);
    this.name = 'EventTransportError';
  }
}

export interface OutgoingEvent {
  readonly eventId: string;
  readonly eventType: string;
  readonly version: number;
  readonly correlationId: string;
  readonly groupKey: string;
  readonly body: string;
}

export interface EventTransport {
  publish(
    event: OutgoingEvent,
  ): Promise<{ readonly transportMessageId: string }>;
}

export const OUTBOX_PUBLICATION_STORE = Symbol('OUTBOX_PUBLICATION_STORE');
export const EVENT_TRANSPORT = Symbol('EVENT_TRANSPORT');
