import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  setDefaultTimeout,
} from 'bun:test';
import {
  GetQueueAttributesCommand,
  ReceiveMessageCommand,
  type SQSClient,
} from '@aws-sdk/client-sqs';
import { MikroORM } from '@mikro-orm/postgresql';
import { loadDatabaseConfig } from '../../src/infrastructure/config/database.config.js';
import { ensureWagerQueues } from '../../src/infrastructure/messaging/sqs-queue-provisioner.js';
import { SqsWagerQueue } from '../../src/infrastructure/messaging/sqs-wager-queue.js';
import { createMikroOrmConfig } from '../../src/infrastructure/persistence/mikro-orm.config.js';
import {
  Db,
  migrateFresh,
  openTestOrm,
} from '../integration/persistence/support.js';
import {
  armFault,
  assertLedgerMatchesBalance,
  balanceOf,
  buildConsumer,
  CONSUMER_NAME,
  consumeUntil,
  createTestQueues,
  createWallet,
  deleteTestQueues,
  disarmFault,
  envelope,
  FAULT_SQL,
  inboxRow,
  MAX_RECEIVE_COUNT,
  queueDepth,
  readDeadLetters,
  scalar,
  send,
  sendRaw,
  sqsClient,
  VISIBILITY_TIMEOUT_SECONDS,
  wagerData,
  waitUntil,
  type Harness,
  type TestQueues,
} from './support.js';
import { stack } from '../pending/support.js';
import { TcpProxy } from './tcp-proxy.js';

setDefaultTimeout(90_000);

let orm: MikroORM;
let db: Db;
let client: SQSClient;
let queues: TestQueues;

beforeAll(async () => {
  orm = await openTestOrm();
  await migrateFresh(orm);
  db = new Db(orm);
  for (const sql of FAULT_SQL.install) {
    await db.query(sql);
  }
  client = sqsClient();
});

afterAll(async () => {
  for (const sql of FAULT_SQL.uninstall) {
    await db.query(sql);
  }
  client.destroy();
  await orm.close(true);
});

beforeEach(async () => {
  queues = await createTestQueues(client);
});

afterEach(async () => {
  await disarmFault(db);
  await deleteTestQueues(client, queues);
  expect(await assertLedgerMatchesBalance(db)).toEqual([]);
});

const inboxProcessed = (messageId: string) => async () =>
  (await scalar(
    db,
    'SELECT count(*)::int AS value FROM inbox_messages WHERE message_id = ? AND processed_at IS NOT NULL',
    [messageId],
  )) === 1;

const queueEmpty = (url: string) => async () => {
  const depth = await queueDepth(client, url);
  return depth.visible + depth.inFlight + depth.delayed === 0;
};

async function transactionsOf(walletId: string) {
  return db.query(
    `SELECT id, kind, status, failure_code, external_transaction_id
       FROM wager_transactions WHERE wallet_id = ? AND kind <> 'OPENING'
      ORDER BY created_at`,
    [walletId],
  );
}

const debitCount = (walletId: string) =>
  scalar(
    db,
    "SELECT count(*)::int AS value FROM wallet_ledger_entries WHERE wallet_id = ? AND direction = 'DEBIT'",
    [walletId],
  );

const ledgerCount = (walletId: string) =>
  scalar(
    db,
    'SELECT count(*)::int AS value FROM wallet_ledger_entries WHERE wallet_id = ?',
    [walletId],
  );

const inboxCount = (messageId: string) =>
  scalar(
    db,
    'SELECT count(*)::int AS value FROM inbox_messages WHERE message_id = ?',
    [messageId],
  );

async function processAll(
  harness: Harness,
  messageIds: readonly string[],
): Promise<void> {
  await consumeUntil(harness, async () => {
    for (const messageId of messageIds) {
      if (!(await inboxProcessed(messageId)())) {
        return false;
      }
    }
    return queueEmpty(queues.queueUrl)();
  });
}

function results(harness: Harness): string[] {
  return harness.log
    .events('message.processed')
    .map((entry) => String(entry.fields.result));
}

