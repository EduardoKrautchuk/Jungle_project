import { randomUUID } from 'node:crypto';
import {
  DeleteQueueCommand,
  GetQueueAttributesCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  type SQSClient,
} from '@aws-sdk/client-sqs';
import type { MikroORM } from '@mikro-orm/postgresql';
import { SubmitWagerTransaction } from '../../src/application/wagering/submit-wager-transaction.js';
import { WagerSettlement } from '../../src/application/wagering/wager-settlement.js';
import { CreateWallet } from '../../src/application/wallets/create-wallet.js';
import { loadSqsConfig } from '../../src/infrastructure/config/sqs.config.js';
import { createSqsClient } from '../../src/infrastructure/messaging/sqs-client.js';
import { ensureWagerQueues } from '../../src/infrastructure/messaging/sqs-queue-provisioner.js';
import {
  SqsWagerConsumer,
  type ConsumerOptions,
} from '../../src/infrastructure/messaging/sqs-wager-consumer.js';
import { SqsWagerQueue } from '../../src/infrastructure/messaging/sqs-wager-queue.js';
import { WagerMessageProcessor } from '../../src/infrastructure/messaging/wager-message-processor.js';
import type {
  DeadLetterDiagnostics,
  QueueMessage,
  WagerQueue,
} from '../../src/infrastructure/messaging/wager-queue.js';
import type {
  LogFields,
  LogLevel,
  StructuredLog,
} from '../../src/infrastructure/observability/structured-log.js';
import { MikroOrmUnitOfWork } from '../../src/infrastructure/persistence/mikro-orm-unit-of-work.js';
import {
  SystemClock,
  UuidV7Generator,
} from '../../src/infrastructure/runtime/system-runtime.js';
import { Db } from '../integration/persistence/support.js';

export const CONSUMER_NAME = 'wager-transactions-consumer';
export const VISIBILITY_TIMEOUT_SECONDS = 4;
export const MAX_RECEIVE_COUNT = 3;

export interface TestQueues {
  readonly queueName: string;
  readonly queueUrl: string;
  readonly deadLetterQueueUrl: string;
}

export function sqsClient(): SQSClient {
  return createSqsClient(loadSqsConfig(process.env));
}

let queueSequence = 0;

export async function createTestQueues(
  client: SQSClient,
  maxReceiveCount = MAX_RECEIVE_COUNT,
): Promise<TestQueues> {
  const prefix = `jg-test-${process.pid}-${++queueSequence}-${randomUUID().slice(0, 8)}`;
  const queueName = `${prefix}.fifo`;
  const urls = await ensureWagerQueues(client, {
    queueName,
    deadLetterQueueName: `${prefix}-dlq.fifo`,
    maxReceiveCount,
    visibilityTimeoutSeconds: VISIBILITY_TIMEOUT_SECONDS,
    waitTimeSeconds: 1,
  });
  return { queueName, ...urls };
}

export async function deleteTestQueues(
  client: SQSClient,
  queues: TestQueues,
): Promise<void> {
  await client.send(new DeleteQueueCommand({ QueueUrl: queues.queueUrl }));
  await client.send(
    new DeleteQueueCommand({ QueueUrl: queues.deadLetterQueueUrl }),
  );
}

export interface WalletRef {
  readonly id: string;
  readonly playerId: string;
}

export interface WagerData {
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: string;
  money: { amount: string; currency: string };
  referenceExternalTransactionId?: string;
}

let idSequence = 0;

export const uniqueId = (prefix: string): string =>
  `${prefix}-${Date.now().toString(36)}-${++idSequence}`;

export function wagerData(
  wallet: WalletRef,
  overrides: Partial<WagerData> = {},
): WagerData {
  const externalTransactionId =
    overrides.externalTransactionId ?? uniqueId('ext');
  return {
    providerId: 'provider-a',
    externalTransactionId,
    idempotencyKey: `provider-a:${externalTransactionId}`,
    playerId: wallet.playerId,
    walletId: wallet.id,
    roundId: 'round-1',
    gameId: 'fortune-chimp',
    kind: 'BET',
    money: { amount: '25.00', currency: 'BRL' },
    ...overrides,
  };
}

export interface Envelope {
  messageId: string;
  type: string;
  occurredAt: string;
  correlationId?: string;
  data: WagerData;
}

export function envelope(
  data: WagerData,
  overrides: Partial<Envelope> = {},
): Envelope {
  return {
    messageId: uniqueId('msg'),
    type: 'WagerTransactionRequested',
    occurredAt: '2026-07-29T15:00:00.000Z',
    data,
    ...overrides,
  };
}

export async function sendRaw(
  client: SQSClient,
  queues: TestQueues,
  body: string,
  options: { groupId?: string; deduplicationId?: string } = {},
): Promise<string> {
  const response = await client.send(
    new SendMessageCommand({
      QueueUrl: queues.queueUrl,
      MessageBody: body,
      MessageGroupId: options.groupId ?? 'group-default',
      MessageDeduplicationId: options.deduplicationId ?? randomUUID(),
    }),
  );
  if (response.MessageId === undefined) {
    throw new Error('SQS did not return a MessageId');
  }
  return response.MessageId;
}

