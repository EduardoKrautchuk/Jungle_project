import {
  CreateQueueCommand,
  GetQueueAttributesCommand,
  GetQueueUrlCommand,
  QueueNameExists,
  SetQueueAttributesCommand,
  type SQSClient,
} from '@aws-sdk/client-sqs';
import type { WagerQueueUrls } from './sqs-client.js';

export interface WagerQueueDefinition {
  readonly queueName: string;
  readonly deadLetterQueueName: string;
  readonly maxReceiveCount: number;
  readonly visibilityTimeoutSeconds: number;
  readonly waitTimeSeconds: number;
}

const FOUR_DAYS_SECONDS = '345600';
const FOURTEEN_DAYS_SECONDS = '1209600';

export function ensureWagerQueues(
  client: SQSClient,
  definition: WagerQueueDefinition,
): Promise<WagerQueueUrls> {
  return ensureFifoQueuePair(client, definition);
}

export function ensureEventQueues(
  client: SQSClient,
  definition: WagerQueueDefinition,
): Promise<WagerQueueUrls> {
  return ensureFifoQueuePair(client, definition);
}

async function ensureFifoQueuePair(
  client: SQSClient,
  definition: WagerQueueDefinition,
): Promise<WagerQueueUrls> {
  const deadLetterQueueUrl = await createQueue(
    client,
    definition.deadLetterQueueName,
    {
      FifoQueue: 'true',
      ContentBasedDeduplication: 'false',
      MessageRetentionPeriod: FOURTEEN_DAYS_SECONDS,
    },
  );
  const { Attributes } = await client.send(
    new GetQueueAttributesCommand({
      QueueUrl: deadLetterQueueUrl,
      AttributeNames: ['QueueArn'],
    }),
  );
  const deadLetterTargetArn = Attributes?.QueueArn;
  if (deadLetterTargetArn === undefined) {
    throw new Error(`queue ${definition.deadLetterQueueName} has no ARN`);
  }
  const mutable = {
    ContentBasedDeduplication: 'false',
    VisibilityTimeout: String(definition.visibilityTimeoutSeconds),
    ReceiveMessageWaitTimeSeconds: String(definition.waitTimeSeconds),
    MessageRetentionPeriod: FOUR_DAYS_SECONDS,
    RedrivePolicy: JSON.stringify({
      deadLetterTargetArn,
      maxReceiveCount: String(definition.maxReceiveCount),
    }),
  };
  const queueUrl = await createQueue(client, definition.queueName, {
    FifoQueue: 'true',
    ...mutable,
  });
  await client.send(
    new SetQueueAttributesCommand({ QueueUrl: queueUrl, Attributes: mutable }),
  );
  return { queueUrl, deadLetterQueueUrl };
}

async function createQueue(
  client: SQSClient,
  name: string,
  attributes: Record<string, string>,
): Promise<string> {
  let QueueUrl: string | undefined;
  try {
    ({ QueueUrl } = await client.send(
      new CreateQueueCommand({ QueueName: name, Attributes: attributes }),
    ));
  } catch (error) {
    if (!(error instanceof QueueNameExists)) {
      throw error;
    }
    ({ QueueUrl } = await client.send(
      new GetQueueUrlCommand({ QueueName: name }),
    ));
  }
  if (QueueUrl === undefined) {
    throw new Error(`queue ${name} has no URL`);
  }
  return QueueUrl;
}