describe('queue provisioning', () => {
  it('creates the FIFO queue and DLQ idempotently with the redrive policy', async () => {
    const definition = {
      queueName: queues.queueName,
      deadLetterQueueName: queues.queueName.replace('.fifo', '-dlq.fifo'),
      maxReceiveCount: MAX_RECEIVE_COUNT,
      visibilityTimeoutSeconds: VISIBILITY_TIMEOUT_SECONDS,
      waitTimeSeconds: 1,
    };
    const again = await ensureWagerQueues(client, definition);
    expect(again).toEqual({
      queueUrl: queues.queueUrl,
      deadLetterQueueUrl: queues.deadLetterQueueUrl,
    });

    const updated = await ensureWagerQueues(client, {
      ...definition,
      maxReceiveCount: 7,
    });
    expect(updated.queueUrl).toBe(queues.queueUrl);
    const { Attributes } = await client.send(
      new GetQueueAttributesCommand({
        QueueUrl: queues.queueUrl,
        AttributeNames: ['All'],
      }),
    );
    expect(Attributes?.FifoQueue).toBe('true');
    expect(Attributes?.ContentBasedDeduplication).toBe('false');
    expect(Attributes?.VisibilityTimeout).toBe(
      String(VISIBILITY_TIMEOUT_SECONDS),
    );
    const redrive: unknown = JSON.parse(Attributes?.RedrivePolicy ?? '{}');
    expect(redrive).toMatchObject({
      maxReceiveCount: '7',
      deadLetterTargetArn: expect.stringContaining('-dlq.fifo'),
    });
  });
});

describe('SQS transport', () => {
  it('sends and receives through the adapter keeping group, count and body', async () => {
    const body = JSON.stringify({ hello: 'world' });
    const sqsMessageId = await sendRaw(client, queues, body, {
      groupId: 'wallet-1',
    });
    const queue = new SqsWagerQueue(client, queues, {
      waitTimeSeconds: 1,
      maxMessages: 10,
      visibilityTimeoutSeconds: VISIBILITY_TIMEOUT_SECONDS,
    });
    const [message] = await queue.receive(new AbortController().signal);
    expect(message).toMatchObject({
      sqsMessageId,
      body,
      receiveCount: 1,
      groupId: 'wallet-1',
    });
    if (message === undefined) {
      throw new Error('expected a message');
    }
    await queue.acknowledge(message);
    await waitUntil(queueEmpty(queues.queueUrl));
  });

  it('drops a FIFO resend with the same MessageDeduplicationId at the broker', async () => {
    const wallet = await createWallet(orm);
    const message = envelope(wagerData(wallet));
    await send(client, queues, message, { deduplicationId: 'dedup-1' });
    await send(client, queues, message, { deduplicationId: 'dedup-1' });
    const harness = buildConsumer(orm, client, queues);
    await processAll(harness, [message.messageId]);
    expect(harness.queue.received).toHaveLength(1);
    expect(await debitCount(wallet.id)).toBe(1);
  });
});