export function send(
  client: SQSClient,
  queues: TestQueues,
  message: Envelope,
  options: { groupId?: string; deduplicationId?: string } = {},
): Promise<string> {
  return sendRaw(client, queues, JSON.stringify(message), {
    groupId: options.groupId ?? message.data.walletId,
    deduplicationId: options.deduplicationId,
  });
}

export async function queueDepth(
  client: SQSClient,
  url: string,
): Promise<{ visible: number; inFlight: number; delayed: number }> {
  const { Attributes } = await client.send(
    new GetQueueAttributesCommand({
      QueueUrl: url,
      AttributeNames: [
        'ApproximateNumberOfMessages',
        'ApproximateNumberOfMessagesNotVisible',
        'ApproximateNumberOfMessagesDelayed',
      ],
    }),
  );
  return {
    visible: Number(Attributes?.ApproximateNumberOfMessages ?? '0'),
    inFlight: Number(Attributes?.ApproximateNumberOfMessagesNotVisible ?? '0'),
    delayed: Number(Attributes?.ApproximateNumberOfMessagesDelayed ?? '0'),
  };
}

export interface DeadLetter {
  readonly body: string;
  readonly attributes: Readonly<Record<string, string>>;
}

export async function readDeadLetters(
  client: SQSClient,
  queues: TestQueues,
  expected: number,
  timeoutMs = 15_000,
): Promise<DeadLetter[]> {
  const found: DeadLetter[] = [];
  const deadline = Date.now() + timeoutMs;
  while (found.length < expected && Date.now() < deadline) {
    const response = await client.send(
      new ReceiveMessageCommand({
        QueueUrl: queues.deadLetterQueueUrl,
        MaxNumberOfMessages: 10,
        WaitTimeSeconds: 1,
        VisibilityTimeout: 60,
        MessageAttributeNames: ['All'],
      }),
    );
    for (const message of response.Messages ?? []) {
      const attributes: Record<string, string> = {};
      for (const [key, value] of Object.entries(
        message.MessageAttributes ?? {},
      )) {
        if (value.StringValue !== undefined) {
          attributes[key] = value.StringValue;
        }
      }
      found.push({ body: message.Body ?? '', attributes });
    }
  }
  return found;
}

export interface LogEntry {
  readonly level: LogLevel;
  readonly event: string;
  readonly fields: LogFields;
}

export class MemoryLog implements StructuredLog {
  readonly entries: LogEntry[] = [];

  write(level: LogLevel, event: string, fields: LogFields = {}): void {
    this.entries.push({ level, event, fields });
  }

  events(event: string): LogEntry[] {
    return this.entries.filter((entry) => entry.event === event);
  }
}

export class FaultyQueue implements WagerQueue {
  acknowledgeFailures = 0;
  acknowledgeAttempts = 0;
  readonly extensions: number[] = [];
  readonly received: QueueMessage[] = [];

  constructor(private readonly inner: WagerQueue) {}

  async receive(signal: AbortSignal): Promise<QueueMessage[]> {
    const messages = await this.inner.receive(signal);
    this.received.push(...messages);
    return messages;
  }

  async acknowledge(message: QueueMessage): Promise<void> {
    this.acknowledgeAttempts += 1;
    if (this.acknowledgeFailures > 0) {
      this.acknowledgeFailures -= 1;
      throw Object.assign(new Error('injected DeleteMessage failure'), {
        code: 'SQS_UNAVAILABLE',
      });
    }
    await this.inner.acknowledge(message);
  }

  retryLater(message: QueueMessage, delaySeconds: number): Promise<void> {
    return this.inner.retryLater(message, delaySeconds);
  }

  extendVisibility(message: QueueMessage, seconds: number): Promise<void> {
    this.extensions.push(seconds);
    return this.inner.extendVisibility(message, seconds);
  }

  release(messages: readonly QueueMessage[]): Promise<void> {
    return this.inner.release(messages);
  }

  deadLetter(
    message: QueueMessage,
    diagnostics: DeadLetterDiagnostics,
  ): Promise<void> {
    return this.inner.deadLetter(message, diagnostics);
  }
}

export interface Harness {
  readonly queue: FaultyQueue;
  readonly log: MemoryLog;
  readonly consumer: SqsWagerConsumer;
}

