import { randomUUID } from 'node:crypto';
import {
  DeleteMessageBatchCommand,
  DeleteQueueCommand,
  ReceiveMessageCommand,
  type SQSClient,
} from '@aws-sdk/client-sqs';
import type { MikroORM } from '@mikro-orm/postgresql';
import { PublishOutboxBatch } from '../../src/application/outbox/publish-outbox-batch.js';
import type {
  EventTransport,
  OutgoingEvent,
} from '../../src/application/ports/outbox-publication.js';
import { SubmitWagerTransaction } from '../../src/application/wagering/submit-wager-transaction.js';
import { WagerSettlement } from '../../src/application/wagering/wager-settlement.js';
import { CreateWallet } from '../../src/application/wallets/create-wallet.js';
import {
  loadSqsConfig,
  type SqsConfig,
} from '../../src/infrastructure/config/sqs.config.js';
import { createSqsClient } from '../../src/infrastructure/messaging/sqs-client.js';
import { SqsEventTransport } from '../../src/infrastructure/messaging/sqs-event-transport.js';
import { ensureEventQueues } from '../../src/infrastructure/messaging/sqs-queue-provisioner.js';
import { OutboxPublisherWorker } from '../../src/infrastructure/outbox/outbox-publisher-worker.js';
import { MikroOrmUnitOfWork } from '../../src/infrastructure/persistence/mikro-orm-unit-of-work.js';
import { SqlOutboxPublicationStore } from '../../src/infrastructure/persistence/outbox-publication.store.js';
import {
  SystemClock,
  UuidV7Generator,
} from '../../src/infrastructure/runtime/system-runtime.js';
import type { Db } from '../integration/persistence/support.js';
import { MemoryLog } from '../messaging/support.js';

export interface EventQueues {
  readonly queueUrl: string;
  readonly deadLetterQueueUrl: string;
}

let queueSequence = 0;

export function sqsConfig(overrides: Partial<SqsConfig> = {}): SqsConfig {
  return { ...loadSqsConfig(process.env), ...overrides };
}

export async function createEventQueues(
  client: SQSClient,
): Promise<EventQueues> {
  const prefix = `jg-events-${process.pid}-${++queueSequence}-${randomUUID().slice(0, 8)}`;
  return ensureEventQueues(client, {
    queueName: `${prefix}.fifo`,
    deadLetterQueueName: `${prefix}-dlq.fifo`,
    maxReceiveCount: 5,
    visibilityTimeoutSeconds: 30,
    waitTimeSeconds: 1,
  });
}

export async function deleteEventQueues(
  client: SQSClient,
  queues: EventQueues,
): Promise<void> {
  await client.send(new DeleteQueueCommand({ QueueUrl: queues.queueUrl }));
  await client.send(
    new DeleteQueueCommand({ QueueUrl: queues.deadLetterQueueUrl }),
  );
}

export interface ReceivedEvent {
  readonly sqsMessageId: string;
  readonly groupId: string | undefined;
  readonly deduplicationId: string | undefined;
  readonly body: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly eventId: string;
  readonly attributes: Readonly<Record<string, string>>;
}

export async function drainEvents(
  client: SQSClient,
  queueUrl: string,
  options: { expected?: number; timeoutMs?: number; quietMs?: number } = {},
): Promise<ReceivedEvent[]> {
  const received: ReceivedEvent[] = [];
  const deadline = Date.now() + (options.timeoutMs ?? 20_000);
  let lastActivity = Date.now();
  const quietMs = options.quietMs ?? 1_500;
  while (Date.now() < deadline) {
    const response = await client.send(
      new ReceiveMessageCommand({
        QueueUrl: queueUrl,
        MaxNumberOfMessages: 10,
        WaitTimeSeconds: 1,
        VisibilityTimeout: 60,
        MessageAttributeNames: ['All'],
        MessageSystemAttributeNames: [
          'MessageGroupId',
          'MessageDeduplicationId',
        ],
      }),
    );
    const messages = response.Messages ?? [];
    for (const message of messages) {
      const payload: unknown = JSON.parse(message.Body ?? '{}');
      if (typeof payload !== 'object' || payload === null) {
        throw new Error('event body is not an object');
      }
      const record: Record<string, unknown> = { ...payload };
      const attributes: Record<string, string> = {};
      for (const [key, value] of Object.entries(
        message.MessageAttributes ?? {},
      )) {
        if (value.StringValue !== undefined) {
          attributes[key] = value.StringValue;
        }
      }
      received.push({
        sqsMessageId: message.MessageId ?? '',
        groupId: message.Attributes?.MessageGroupId,
        deduplicationId: message.Attributes?.MessageDeduplicationId,
        body: message.Body ?? '',
        payload: record,
        eventId: String(record.eventId),
        attributes,
      });
    }
    if (messages.length > 0) {
      lastActivity = Date.now();
      await client.send(
        new DeleteMessageBatchCommand({
          QueueUrl: queueUrl,
          Entries: messages.map((message, index) => ({
            Id: String(index),
            ReceiptHandle: message.ReceiptHandle ?? '',
          })),
        }),
      );
    }
    const enough =
      options.expected !== undefined && received.length >= options.expected;
    if (enough && Date.now() - lastActivity >= quietMs) {
      break;
    }
    if (
      options.expected === undefined &&
      Date.now() - lastActivity >= quietMs
    ) {
      break;
    }
  }
  return received;
}

export type TransportHook = (
  event: OutgoingEvent,
  phase: 'before' | 'after',
) => Promise<void> | void;

export class HookedTransport implements EventTransport {
  hook: TransportHook | undefined;
  readonly attempted: string[] = [];