describe('financial processing through SQS', () => {
  it('processes a BET with inbox, ledger, transaction and outbox in one commit', async () => {
    const wallet = await createWallet(orm);
    const message = envelope(wagerData(wallet), { correlationId: 'corr-bet' });
    await send(client, queues, message);
    const harness = buildConsumer(orm, client, queues);

    await processAll(harness, [message.messageId]);

    expect(await balanceOf(db, wallet.id)).toBe('75.00');
    const [transaction] = await transactionsOf(wallet.id);
    expect(transaction).toMatchObject({ kind: 'BET', status: 'PROCESSED' });
    const row = await inboxRow(db, message.messageId);
    expect(row).toMatchObject({ consumer_name: CONSUMER_NAME });
    expect(String(row?.payload_hash)).toMatch(/^[0-9a-f]{64}$/);
    expect(row?.processed_at).not.toBeNull();
    const [timing] = await db.query(
      `SELECT (i.processed_at >= i.received_at) AS ordered
         FROM inbox_messages i
         JOIN wager_transactions t ON t.id = ?
        WHERE i.message_id = ?`,
      [String(transaction?.id), message.messageId],
    );
    expect(timing).toMatchObject({ ordered: true });
    const events = await db.query(
      `SELECT event_type, payload->>'correlationId' AS correlation_id,
              payload->>'causationId' AS causation_id
         FROM outbox_messages WHERE aggregate_id IN (?, ?) ORDER BY event_type`,
      [String(transaction?.id), wallet.id],
    );
    expect(events.map((e) => e.event_type)).toContain(
      'WagerTransactionProcessed',
    );
    expect(events.filter((e) => e.correlation_id === 'corr-bet')).toHaveLength(
      2,
    );
    expect(
      events.filter((e) => e.causation_id === message.messageId),
    ).toHaveLength(2);
    expect(results(harness)).toEqual(['PROCESSED']);
    const [processed] = harness.log.events('message.processed');
    expect(processed?.fields).toMatchObject({
      consumerName: CONSUMER_NAME,
      messageId: message.messageId,
      correlationId: 'corr-bet',
      kind: 'BET',
      receiveCount: 1,
      acknowledged: true,
    });
    expect(typeof processed?.fields.durationMs).toBe('number');
    expect(JSON.stringify(harness.log.entries)).not.toContain('25.00');
  });

  it('processes WIN, LOSS, REFUND and ROLLBACK in FIFO order for one wallet', async () => {
    const wallet = await createWallet(orm);
    const bet = wagerData(wallet);
    const refundedBet = wagerData(wallet, { money: brl('10.00') });
    const win = wagerData(wallet, {
      kind: 'WIN',
      money: brl('40.00'),
      referenceExternalTransactionId: bet.externalTransactionId,
    });
    const loss = wagerData(wallet, { kind: 'LOSS', money: brl('0.00') });
    const refund = wagerData(wallet, {
      kind: 'REFUND',
      money: brl('10.00'),
      referenceExternalTransactionId: refundedBet.externalTransactionId,
    });
    const rollback = wagerData(wallet, {
      kind: 'ROLLBACK',
      money: brl('40.00'),
      referenceExternalTransactionId: win.externalTransactionId,
    });
    const messages = [bet, refundedBet, win, loss, refund, rollback].map(
      (data) => envelope(data),
    );
    for (const message of messages) {
      await send(client, queues, message);
    }
    const harness = buildConsumer(orm, client, queues);

    await processAll(
      harness,
      messages.map((m) => m.messageId),
    );

    const transactions = await transactionsOf(wallet.id);
    expect(transactions.map((t) => [t.kind, t.status, t.failure_code])).toEqual(
      [
        ['BET', 'PROCESSED', null],
        ['BET', 'PROCESSED', null],
        ['WIN', 'PROCESSED', null],
        ['LOSS', 'PROCESSED', null],
        ['REFUND', 'PROCESSED', null],
        ['ROLLBACK', 'PROCESSED', null],
      ],
    );
    expect(await balanceOf(db, wallet.id)).toBe('75.00');
    expect(await ledgerCount(wallet.id)).toBe(6);
    expect(results(harness)).toEqual([
      'PROCESSED',
      'PROCESSED',
      'PROCESSED',
      'PROCESSED',
      'PROCESSED',
      'PROCESSED',
    ]);
  });

  it('acknowledges a definitive financial rejection instead of retrying it', async () => {
    const wallet = await createWallet(orm, '10.00');
    const message = envelope(wagerData(wallet));
    await send(client, queues, message);
    const harness = buildConsumer(orm, client, queues);

    await processAll(harness, [message.messageId]);

    const [transaction] = await transactionsOf(wallet.id);
    expect(transaction).toMatchObject({
      status: 'REJECTED',
      failure_code: 'INSUFFICIENT_FUNDS',
    });
    expect(await balanceOf(db, wallet.id)).toBe('10.00');
    expect(results(harness)).toEqual(['REJECTED']);
    expect(harness.log.events('message.retry_scheduled')).toHaveLength(0);
    expect(await readDeadLetters(client, queues, 1, 2_000)).toHaveLength(0);
    expect(
      await scalar(
        db,
        "SELECT count(*)::int AS value FROM outbox_messages WHERE aggregate_id = ? AND event_type = 'WagerTransactionRejected'",
        [String(transaction?.id)],
      ),
    ).toBe(1);
  });

  it('parks a reversal without reference as PENDING_REFERENCE and acknowledges it', async () => {
    const wallet = await createWallet(orm);
    const message = envelope(
      wagerData(wallet, {
        kind: 'ROLLBACK',
        referenceExternalTransactionId: 'not-yet-arrived',
      }),
    );
    await send(client, queues, message);
    const harness = buildConsumer(orm, client, queues);
    await processAll(harness, [message.messageId]);
    const [transaction] = await transactionsOf(wallet.id);
    expect(transaction?.status).toBe('PENDING_REFERENCE');
    expect(results(harness)).toEqual(['PENDING_REFERENCE']);
    expect(await balanceOf(db, wallet.id)).toBe('100.00');
  });

  it('only enqueues events in the outbox without publishing them', async () => {
    const wallet = await createWallet(orm);
    const message = envelope(wagerData(wallet));
    await send(client, queues, message);
    const harness = buildConsumer(orm, client, queues);
    await processAll(harness, [message.messageId]);
    expect(
      await scalar(
        db,
        'SELECT count(*)::int AS value FROM outbox_messages WHERE published_at IS NOT NULL OR attempts > 0',
      ),
    ).toBe(0);
    expect(await queueDepth(client, queues.deadLetterQueueUrl)).toEqual({
      visible: 0,
      inFlight: 0,
      delayed: 0,
    });
  });
});

