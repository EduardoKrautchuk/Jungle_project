import {
  assertNonEmptyString,
  assertSha256,
  assertValidDate,
} from './message-guards.js';
import { InvalidMessageStateError } from './messaging.errors.js';

export interface ReceiveInboxProps {
  messageId: string;
  consumerName: string;
  payloadHash: string;
  receivedAt: Date;
}

export interface InboxMessageState extends ReceiveInboxProps {
  processedAt?: Date;
}

export class InboxMessage {
  readonly messageId: string;
  readonly consumerName: string;
  readonly payloadHash: string;
  readonly #receivedAtMs: number;
  #processedAtMs: number | undefined;

  private constructor(state: InboxMessageState) {
    this.messageId = state.messageId;
    this.consumerName = state.consumerName;
    this.payloadHash = state.payloadHash;
    this.#receivedAtMs = state.receivedAt.getTime();
    this.#processedAtMs = state.processedAt?.getTime();
    Object.freeze(this);
  }

  static receive(props: ReceiveInboxProps): InboxMessage {
    InboxMessage.assertStructure(props);
    return new InboxMessage(props);
  }

  static rehydrate(state: InboxMessageState): InboxMessage {
    InboxMessage.assertStructure(state);
    if (state.processedAt !== undefined) {
      assertValidDate(state.processedAt, 'processedAt');
    }
    return new InboxMessage(state);
  }

  get receivedAt(): Date {
    return new Date(this.#receivedAtMs);
  }

  get processedAt(): Date | undefined {
    return this.#processedAtMs === undefined
      ? undefined
      : new Date(this.#processedAtMs);
  }

  isProcessed(): boolean {
    return this.#processedAtMs !== undefined;
  }

  matchesPayload(payloadHash: string): boolean {
    return this.payloadHash === payloadHash;
  }

  markProcessed(at: Date): void {
    assertValidDate(at, 'at');
    if (this.isProcessed()) {
      throw new InvalidMessageStateError('inbox message already processed');
    }
    if (at.getTime() < this.#receivedAtMs) {
      throw new InvalidMessageStateError(
        'processedAt must not precede receivedAt',
      );
    }
    this.#processedAtMs = at.getTime();
  }

  private static assertStructure(state: ReceiveInboxProps): void {
    assertNonEmptyString(state.messageId, 'messageId');
    assertNonEmptyString(state.consumerName, 'consumerName');
    assertSha256(state.payloadHash, 'payloadHash');
    assertValidDate(state.receivedAt, 'receivedAt');
  }
}
