import {
  GetQueueAttributesCommand,
  GetQueueUrlCommand,
  type SQSClient,
} from '@aws-sdk/client-sqs';
import type { OnApplicationShutdown } from '@nestjs/common';
import type { SqsConfig } from '../config/sqs.config.js';
import {
  DEFAULT_HEALTH_TIMEOUT_MS,
  type DependencyHealth,
} from '../observability/dependency-health.js';
import { withTimeout } from '../observability/with-timeout.js';

export class SqsHealthIndicator implements OnApplicationShutdown {
  readonly #urls = new Map<string, string>();

  constructor(
    private readonly client: SQSClient,
    private readonly config: SqsConfig,
    private readonly timeoutMs = DEFAULT_HEALTH_TIMEOUT_MS,
  ) {
    if (config.queueUrl !== undefined) {
      this.#urls.set(config.queueName, config.queueUrl);
    }
    if (config.deadLetterQueueUrl !== undefined) {
      this.#urls.set(config.deadLetterQueueName, config.deadLetterQueueUrl);
    }
    if (config.eventsQueueUrl !== undefined) {
      this.#urls.set(config.eventsQueueName, config.eventsQueueUrl);
    }
  }

  async check(): Promise<DependencyHealth> {
    try {
      await this.approximateMessages(this.config.queueName);
      return { status: 'up' };
    } catch (error) {
      return {
        status: 'down',
        reason: error instanceof Error ? error.name : 'unknown error',
      };
    }
  }

  approximateMessages(queueName: string): Promise<number> {
    return withTimeout(async (abortSignal) => {
      const { Attributes } = await this.client.send(
        new GetQueueAttributesCommand({
          QueueUrl: await this.#urlOf(queueName, abortSignal),
          AttributeNames: ['ApproximateNumberOfMessages'],
        }),
        { abortSignal },
      );
      return Number(Attributes?.ApproximateNumberOfMessages ?? 0);
    }, this.timeoutMs);
  }

  onApplicationShutdown(): void {
    this.client.destroy();
  }

  async #urlOf(queueName: string, abortSignal: AbortSignal): Promise<string> {
    const known = this.#urls.get(queueName);
    if (known !== undefined) {
      return known;
    }
    const { QueueUrl } = await this.client.send(
      new GetQueueUrlCommand({ QueueName: queueName }),
      { abortSignal },
    );
    if (QueueUrl === undefined) {
      throw new Error(`queue ${queueName} has no URL`);
    }
    this.#urls.set(queueName, QueueUrl);
    return QueueUrl;
  }
}