describe('deduplication', () => {
  it('treats a redelivered messageId as a no-op after durable confirmation', async () => {
    const wallet = await createWallet(orm);
    const message = envelope(wagerData(wallet));
    await send(client, queues, message);
    await send(client, queues, message);
    const harness = buildConsumer(orm, client, queues);

    await processAll(harness, [message.messageId]);

    expect(await debitCount(wallet.id)).toBe(1);
    expect(await inboxCount(message.messageId)).toBe(1);
    expect(results(harness).sort()).toEqual(['DUPLICATE_MESSAGE', 'PROCESSED']);
    expect(await balanceOf(db, wallet.id)).toBe('75.00');
  });

  it('dead-letters a known messageId carrying a different payload', async () => {
    const wallet = await createWallet(orm);
    const original = envelope(wagerData(wallet));
    const tampered = {
      ...original,
      data: { ...original.data, money: brl('99.00') },
    };
    await send(client, queues, original);
    await send(client, queues, tampered);
    const harness = buildConsumer(orm, client, queues);

    await consumeUntil(
      harness,
      async () =>
        (await inboxProcessed(original.messageId)()) &&
        harness.log.events('message.dead_lettered').length === 1,
    );

    const [deadLetter] = await readDeadLetters(client, queues, 1);
    expect(deadLetter?.attributes).toMatchObject({
      errorCode: 'MESSAGE_PAYLOAD_MISMATCH',
      consumerName: CONSUMER_NAME,
      logicalMessageId: original.messageId,
    });
    expect(deadLetter?.body).toBe(JSON.stringify(tampered));
    expect(await debitCount(wallet.id)).toBe(1);
    expect(await balanceOf(db, wallet.id)).toBe('75.00');
    const [row] = await db.query(
      'SELECT payload_hash FROM inbox_messages WHERE message_id = ?',
      [original.messageId],
    );
    expect(row?.payload_hash).toBeDefined();
    expect(await inboxCount(original.messageId)).toBe(1);
  });

  it('replays the same operation sent under different logical messageIds', async () => {
    const wallet = await createWallet(orm);
    const data = wagerData(wallet);
    const first = envelope(data);
    const second = envelope(data);
    await send(client, queues, first);
    await send(client, queues, second);
    const harness = buildConsumer(orm, client, queues);

    await processAll(harness, [first.messageId, second.messageId]);

    expect(await debitCount(wallet.id)).toBe(1);
    expect(await transactionsOf(wallet.id)).toHaveLength(1);
    expect(results(harness)).toEqual(['PROCESSED', 'REPLAYED']);
    expect(await inboxCount(first.messageId)).toBe(1);
    expect(await inboxCount(second.messageId)).toBe(1);
  });

  it('dead-letters an idempotency key reused with another financial payload', async () => {
    const wallet = await createWallet(orm);
    const data = wagerData(wallet);
    const first = envelope(data);
    const conflicting = envelope({ ...data, money: brl('30.00') });
    await send(client, queues, first);
    await send(client, queues, conflicting);
    const harness = buildConsumer(orm, client, queues);

    await consumeUntil(
      harness,
      () => harness.log.events('message.dead_lettered').length === 1,
    );

    const [deadLetter] = await readDeadLetters(client, queues, 1);
    expect(deadLetter?.attributes.errorCode).toBe('IDEMPOTENCY_CONFLICT');
    expect(await inboxCount(conflicting.messageId)).toBe(0);
    expect(await debitCount(wallet.id)).toBe(1);
  });

  it('lets two independent consumers race for one logical message without double effects', async () => {
    const wallet = await createWallet(orm);
    const message = envelope(wagerData(wallet));
    await send(client, queues, message, { groupId: 'race-a' });
    await send(client, queues, message, { groupId: 'race-b' });
    const secondOrm = await openTestOrm();
    try {
      const first = buildConsumer(orm, client, queues);
      const second = buildConsumer(secondOrm, client, queues);
      const runningA = first.consumer.start();
      const runningB = second.consumer.start();
      await waitUntil(
        async () =>
          (await inboxProcessed(message.messageId)()) &&
          (await queueEmpty(queues.queueUrl)()),
      );
      await Promise.all([first.consumer.stop(), second.consumer.stop()]);
      await Promise.all([runningA, runningB]);
      expect([...results(first), ...results(second)].sort()).toEqual([
        'DUPLICATE_MESSAGE',
        'PROCESSED',
      ]);
    } finally {
      await secondOrm.close(true);
    }
    expect(await debitCount(wallet.id)).toBe(1);
    expect(await inboxCount(message.messageId)).toBe(1);
  });
});

