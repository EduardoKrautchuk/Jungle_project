import {
  ChangeMessageVisibilityBatchCommand,
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  type Message,
  type SQSClient,
} from '@aws-sdk/client-sqs';
import type { WagerQueueUrls } from './sqs-client.js';
import {
  QueueUnavailableError,
  type DeadLetterDiagnostics,
  type QueueMessage,
  type WagerQueue,
} from './wager-queue.js';

export interface SqsWagerQueueOptions {
  readonly waitTimeSeconds: number;
  readonly maxMessages: number;
  readonly visibilityTimeoutSeconds: number;
}

const FALLBACK_GROUP_ID = 'dead-letter';
const MAX_VISIBILITY_TIMEOUT_SECONDS = 43_200;

function isExpiredFifoReceiptHandle(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.name === 'InvalidParameterValue' &&
    error.message.includes('receipt handle has expired')
  );
}

export class SqsWagerQueue implements WagerQueue {
  constructor(
    private readonly client: SQSClient,
    private readonly urls: WagerQueueUrls,
    private readonly options: SqsWagerQueueOptions,
  ) {}

  async receive(signal: AbortSignal): Promise<QueueMessage[]> {
    const response = await this.#call('receive', () =>
      this.client.send(
        new ReceiveMessageCommand({
          QueueUrl: this.urls.queueUrl,
          MaxNumberOfMessages: this.options.maxMessages,
          WaitTimeSeconds: this.options.waitTimeSeconds,
          VisibilityTimeout: this.options.visibilityTimeoutSeconds,
          MessageSystemAttributeNames: [
            'ApproximateReceiveCount',
            'MessageGroupId',
          ],
        }),
        { abortSignal: signal },
      ),
    );
    const receivedAtMs = Date.now();
    return (response.Messages ?? []).flatMap((message) =>
      toQueueMessage(message, receivedAtMs),
    );
  }

  async acknowledge(message: QueueMessage): Promise<void> {
    try {
      await this.#delete(message);
    } catch (error) {
      if (!isExpiredFifoReceiptHandle(error)) {
        throw new QueueUnavailableError('delete', { cause: error });
      }
      await this.retryLater(message, this.#visibilityCoveringReceipt(message));
      await this.#call('delete', () => this.#delete(message));
    }
  }

  async retryLater(message: QueueMessage, delaySeconds: number): Promise<void> {
    await this.#call('change-visibility', () =>
      this.client.send(
        new ChangeMessageVisibilityCommand({
          QueueUrl: this.urls.queueUrl,
          ReceiptHandle: message.receiptHandle,
          VisibilityTimeout: delaySeconds,
        }),
      ),
    );
  }

  async extendVisibility(
    message: QueueMessage,
    seconds: number,
  ): Promise<void> {
    await this.retryLater(message, seconds);
  }

  async release(messages: readonly QueueMessage[]): Promise<void> {
    if (messages.length === 0) {
      return;
    }
    await this.#call('release', () =>
      this.client.send(
        new ChangeMessageVisibilityBatchCommand({
          QueueUrl: this.urls.queueUrl,
          Entries: messages.map((message, index) => ({
            Id: String(index),
            ReceiptHandle: message.receiptHandle,
            VisibilityTimeout: 0,
          })),
        }),
      ),
    );
  }

  async deadLetter(
    message: QueueMessage,
    diagnostics: DeadLetterDiagnostics,
  ): Promise<void> {
    await this.#call('dead-letter', () =>
      this.client.send(
        new SendMessageCommand({
          QueueUrl: this.urls.deadLetterQueueUrl,
          MessageBody: message.body ?? '',
          MessageGroupId: message.groupId ?? FALLBACK_GROUP_ID,
          MessageDeduplicationId: message.sqsMessageId,
          MessageAttributes: {
            errorCode: text(diagnostics.errorCode),
            consumerName: text(diagnostics.consumerName),
            sourceMessageId: text(message.sqsMessageId),
            sourceReceiveCount: text(String(message.receiveCount)),
            ...(diagnostics.logicalMessageId === undefined
              ? {}
              : { logicalMessageId: text(diagnostics.logicalMessageId) }),
          },
        }),
      ),
    );
    await this.acknowledge(message);
  }

  #delete(message: QueueMessage): Promise<unknown> {
    return this.client.send(
      new DeleteMessageCommand({
        QueueUrl: this.urls.queueUrl,
        ReceiptHandle: message.receiptHandle,
      }),
    );
  }

  #visibilityCoveringReceipt(message: QueueMessage): number {
    const elapsedSeconds = Math.ceil(
      (Date.now() - message.receivedAtMs) / 1_000,
    );
    return Math.min(
      MAX_VISIBILITY_TIMEOUT_SECONDS,
      elapsedSeconds + this.options.visibilityTimeoutSeconds,
    );
  }

  async #call<T>(operation: string, send: () => Promise<T>): Promise<T> {
    try {
      return await send();
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw error;
      }
      throw new QueueUnavailableError(operation, { cause: error });
    }
  }
}

function text(value: string) {
  return { DataType: 'String', StringValue: value };
}

function toQueueMessage(
  message: Message,
  receivedAtMs: number,
): QueueMessage[] {
  if (message.MessageId === undefined || message.ReceiptHandle === undefined) {
    return [];
  }
  const receiveCount = Number(
    message.Attributes?.ApproximateReceiveCount ?? '1',
  );
  return [
    {
      sqsMessageId: message.MessageId,
      receiptHandle: message.ReceiptHandle,
      body: message.Body,
      receiveCount: Number.isSafeInteger(receiveCount) ? receiveCount : 1,
      groupId: message.Attributes?.MessageGroupId,
      receivedAtMs,
    },
  ];
}
