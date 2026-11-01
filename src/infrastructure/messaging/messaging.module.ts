import { SQSClient } from '@aws-sdk/client-sqs';
import {
  Inject,
  Injectable,
  Module,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { SubmitWagerTransaction } from '../../application/wagering/submit-wager-transaction.js';
import { WageringModule } from '../application/wagering.module.js';
import { loadSqsConfig, type SqsConfig } from '../config/sqs.config.js';
import {
  JsonLinesLog,
  type StructuredLog,
} from '../observability/structured-log.js';
import { MeteredLog } from '../observability/metered-log.js';
import type { Metrics } from '../observability/metrics.js';
import {
  METRICS,
  ObservabilityModule,
} from '../observability/observability.module.js';
import { createSqsClient, resolveWagerQueueUrls } from './sqs-client.js';
import { SqsWagerConsumer } from './sqs-wager-consumer.js';
import { SqsWagerQueue } from './sqs-wager-queue.js';
import { WagerMessageProcessor } from './wager-message-processor.js';
import type { WagerQueue } from './wager-queue.js';

export const SQS_CONFIG = Symbol('SQS_CONFIG');
export const WAGER_QUEUE = Symbol('WAGER_QUEUE');
export const CONSUMER_LOG = Symbol('CONSUMER_LOG');

@Injectable()
class SqsClientLifecycle implements OnApplicationShutdown {
  constructor(@Inject(SQSClient) private readonly client: SQSClient) {}

  onApplicationShutdown(): void {
    this.client.destroy();
  }
}

@Module({
  imports: [WageringModule, ObservabilityModule],
  providers: [
    { provide: SQS_CONFIG, useFactory: () => loadSqsConfig(process.env) },
    {
      provide: SQSClient,
      inject: [SQS_CONFIG],
      useFactory: (config: SqsConfig) => createSqsClient(config),
    },
    SqsClientLifecycle,
    {
      provide: CONSUMER_LOG,
      inject: [METRICS],
      useFactory: (metrics: Metrics) =>
        new MeteredLog(new JsonLinesLog('wager-consumer'), metrics),
    },
    {
      provide: WAGER_QUEUE,
      inject: [SQSClient, SQS_CONFIG],
      useFactory: async (client: SQSClient, config: SqsConfig) =>
        new SqsWagerQueue(client, await resolveWagerQueueUrls(client, config), {
          waitTimeSeconds: config.waitTimeSeconds,
          maxMessages: config.maxMessages,
          visibilityTimeoutSeconds: config.visibilityTimeoutSeconds,
        }),
    },
    {
      provide: WagerMessageProcessor,
      inject: [SubmitWagerTransaction, SQS_CONFIG],
      useFactory: (submit: SubmitWagerTransaction, config: SqsConfig) =>
        new WagerMessageProcessor(submit, config.consumerName),
    },
    {
      provide: SqsWagerConsumer,
      inject: [WAGER_QUEUE, WagerMessageProcessor, SQS_CONFIG, CONSUMER_LOG],
      useFactory: (
        queue: WagerQueue,
        processor: WagerMessageProcessor,
        config: SqsConfig,
        log: StructuredLog,
      ) =>
        new SqsWagerConsumer(
          queue,
          processor,
          {
            consumerName: config.consumerName,
            visibilityTimeoutSeconds: config.visibilityTimeoutSeconds,
            maxReceiveCount: config.maxReceiveCount,
            retryBaseSeconds: config.retryBaseSeconds,
            retryMaxSeconds: config.retryMaxSeconds,
            shutdownGraceMs: config.shutdownGraceMs,
          },
          log,
        ),
    },
  ],
  exports: [SqsWagerConsumer, SQS_CONFIG, CONSUMER_LOG, ObservabilityModule],
})
export class MessagingModule {}