describe('replay after a pending reference is resolved', () => {
  it('acknowledges a redelivered REFUND as a replay of the settled result without a second credit', async () => {
    await db.query(
      `UPDATE wager_transactions SET next_reference_attempt_at = '2100-01-01T00:00:00Z'
        WHERE status = 'PENDING_REFERENCE'`,
    );
    const wallet = await createWallet(orm);
    const bet = wagerData(wallet);
    const refund = envelope(
      wagerData(wallet, {
        kind: 'REFUND',
        referenceExternalTransactionId: bet.externalTransactionId,
      }),
    );
    await send(client, queues, refund);
    const first = buildConsumer(orm, client, queues);
    await processAll(first, [refund.messageId]);
    expect(results(first)).toEqual(['PENDING_REFERENCE']);

    const betMessage = envelope(bet);
    await send(client, queues, betMessage);
    const second = buildConsumer(orm, client, queues);
    await processAll(second, [betMessage.messageId]);

    const pendingStack = stack(orm);
    pendingStack.clock.advance(10 * 60_000);
    const candidates = await pendingStack.resolver.listDue(10, 'sqs');
    const [candidate] = candidates;
    if (candidate === undefined || candidates.length !== 1) {
      throw new Error('expected exactly one pending candidate');
    }
    expect((await pendingStack.resolver.resolve(candidate)).result).toBe(
      'PROCESSED',
    );

    const redelivered = { ...refund, messageId: `${refund.messageId}-again` };
    await send(client, queues, redelivered);
    await send(client, queues, refund);
    const third = buildConsumer(orm, client, queues);
    await processAll(third, [redelivered.messageId, refund.messageId]);

    expect(results(third).sort()).toEqual(['DUPLICATE_MESSAGE', 'REPLAYED']);
    const replayed = third.log
      .events('message.processed')
      .find((entry) => entry.fields.result === 'REPLAYED');
    expect(replayed?.fields.failureCode).toBeUndefined();
    const [row] = await db.query(
      'SELECT status FROM wager_transactions WHERE external_transaction_id = ?',
      [refund.data.externalTransactionId],
    );
    expect(row?.status).toBe('PROCESSED');
    expect(
      await scalar(
        db,
        "SELECT count(*)::int AS value FROM wallet_ledger_entries WHERE wallet_id = ? AND direction = 'CREDIT'",
        [wallet.id],
      ),
    ).toBe(2);
    expect(await balanceOf(db, wallet.id)).toBe('100.00');
  });
});

