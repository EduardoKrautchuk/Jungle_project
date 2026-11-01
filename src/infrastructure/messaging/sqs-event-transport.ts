import { SendMessageCommand, type SQSClient } from '@aws-sdk/client-sqs';
import {
  EventTransportError,
  type EventTransport,
  type OutgoingEvent,
  type TransportFailureKind,
} from '../../application/ports/outbox-publication.js';

const CONFIGURATION_ERRORS: ReadonlySet<string> = new Set([
  'QueueDoesNotExist',
  'AWS.SimpleQueueService.NonExistentQueue',
  'AccessDenied',
  'AccessDeniedException',
  'InvalidClientTokenId',
  'UnrecognizedClientException',
  'InvalidSecurity',
  'KmsAccessDenied',
  'KmsDisabled',
  'KmsNotFound',
]);

const REJECTED_ERRORS: ReadonlySet<string> = new Set([
  'InvalidMessageContents',
  'InvalidParameterValue',
  'MissingParameter',
  'InvalidAttributeValue',
]);

export class SqsEventTransport implements EventTransport {
  constructor(
    private readonly client: SQSClient,
    private readonly queueUrl: string,
  ) {}

  async publish(
    event: OutgoingEvent,
  ): Promise<{ readonly transportMessageId: string }> {
    let messageId: string | undefined;
    try {
      ({ MessageId: messageId } = await this.client.send(
        new SendMessageCommand({
          QueueUrl: this.queueUrl,
          MessageBody: event.body,
          MessageGroupId: event.groupKey,
          MessageDeduplicationId: event.eventId,
          MessageAttributes: {
            eventId: text(event.eventId),
            eventType: text(event.eventType),
            eventVersion: {
              DataType: 'Number',
              StringValue: String(event.version),
            },
            correlationId: text(event.correlationId),
          },
        }),
      ));
    } catch (error) {
      throw new EventTransportError(classify(error), codeOf(error), {
        cause: error,
      });
    }
    if (messageId === undefined) {
      throw new EventTransportError('TRANSIENT', 'MISSING_MESSAGE_ID');
    }
    return { transportMessageId: messageId };
  }
}

function text(value: string) {
  return { DataType: 'String', StringValue: value };
}

function codeOf(error: unknown): string {
  return error instanceof Error ? error.name : 'UNKNOWN_ERROR';
}

function classify(error: unknown): TransportFailureKind {
  const code = codeOf(error);
  if (CONFIGURATION_ERRORS.has(code)) {
    return 'CONFIGURATION';
  }
  if (REJECTED_ERRORS.has(code)) {
    return 'REJECTED';
  }
  return 'TRANSIENT';
}
