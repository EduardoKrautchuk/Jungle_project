import { EntityManager } from '@mikro-orm/postgresql';
import {
  Inject,
  Injectable,
  Module,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { PublishOutboxBatch } from '../../application/outbox/publish-outbox-batch.js';
import {
  EVENT_TRANSPORT,
  OUTBOX_PUBLICATION_STORE,
  type EventTransport,
  type OutboxPublicationStore,
} from '../../application/ports/outbox-publication.js';
import {
  CLOCK,
  ID_GENERATOR,
  type Clock,
  type IdGenerator,
} from '../../application/ports/runtime.js';
import {
  loadOutboxPublisherConfig,
  type OutboxPublisherConfig,
} from '../config/outbox.config.js';
import { loadSqsConfig, type SqsConfig } from '../config/sqs.config.js';
import {
  createSqsClient,
  resolveEventsQueueUrl,
} from '../messaging/sqs-client.js';
import { SqsEventTransport } from '../messaging/sqs-event-transport.js';
import {
  JsonLinesLog,
  type StructuredLog,
} from '../observability/structured-log.js';
import { SqlOutboxPublicationStore } from '../persistence/outbox-publication.store.js';
import { SystemClock, UuidV7Generator } from '../runtime/system-runtime.js';
import { OutboxPublisherWorker } from './outbox-publisher-worker.js';
import { SQSClient } from '@aws-sdk/client-sqs';

export const PUBLISHER_SQS_CONFIG = Symbol('PUBLISHER_SQS_CONFIG');
export const OUTBOX_PUBLISHER_CONFIG = Symbol('OUTBOX_PUBLISHER_CONFIG');
export const PUBLISHER_LOG = Symbol('PUBLISHER_LOG');
export const EVENTS_QUEUE_URL = Symbol('EVENTS_QUEUE_URL');
export const PUBLISHER_SQS_CLIENT = Symbol('PUBLISHER_SQS_CLIENT');

@Injectable()
class PublisherSqsClientLifecycle implements OnApplicationShutdown {
  constructor(
    @Inject(PUBLISHER_SQS_CLIENT) private readonly client: SQSClient,
  ) {}

  onApplicationShutdown(): void {
    this.client.destroy();
  }
}

@Module({
  providers: [
    { provide: CLOCK, useClass: SystemClock },
    { provide: ID_GENERATOR, useClass: UuidV7Generator },
    {
      provide: PUBLISHER_SQS_CONFIG,
      useFactory: () => loadSqsConfig(process.env),
    },
    {
      provide: OUTBOX_PUBLISHER_CONFIG,
      inject: [PUBLISHER_SQS_CONFIG],
      useFactory: (sqs: SqsConfig) =>
        loadOutboxPublisherConfig(process.env, sqs.requestTimeoutMs),
    },
    {
      provide: PUBLISHER_SQS_CLIENT,
      inject: [PUBLISHER_SQS_CONFIG],
      useFactory: (config: SqsConfig) =>
        createSqsClient(config, { maxAttempts: 1 }),
    },
    PublisherSqsClientLifecycle,
    {
      provide: EVENTS_QUEUE_URL,
      inject: [PUBLISHER_SQS_CLIENT, PUBLISHER_SQS_CONFIG],
      useFactory: (client: SQSClient, config: SqsConfig) =>
        resolveEventsQueueUrl(client, config),
    },
    {
      provide: EVENT_TRANSPORT,
      inject: [PUBLISHER_SQS_CLIENT, EVENTS_QUEUE_URL],
      useFactory: (client: SQSClient, url: string) =>
        new SqsEventTransport(client, url),
    },
    {
      provide: OUTBOX_PUBLICATION_STORE,
      inject: [EntityManager],
      useFactory: (em: EntityManager) => new SqlOutboxPublicationStore(em),
    },
    {
      provide: PUBLISHER_LOG,
      useFactory: () => new JsonLinesLog('outbox-publisher'),
    },
    {
      provide: PublishOutboxBatch,
      inject: [
        OUTBOX_PUBLICATION_STORE,
        EVENT_TRANSPORT,
        CLOCK,
        ID_GENERATOR,
        OUTBOX_PUBLISHER_CONFIG,
        PUBLISHER_SQS_CONFIG,
      ],
      useFactory: (
        store: OutboxPublicationStore,
        transport: EventTransport,
        clock: Clock,
        ids: IdGenerator,
        config: OutboxPublisherConfig,
        sqs: SqsConfig,
      ) =>
        new PublishOutboxBatch(store, transport, clock, ids, {
          owner: config.publisherId,
          leaseMs: config.leaseMs,
          maxGroups: config.maxGroups,
          maxPerGroup: config.maxPerGroup,
          sendBudgetMs: sqs.requestTimeoutMs + 1_000,
        }),
    },
    {
      provide: OutboxPublisherWorker,
      inject: [PublishOutboxBatch, OUTBOX_PUBLISHER_CONFIG, PUBLISHER_LOG],
      useFactory: (
        batch: PublishOutboxBatch,
        config: OutboxPublisherConfig,
        log: StructuredLog,
      ) =>
        new OutboxPublisherWorker(
          batch,
          {
            publisherId: config.publisherId,
            idlePollMs: config.idlePollMs,
            errorBackoffMaxMs: config.errorBackoffMaxMs,
            shutdownGraceMs: config.shutdownGraceMs,
          },
          log,
        ),
    },
  ],
  exports: [
    OutboxPublisherWorker,
    PUBLISHER_LOG,
    OUTBOX_PUBLICATION_STORE,
    EVENT_TRANSPORT,
    OUTBOX_PUBLISHER_CONFIG,
  ],
})
export class OutboxPublisherModule {}