  constructor(private readonly inner: EventTransport) {}

  async publish(event: OutgoingEvent): Promise<{ transportMessageId: string }> {
    this.attempted.push(event.eventId);
    await this.hook?.(event, 'before');
    const result = await this.inner.publish(event);
    await this.hook?.(event, 'after');
    return result;
  }
}

export interface PublisherHarness {
  readonly store: SqlOutboxPublicationStore;
  readonly transport: HookedTransport;
  readonly batch: PublishOutboxBatch;
  readonly worker: OutboxPublisherWorker;
  readonly log: MemoryLog;
  readonly client: SQSClient;
}

export function buildPublisher(
  orm: MikroORM,
  queueUrl: string,
  options: {
    owner?: string;
    leaseMs?: number;
    maxGroups?: number;
    maxPerGroup?: number;
    sqs?: Partial<SqsConfig>;
  } = {},
): PublisherHarness {
  const config = sqsConfig({ requestTimeoutMs: 1_500, ...options.sqs });
  const client = createSqsClient(config, { maxAttempts: 1 });
  const store = new SqlOutboxPublicationStore(orm.em);
  const transport = new HookedTransport(
    new SqsEventTransport(client, queueUrl),
  );
  const owner = options.owner ?? `test-publisher-${randomUUID().slice(0, 8)}`;
  const batch = new PublishOutboxBatch(
    store,
    transport,
    new SystemClock(),
    new UuidV7Generator(),
    {
      owner,
      leaseMs: options.leaseMs ?? 4_000,
      maxGroups: options.maxGroups ?? 10,
      maxPerGroup: options.maxPerGroup ?? 10,
      sendBudgetMs: 1_000,
    },
  );
  const log = new MemoryLog();
  const worker = new OutboxPublisherWorker(
    batch,
    {
      publisherId: owner,
      idlePollMs: 100,
      errorBackoffMaxMs: 500,
      shutdownGraceMs: 10_000,
    },
    log,
  );
  return { store, transport, batch, worker, log, client };
}

export async function runPublisherUntil(
  harness: PublisherHarness,
  condition: () => Promise<boolean>,
  timeoutMs = 20_000,
): Promise<void> {
  const running = harness.worker.start();
  try {
    await waitFor(condition, timeoutMs);
  } finally {
    await harness.worker.stop();
    await running;
  }
}

export async function waitFor(
  condition: () => Promise<boolean> | boolean,
  timeoutMs = 20_000,
  intervalMs = 100,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) {
      return;
    }
    await Bun.sleep(intervalMs);
  }
  throw new Error(`condition not met within ${timeoutMs}ms`);
}

export interface Financials {
  readonly create: CreateWallet;
  readonly submit: SubmitWagerTransaction;
}

export function financials(orm: MikroORM): Financials {
  const ids = new UuidV7Generator();
  const clock = new SystemClock();
  const uow = new MikroOrmUnitOfWork(orm.em);
  return {
    create: new CreateWallet(uow, clock, ids),
    submit: new SubmitWagerTransaction(
      uow,
      new WagerSettlement(ids),
      clock,
      ids,
    ),
  };
}

let idSequence = 0;

export async function walletWithBets(
  fin: Financials,
  bets: readonly string[],
  initial = '1000.00',
): Promise<string> {
  const wallet = await fin.create.execute({
    playerId: `player-${randomUUID()}`,
    initialBalance: { amount: initial, currency: 'BRL' },
    correlationId: 'corr-open',
  });
  for (const amount of bets) {
    const externalTransactionId = `ext-${Date.now().toString(36)}-${++idSequence}`;
    await fin.submit.execute({
      providerId: 'provider-a',
      externalTransactionId,
      idempotencyKey: `provider-a:${externalTransactionId}`,
      correlationId: `corr-${externalTransactionId}`,
      playerId: wallet.playerId,
      walletId: wallet.id,
      roundId: 'round-1',
      gameId: 'fortune-chimp',
      kind: 'BET',
      money: { amount, currency: 'BRL' },
    });
  }
  return wallet.id;
}

export async function count(
  db: Db,
  sql: string,
  params: unknown[] = [],
): Promise<number> {
  const [row] = await db.query(`SELECT count(*)::int AS n FROM ${sql}`, params);
  return Number(row?.n);
}

export async function financialFingerprint(db: Db): Promise<string> {
  const [row] = await db.query(`
    SELECT md5(
      coalesce((SELECT string_agg(id::text || balance::text || version::text || updated_at::text, ',' ORDER BY id) FROM wallets), '') ||
      coalesce((SELECT string_agg(id::text || amount::text || balance_after::text, ',' ORDER BY id) FROM wallet_ledger_entries), '') ||
      coalesce((SELECT string_agg(id::text || status || coalesce(result_balance::text, ''), ',' ORDER BY id) FROM wager_transactions), '')
    ) AS fingerprint`);
  return String(row?.fingerprint);
}

export async function outboxOrder(db: Db): Promise<Map<string, string[]>> {
  const rows = await db.query(
    'SELECT id, group_key FROM outbox_messages ORDER BY publish_sequence',
  );
  const order = new Map<string, string[]>();
  for (const row of rows) {
    const key = String(row.group_key);
    order.set(key, [...(order.get(key) ?? []), String(row.id)]);
  }
  return order;
}

export function receivedOrder(
  events: readonly ReceivedEvent[],
): Map<string, string[]> {
  const order = new Map<string, string[]>();
  for (const event of events) {
    const key = event.groupId ?? '';
    const list = order.get(key) ?? [];
    if (!list.includes(event.eventId)) {
      list.push(event.eventId);
    }
    order.set(key, list);
  }
  return order;
}