export function buildConsumer(
  orm: MikroORM,
  client: SQSClient,
  queues: TestQueues,
  overrides: Partial<ConsumerOptions> & { lockTimeoutMs?: number } = {},
): Harness {
  const ids = new UuidV7Generator();
  const uow = new MikroOrmUnitOfWork(orm.em, {
    lockTimeoutMs: overrides.lockTimeoutMs,
  });
  const submit = new SubmitWagerTransaction(
    uow,
    new WagerSettlement(ids),
    new SystemClock(),
    ids,
  );
  const queue = new FaultyQueue(
    new SqsWagerQueue(client, queues, {
      waitTimeSeconds: 1,
      maxMessages: 10,
      visibilityTimeoutSeconds: VISIBILITY_TIMEOUT_SECONDS,
    }),
  );
  const log = new MemoryLog();
  const consumer = new SqsWagerConsumer(
    queue,
    new WagerMessageProcessor(submit, CONSUMER_NAME),
    {
      consumerName: CONSUMER_NAME,
      visibilityTimeoutSeconds: VISIBILITY_TIMEOUT_SECONDS,
      maxReceiveCount: MAX_RECEIVE_COUNT,
      retryBaseSeconds: 1,
      retryMaxSeconds: 2,
      shutdownGraceMs: 15_000,
      receiveFailureBackoffMs: 200,
      receiveFailureBackoffMaxMs: 1_000,
      ...overrides,
    },
    log,
  );
  return { queue, log, consumer };
}

export async function waitUntil(
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

export async function consumeUntil(
  harness: Harness,
  condition: () => Promise<boolean> | boolean,
  timeoutMs = 20_000,
): Promise<void> {
  const running = harness.consumer.start();
  try {
    await waitUntil(condition, timeoutMs);
  } finally {
    await harness.consumer.stop();
    await running;
  }
}

export async function createWallet(
  orm: MikroORM,
  amount = '100.00',
): Promise<WalletRef> {
  const ids = new UuidV7Generator();
  const playerId = uniqueId('player');
  const wallet = await new CreateWallet(
    new MikroOrmUnitOfWork(orm.em),
    new SystemClock(),
    ids,
  ).execute({
    playerId,
    initialBalance: { amount, currency: 'BRL' },
    correlationId: 'corr-open',
  });
  return { id: wallet.id, playerId };
}

export async function scalar(
  db: Db,
  sql: string,
  params: unknown[] = [],
): Promise<number> {
  const [row] = await db.query(sql, params);
  return Number(row?.value);
}

export async function balanceOf(db: Db, walletId: string): Promise<string> {
  const [row] = await db.query(
    'SELECT balance::text AS balance FROM wallets WHERE id = ?',
    [walletId],
  );
  return String(row?.balance);
}

export async function inboxRow(db: Db, messageId: string) {
  const [row] = await db.query(
    `SELECT consumer_name, message_id, payload_hash,
            received_at, processed_at
       FROM inbox_messages WHERE message_id = ?`,
    [messageId],
  );
  return row;
}

export async function assertLedgerMatchesBalance(db: Db): Promise<string[]> {
  const rows = await db.query(`
    SELECT w.id FROM wallets w
     WHERE w.balance <> coalesce((
       SELECT sum(CASE direction WHEN 'CREDIT' THEN amount ELSE -amount END)
         FROM wallet_ledger_entries l WHERE l.wallet_id = w.id), 0)`);
  return rows.map((row) => String(row.id));
}

export const FAULT_SQL = {
  install: [
    'CREATE SEQUENCE IF NOT EXISTS messaging_fault_seq',
    `CREATE TABLE IF NOT EXISTS messaging_fault_config (
       id integer PRIMARY KEY,
       failures integer NOT NULL,
       sqlstate text NOT NULL
     )`,
    `CREATE OR REPLACE FUNCTION messaging_raise_fault() RETURNS trigger AS $$
     DECLARE
       config messaging_fault_config%ROWTYPE;
     BEGIN
       SELECT * INTO config FROM messaging_fault_config WHERE id = 1;
       IF FOUND AND nextval('messaging_fault_seq') <= config.failures THEN
         RAISE EXCEPTION 'injected messaging fault' USING ERRCODE = config.sqlstate;
       END IF;
       RETURN NEW;
     END
     $$ LANGUAGE plpgsql`,
    `CREATE OR REPLACE TRIGGER messaging_fault_outbox
       BEFORE INSERT ON outbox_messages
       FOR EACH ROW EXECUTE FUNCTION messaging_raise_fault()`,
  ],
  uninstall: [
    'DROP TRIGGER IF EXISTS messaging_fault_outbox ON outbox_messages',
    'DROP FUNCTION IF EXISTS messaging_raise_fault()',
    'DROP TABLE IF EXISTS messaging_fault_config',
    'DROP SEQUENCE IF EXISTS messaging_fault_seq',
  ],
};

export async function armFault(
  db: Db,
  failures: number,
  sqlstate = '40001',
): Promise<void> {
  await db.query('DELETE FROM messaging_fault_config');
  await db.query("SELECT setval('messaging_fault_seq', 1, false)");
  await db.query(
    'INSERT INTO messaging_fault_config (id, failures, sqlstate) VALUES (1, ?, ?)',
    [failures, sqlstate],
  );
}

export async function disarmFault(db: Db): Promise<void> {
  await db.query('DELETE FROM messaging_fault_config');
}