describe('failures and acknowledgement', () => {
  it('rolls back inbox, wallet, ledger and transaction when the commit fails and retries later', async () => {
    const wallet = await createWallet(orm);
    const message = envelope(wagerData(wallet));
    await armFault(db, 1);
    await send(client, queues, message);
    const harness = buildConsumer(orm, client, queues);

    await consumeUntil(
      harness,
      () => harness.log.events('message.retry_scheduled').length === 1,
    );

    expect(
      harness.log.events('message.retry_scheduled')[0]?.fields,
    ).toMatchObject({
      errorCode: 'PERSISTENCE_CONCURRENCY_CONFLICT',
      receiveCount: 1,
      retryInSeconds: 1,
    });
    expect(await inboxCount(message.messageId)).toBe(0);
    expect(await transactionsOf(wallet.id)).toHaveLength(0);
    expect(await balanceOf(db, wallet.id)).toBe('100.00');
    expect(await ledgerCount(wallet.id)).toBe(1);
    expect(
      await scalar(
        db,
        'SELECT count(*)::int AS value FROM outbox_messages WHERE aggregate_id = ?',
        [wallet.id],
      ),
    ).toBe(1);

    const retry = buildConsumer(orm, client, queues);
    await processAll(retry, [message.messageId]);
    expect(results(retry)).toEqual(['PROCESSED']);
    expect(retry.log.events('message.processed')[0]?.fields.receiveCount).toBe(
      2,
    );
    expect(await debitCount(wallet.id)).toBe(1);
    expect(await balanceOf(db, wallet.id)).toBe('75.00');
  });

  it('survives a failed DeleteMessage: the redelivery is a no-op', async () => {
    const wallet = await createWallet(orm);
    const message = envelope(wagerData(wallet));
    await send(client, queues, message);
    const harness = buildConsumer(orm, client, queues);
    harness.queue.acknowledgeFailures = 1;

    await processAll(harness, [message.messageId]);

    expect(harness.log.events('message.acknowledge_failed')).toHaveLength(1);
    expect(results(harness)).toEqual(['PROCESSED', 'DUPLICATE_MESSAGE']);
    expect(
      harness.log.events('message.processed').map((e) => e.fields.acknowledged),
    ).toEqual([false, true]);
    expect(await debitCount(wallet.id)).toBe(1);
    expect(await balanceOf(db, wallet.id)).toBe('75.00');
  });

  it('dead-letters a message after the attempt limit with diagnostics', async () => {
    const wallet = await createWallet(orm);
    const message = envelope(wagerData(wallet));
    await armFault(db, 1_000);
    await send(client, queues, message);
    const harness = buildConsumer(orm, client, queues);

    await consumeUntil(
      harness,
      () => harness.log.events('message.dead_lettered').length === 1,
      30_000,
    );

    expect(
      harness.log
        .events('message.retry_scheduled')
        .map((e) => e.fields.receiveCount),
    ).toEqual([1, 2]);
    expect(
      harness.log.events('message.dead_lettered')[0]?.fields,
    ).toMatchObject({
      receiveCount: MAX_RECEIVE_COUNT,
      errorCode: 'PERSISTENCE_CONCURRENCY_CONFLICT',
      attemptsExhausted: true,
    });
    const [deadLetter] = await readDeadLetters(client, queues, 1);
    expect(deadLetter?.attributes).toMatchObject({
      errorCode: 'PERSISTENCE_CONCURRENCY_CONFLICT',
      sourceReceiveCount: String(MAX_RECEIVE_COUNT),
      logicalMessageId: message.messageId,
    });
    expect(deadLetter?.body).toBe(JSON.stringify(message));
    expect(await inboxCount(message.messageId)).toBe(0);
    expect(await transactionsOf(wallet.id)).toHaveLength(0);
    await waitUntil(queueEmpty(queues.queueUrl));
  });

  it('lets the broker redrive a message nobody acknowledges into the DLQ', async () => {
    await sendRaw(client, queues, '{"orphan":true}');
    for (let attempt = 1; attempt <= MAX_RECEIVE_COUNT; attempt += 1) {
      const response = await client.send(
        new ReceiveMessageCommand({
          QueueUrl: queues.queueUrl,
          WaitTimeSeconds: 2,
          VisibilityTimeout: 1,
        }),
      );
      expect(response.Messages).toHaveLength(1);
      await Bun.sleep(1_200);
    }
    const extra = await client.send(
      new ReceiveMessageCommand({
        QueueUrl: queues.queueUrl,
        WaitTimeSeconds: 2,
      }),
    );
    expect(extra.Messages ?? []).toHaveLength(0);
    const [deadLetter] = await readDeadLetters(client, queues, 1);
    expect(deadLetter?.body).toBe('{"orphan":true}');
  });

  it.each([
    ['not JSON', 'not-json{', 'MALFORMED_MESSAGE'],
    [
      'numeric amount',
      JSON.stringify({
        messageId: 'msg-numeric',
        type: 'WagerTransactionRequested',
        occurredAt: '2026-07-29T15:00:00.000Z',
        data: {
          providerId: 'provider-a',
          externalTransactionId: 'tx-numeric',
          idempotencyKey: 'provider-a:tx-numeric',
          playerId: 'player',
          walletId: '0192f291-27dd-7d3f-8071-5f8685deef37',
          roundId: 'round-1',
          gameId: 'game',
          kind: 'BET',
          money: { amount: 25, currency: 'BRL' },
        },
      }),
      'VALIDATION_FAILED',
    ],
    [
      'unknown type',
      JSON.stringify({
        messageId: 'msg-type',
        type: 'Something',
        occurredAt: '2026-07-29T15:00:00.000Z',
        data: {},
      }),
      'VALIDATION_FAILED',
    ],
  ])(
    'dead-letters a %s message without touching the database',
    async (_label, body, code) => {
      const before = await scalar(
        db,
        'SELECT count(*)::int AS value FROM wager_transactions',
      );
      await sendRaw(client, queues, body);
      const harness = buildConsumer(orm, client, queues);
      await consumeUntil(
        harness,
        () => harness.log.events('message.dead_lettered').length === 1,
      );
      const [deadLetter] = await readDeadLetters(client, queues, 1);
      expect(deadLetter?.attributes.errorCode).toBe(code);
      expect(deadLetter?.body).toBe(body);
      expect(harness.log.events('message.retry_scheduled')).toHaveLength(0);
      expect(
        await scalar(
          db,
          'SELECT count(*)::int AS value FROM wager_transactions',
        ),
      ).toBe(before);
      await waitUntil(queueEmpty(queues.queueUrl));
    },
  );

  it('retries while PostgreSQL is unreachable and applies the message once it is back', async () => {
    const wallet = await createWallet(orm);
    const message = envelope(wagerData(wallet));
    const database = loadDatabaseConfig(process.env, 'test');
    const proxy = await TcpProxy.start(database.host, database.port);
    const proxiedOrm = await MikroORM.init(
      createMikroOrmConfig({ ...database, port: proxy.port, poolMin: 0 }),
    );
    try {
      await proxiedOrm.em.getConnection().execute('SELECT 1');
      await proxy.pause();
      await send(client, queues, message);
      const harness = buildConsumer(proxiedOrm, client, queues);
      const running = harness.consumer.start();
      await waitUntil(
        () => harness.log.events('message.retry_scheduled').length >= 1,
      );
      expect(await inboxCount(message.messageId)).toBe(0);
      expect(await balanceOf(db, wallet.id)).toBe('100.00');
      await proxy.resume();
      await waitUntil(inboxProcessed(message.messageId), 30_000);
      await waitUntil(queueEmpty(queues.queueUrl));
      await harness.consumer.stop();
      await running;
      const retryCodes = harness.log
        .events('message.retry_scheduled')
        .map((e) => e.fields.errorCode);
      expect(retryCodes.length).toBeGreaterThanOrEqual(1);
      expect(
        retryCodes.every(
          (code) =>
            code === 'PERSISTENCE_UNAVAILABLE' || code === 'UNEXPECTED_ERROR',
        ),
      ).toBe(true);
      expect(retryCodes).toContain('PERSISTENCE_UNAVAILABLE');
      expect(results(harness)).toEqual(['PROCESSED']);
    } finally {
      await proxy.pause();
      await proxiedOrm.close(true);
    }
    expect(await debitCount(wallet.id)).toBe(1);
    expect(await balanceOf(db, wallet.id)).toBe('75.00');
  });

  it('keeps a slow message invisible with heartbeats so no second consumer takes it', async () => {
    const wallet = await createWallet(orm);
    const message = envelope(wagerData(wallet));
    const holder = await openTestOrm();
    const em = holder.em.fork();
    const secondOrm = await openTestOrm();
    try {
      await em.begin();
      await em.execute('SELECT 1 FROM wallets WHERE id = ? FOR NO KEY UPDATE', [
        wallet.id,
      ]);
      await send(client, queues, message);
      const first = buildConsumer(orm, client, queues, {
        lockTimeoutMs: 20_000,
      });
      const second = buildConsumer(secondOrm, client, queues, {
        lockTimeoutMs: 20_000,
      });
      const runningA = first.consumer.start();
      await waitUntil(() => first.queue.received.length === 1);
      const runningB = second.consumer.start();
      await Bun.sleep((VISIBILITY_TIMEOUT_SECONDS + 3) * 1_000);
      await em.commit();
      await waitUntil(
        async () =>
          (await inboxProcessed(message.messageId)()) &&
          (await queueEmpty(queues.queueUrl)()),
      );
      await Promise.all([first.consumer.stop(), second.consumer.stop()]);
      await Promise.all([runningA, runningB]);
      expect(second.queue.received).toHaveLength(0);
      expect(results(first)).toEqual(['PROCESSED']);
      expect(first.log.events('message.processed')[0]?.fields).toMatchObject({
        receiveCount: 1,
        acknowledged: true,
      });
      expect(first.log.events('message.acknowledge_failed')).toHaveLength(0);
      expect(first.queue.extensions.length).toBeGreaterThanOrEqual(3);
      expect(
        first.queue.extensions.every(
          (seconds) => seconds === VISIBILITY_TIMEOUT_SECONDS,
        ),
      ).toBe(true);
    } finally {
      await secondOrm.close(true);
      await holder.close(true);
    }
    expect(await debitCount(wallet.id)).toBe(1);
  });

  it('acknowledges after fixed renewals that outlive the original visibility timeout', async () => {
    await sendRaw(client, queues, '{"slow":true}');
    const queue = new SqsWagerQueue(client, queues, {
      waitTimeSeconds: 1,
      maxMessages: 1,
      visibilityTimeoutSeconds: 2,
    });
    const [message] = await queue.receive(new AbortController().signal);
    if (message === undefined) {
      throw new Error('expected a message');
    }
    for (let renewal = 0; renewal < 3; renewal += 1) {
      await Bun.sleep(1_000);
      await queue.extendVisibility(message, 2);
    }
    await Bun.sleep(1_000);
    expect(Date.now() - message.receivedAtMs).toBeGreaterThan(2_000 * 2);
    const competitor = await client.send(
      new ReceiveMessageCommand({
        QueueUrl: queues.queueUrl,
        WaitTimeSeconds: 0,
      }),
    );
    expect(competitor.Messages ?? []).toHaveLength(0);
    await queue.acknowledge(message);
    await waitUntil(queueEmpty(queues.queueUrl));
  });

  it('makes a message visible again one visibility timeout after renewals stop', async () => {
    await sendRaw(client, queues, '{"abandoned":true}');
    const queue = new SqsWagerQueue(client, queues, {
      waitTimeSeconds: 1,
      maxMessages: 1,
      visibilityTimeoutSeconds: 2,
    });
    const [message] = await queue.receive(new AbortController().signal);
    if (message === undefined) {
      throw new Error('expected a message');
    }
    for (let renewal = 0; renewal < 4; renewal += 1) {
      await Bun.sleep(1_000);
      await queue.extendVisibility(message, 2);
    }
    const abandonedAt = Date.now();
    let redeliveredAt = 0;
    while (redeliveredAt === 0 && Date.now() - abandonedAt < 10_000) {
      const response = await client.send(
        new ReceiveMessageCommand({
          QueueUrl: queues.queueUrl,
          WaitTimeSeconds: 1,
          VisibilityTimeout: 30,
        }),
      );
      if ((response.Messages ?? []).length > 0) {
        redeliveredAt = Date.now();
      }
    }
    const recoveryMs = redeliveredAt - abandonedAt;
    process.stdout.write(`RECOVERY_MS in-process ${recoveryMs}\n`);
    expect(redeliveredAt).toBeGreaterThan(0);
    expect(recoveryMs).toBeGreaterThanOrEqual(1_000);
    expect(recoveryMs).toBeLessThan(2_000 + 2_000);
  });
});

