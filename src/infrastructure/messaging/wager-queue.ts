export interface QueueMessage {
  readonly sqsMessageId: string;
  readonly receiptHandle: string;
  readonly body: string | undefined;
  readonly receiveCount: number;
  readonly groupId: string | undefined;
  readonly receivedAtMs: number;
}

export interface DeadLetterDiagnostics {
  readonly errorCode: string;
  readonly consumerName: string;
  readonly logicalMessageId: string | undefined;
}

export interface WagerQueue {
  receive(signal: AbortSignal): Promise<QueueMessage[]>;
  acknowledge(message: QueueMessage): Promise<void>;
  retryLater(message: QueueMessage, delaySeconds: number): Promise<void>;
  extendVisibility(message: QueueMessage, seconds: number): Promise<void>;
  release(messages: readonly QueueMessage[]): Promise<void>;
  deadLetter(
    message: QueueMessage,
    diagnostics: DeadLetterDiagnostics,
  ): Promise<void>;
}

export class QueueUnavailableError extends Error {
  readonly code = 'SQS_UNAVAILABLE';

  constructor(operation: string, options?: ErrorOptions) {
    super(`SQS ${operation} failed`, options);
    this.name = 'QueueUnavailableError';
  }
}
