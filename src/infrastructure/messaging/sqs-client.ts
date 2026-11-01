import { GetQueueUrlCommand, SQSClient } from '@aws-sdk/client-sqs';
import type { SqsConfig } from '../config/sqs.config.js';

export interface WagerQueueUrls {
  readonly queueUrl: string;
  readonly deadLetterQueueUrl: string;
}

export function createSqsClient(
  config: SqsConfig,
  options: { maxAttempts?: number } = {},
): SQSClient {
  return new SQSClient({
    region: config.region,
    endpoint: config.endpoint,
    credentials: config.credentials,
    useQueueUrlAsEndpoint: config.endpoint === undefined,
    maxAttempts: options.maxAttempts ?? 3,
    requestHandler: {
      requestTimeout: config.requestTimeoutMs,
      connectionTimeout: Math.min(config.requestTimeoutMs, 5_000),
    },
  });
}

export async function resolveWagerQueueUrls(
  client: SQSClient,
  config: SqsConfig,
): Promise<WagerQueueUrls> {
  return {
    queueUrl: config.queueUrl ?? (await queueUrlOf(client, config.queueName)),
    deadLetterQueueUrl:
      config.deadLetterQueueUrl ??
      (await queueUrlOf(client, config.deadLetterQueueName)),
  };
}

async function queueUrlOf(client: SQSClient, name: string): Promise<string> {
  const { QueueUrl } = await client.send(
    new GetQueueUrlCommand({ QueueName: name }),
  );
  if (QueueUrl === undefined) {
    throw new Error(`queue ${name} has no URL`);
  }
  return QueueUrl;
}

export function resolveEventsQueueUrl(
  client: SQSClient,
  config: SqsConfig,
): Promise<string> {
  return config.eventsQueueUrl === undefined
    ? queueUrlOf(client, config.eventsQueueName)
    : Promise.resolve(config.eventsQueueUrl);
}
