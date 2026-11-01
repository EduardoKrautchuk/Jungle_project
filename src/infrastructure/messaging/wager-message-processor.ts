import {
  IdempotencyConflictError,
  InvalidRequestError,
  MessagePayloadMismatchError,
} from '../../application/application.errors.js';
import {
  ConcurrencyConflictError,
  PersistenceUnavailableError,
} from '../../application/ports/persistence.errors.js';
import type { SubmitWagerTransaction } from '../../application/wagering/submit-wager-transaction.js';
import { WagerTransactionStatus } from '../../domain/wagering/wager-transaction.enums.js';
import {
  inboxDeliveryOf,
  MalformedMessageError,
  parseWagerMessage,
  type WagerTransactionRequested,
} from './wager-message.js';
import type { QueueMessage } from './wager-queue.js';

export type ProcessingResult =
  | 'PROCESSED'
  | 'REJECTED'
  | 'PENDING_REFERENCE'
  | 'REPLAYED'
  | 'DUPLICATE_MESSAGE';

export interface MessageContext {
  readonly messageId: string | undefined;
  readonly correlationId: string | undefined;
  readonly kind: string | undefined;
  readonly providerId: string | undefined;
  readonly walletId: string | undefined;
}

export type ProcessingOutcome =
  | {
      readonly action: 'ACKNOWLEDGE';
      readonly result: ProcessingResult;
      readonly transactionId: string | undefined;
      readonly failureCode: string | undefined;
      readonly context: MessageContext;
    }
  | {
      readonly action: 'RETRY' | 'DEAD_LETTER';
      readonly errorCode: string;
      readonly errorName?: string;
      readonly context: MessageContext;
    };

const EMPTY_CONTEXT: MessageContext = {
  messageId: undefined,
  correlationId: undefined,
  kind: undefined,
  providerId: undefined,
  walletId: undefined,
};

export class WagerMessageProcessor {
  constructor(
    private readonly submit: SubmitWagerTransaction,
    private readonly consumerName: string,
  ) {}

  async process(message: QueueMessage): Promise<ProcessingOutcome> {
    let parsed: WagerTransactionRequested;
    try {
      parsed = parseWagerMessage(message.body);
    } catch (error) {
      return failure(error, EMPTY_CONTEXT);
    }
    const context: MessageContext = {
      messageId: parsed.messageId,
      correlationId: parsed.correlationId,
      kind: parsed.command.kind,
      providerId: parsed.command.providerId,
      walletId: parsed.command.walletId,
    };
    try {
      const submission = await this.submit.executeMessage(
        parsed.command,
        inboxDeliveryOf(parsed, this.consumerName),
      );
      if (submission.outcome === 'DUPLICATE_MESSAGE') {
        return {
          action: 'ACKNOWLEDGE',
          result: 'DUPLICATE_MESSAGE',
          transactionId: undefined,
          failureCode: undefined,
          context,
        };
      }
      const { result } = submission;
      return {
        action: 'ACKNOWLEDGE',
        result: result.idempotentReplay ? 'REPLAYED' : resultOf(result.status),
        transactionId: result.transactionId,
        failureCode: result.failureCode,
        context,
      };
    } catch (error) {
      return failure(error, context);
    }
  }
}

function resultOf(status: WagerTransactionStatus): ProcessingResult {
  if (status === WagerTransactionStatus.Processed) {
    return 'PROCESSED';
  }
  if (status === WagerTransactionStatus.PendingReference) {
    return 'PENDING_REFERENCE';
  }
  return 'REJECTED';
}

function failure(error: unknown, context: MessageContext): ProcessingOutcome {
  if (error instanceof MalformedMessageError) {
    return { action: 'DEAD_LETTER', errorCode: error.code, context };
  }
  if (
    error instanceof InvalidRequestError ||
    error instanceof IdempotencyConflictError ||
    error instanceof MessagePayloadMismatchError
  ) {
    return { action: 'DEAD_LETTER', errorCode: error.code, context };
  }
  if (
    error instanceof ConcurrencyConflictError ||
    error instanceof PersistenceUnavailableError
  ) {
    return { action: 'RETRY', errorCode: error.code, context };
  }
  return {
    action: 'RETRY',
    errorCode: 'UNEXPECTED_ERROR',
    errorName: error instanceof Error ? error.name : typeof error,
    context,
  };
}