describe('graceful shutdown', () => {
  it('finishes the message in progress before stopping', async () => {
    const wallet = await createWallet(orm);
    const message = envelope(wagerData(wallet));
    const holder = await openTestOrm();
    const em = holder.em.fork();
    try {
      await em.begin();
      await em.execute('SELECT 1 FROM wallets WHERE id = ? FOR NO KEY UPDATE', [
        wallet.id,
      ]);
      await send(client, queues, message);
      const harness = buildConsumer(orm, client, queues, {
        lockTimeoutMs: 10_000,
      });
      const running = harness.consumer.start();
      await waitUntil(() => harness.consumer.inFlight === 1);
      const stopping = harness.consumer.stop();
      expect(harness.consumer.state).toBe('STOPPING');
      await Bun.sleep(500);
      await em.commit();
      await stopping;
      await running;
      expect(harness.consumer.state).toBe('STOPPED');
      expect(results(harness)).toEqual(['PROCESSED']);
      expect(harness.log.events('consumer.stopped')[0]?.fields.graceful).toBe(
        true,
      );
    } finally {
      await holder.close(true);
    }
    await waitUntil(queueEmpty(queues.queueUrl));
    expect(await debitCount(wallet.id)).toBe(1);
  });

  it('stops promptly while idle on a long poll', async () => {
    const harness = buildConsumer(orm, client, queues);
    const running = harness.consumer.start();
    await Bun.sleep(300);
    const startedAt = Date.now();
    await harness.consumer.stop();
    await running;
    expect(Date.now() - startedAt).toBeLessThan(2_000);
    expect(harness.consumer.state).toBe('STOPPED');
  });
});

function brl(amount: string) {
  return { amount, currency: 'BRL' };
}
