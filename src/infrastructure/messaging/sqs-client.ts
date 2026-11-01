import { GetQueueUrlCommand, SQSClient } from '@aws-sdk/client-sqs';
import type { SqsConfig } from '../config/sqs.config.js';

export interface WagerQueueUrls {
  readonly queueUrl: string;
  readonly deadLetterQueueUrl: string;
}

export function createSqsClient(config: SqsConfig): SQSClient {
  return new SQSClient({
    region: config.region,
    endpoint: config.endpoint,
    credentials: config.credentials,
    useQueueUrlAsEndpoint: config.endpoint === undefined,
    maxAttempts: 3,
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
