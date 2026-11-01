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
import type { SQSClient } from '@aws-sdk/client-sqs';
import type { MikroORM } from '@mikro-orm/postgresql';
import {
  Db,
  migrateFresh,
  openTestOrm,
} from '../integration/persistence/support.js';
import {
  assertLedgerMatchesBalance,
  balanceOf,
  createTestQueues,
  createWallet,
  deleteTestQueues,
  envelope,
  queueDepth,
  readDeadLetters,
  scalar,
  send,
  sqsClient,
  wagerData,
  waitUntil,
  type TestQueues,
} from '../messaging/support.js';
import { killAll, WorkerProcess } from './support/process-harness.js';

setDefaultTimeout(120_000);

let orm: MikroORM;
let db: Db;
let client: SQSClient;
let queues: TestQueues;

beforeAll(async () => {
  orm = await openTestOrm();
  await migrateFresh(orm);
  db = new Db(orm);
  client = sqsClient();
});

afterAll(async () => {
  await killAll();
  client.destroy();
  await orm.close(true);
});

beforeEach(async () => {
  queues = await createTestQueues(client);
});

afterEach(async () => {
  await killAll();
  await deleteTestQueues(client, queues);
  expect(await assertLedgerMatchesBalance(db)).toEqual([]);
  expect(
    await scalar(
      db,
      'SELECT count(*)::int AS value FROM wallets WHERE balance < 0',
    ),
  ).toBe(0);
  expect(
    await scalar(
      db,
      "SELECT count(*)::int AS value FROM pg_stat_activity WHERE datname = current_database() AND state = 'idle in transaction' AND pid <> pg_backend_pid()",
    ),
  ).toBe(0);
});

function workerEnv(extra: Record<string, string> = {}): Record<string, string> {
  return {
    SQS_WAGER_QUEUE_URL: queues.queueUrl,
    SQS_WAGER_DLQ_URL: queues.deadLetterQueueUrl,
    SQS_WAIT_TIME_SECONDS: '1',
    SQS_REQUEST_TIMEOUT_MS: '5000',
    SQS_VISIBILITY_TIMEOUT_SECONDS: '4',
    SQS_MAX_RECEIVE_COUNT: '3',
    SQS_RETRY_BASE_SECONDS: '1',
    SQS_RETRY_MAX_SECONDS: '2',
    SQS_SHUTDOWN_GRACE_MS: '10000',
    ...extra,
  };
}

async function spawnWorkers(
  count: number,
  extra: Record<string, string> = {},
): Promise<WorkerProcess[]> {
  const workers = Array.from({ length: count }, (_, index) =>
    WorkerProcess.spawnSqsWorker(`sqs-worker-${index + 1}`, workerEnv(extra)),
  );
  await Promise.all(workers.map((worker) => worker.waitFor('READY', 30_000)));
  return workers;
}

const drained = async (): Promise<boolean> => {
  const depth = await queueDepth(client, queues.queueUrl);
  return depth.visible + depth.inFlight + depth.delayed === 0;
};

const processedInbox = (messageIds: readonly string[]) => async () =>
  (await scalar(
    db,
    `SELECT count(*)::int AS value FROM inbox_messages
      WHERE processed_at IS NOT NULL
        AND message_id IN (${messageIds.map(() => '?').join(', ')})`,
    [...messageIds],
  )) === messageIds.length;

function processedBy(workers: readonly WorkerProcess[]): number[] {
  return workers.map(
    (worker) => worker.output('"event":"message.processed"').length,
  );
}

describe('SQS consumers in three independent Bun processes', () => {
  it('runs three workers with distinct PIDs', async () => {
    const workers = await spawnWorkers(3);
    expect(new Set(workers.map((worker) => worker.pid)).size).toBe(3);
  });

  it.each([1, 2, 3])(
    'applies one logical message delivered 30 times across workers exactly once (run %i)',
    async () => {
      const wallet = await createWallet(orm, '1000.00');
      const message = envelope(wagerData(wallet));
      const workers = await spawnWorkers(3);
      await Promise.all(
        Array.from({ length: 30 }, (_, index) =>
          send(client, queues, message, { groupId: `dup-${index}` }),
        ),
      );
      await waitUntil(
        async () =>
          (await processedInbox([message.messageId])()) && (await drained()),
        60_000,
      );
      expect(
        await scalar(
          db,
          "SELECT count(*)::int AS value FROM wallet_ledger_entries WHERE wallet_id = ? AND direction = 'DEBIT'",
          [wallet.id],
        ),
      ).toBe(1);
      expect(
        await scalar(
          db,
          'SELECT count(*)::int AS value FROM inbox_messages WHERE message_id = ?',
          [message.messageId],
        ),
      ).toBe(1);
      expect(await balanceOf(db, wallet.id)).toBe('975.00');
      expect(
        processedBy(workers).reduce((sum, value) => sum + value, 0),
      ).toBeGreaterThanOrEqual(30);
    },
  );

  it.each([1, 2, 3])(
    'keeps one hot wallet consistent while three workers compete for its balance (run %i)',
    async () => {
      const wallet = await createWallet(orm, '300.00');
      const messages = Array.from({ length: 40 }, () =>
        envelope(
          wagerData(wallet, { money: { amount: '10.00', currency: 'BRL' } }),
        ),
      );
      const workers = await spawnWorkers(3);
      await Promise.all(
        messages.map((message, index) =>
          send(client, queues, message, { groupId: `hot-${index}` }),
        ),
      );
      await waitUntil(
        async () =>
          (await processedInbox(messages.map((m) => m.messageId))()) &&
          (await drained()),
        60_000,
      );
      const statuses = await db.query(
        `SELECT status, failure_code, count(*)::int AS n FROM wager_transactions
          WHERE wallet_id = ? AND kind = 'BET' GROUP BY status, failure_code
          ORDER BY status`,
        [wallet.id],
      );
      expect(statuses).toEqual([
        { status: 'PROCESSED', failure_code: null, n: 30 },
        { status: 'REJECTED', failure_code: 'INSUFFICIENT_FUNDS', n: 10 },
      ]);
      expect(await balanceOf(db, wallet.id)).toBe('0.00');
      const [chain] = await db.query(
        `SELECT count(*)::int AS breaks FROM (
           SELECT balance_before, lag(balance_after) OVER (ORDER BY created_at, id) AS previous
             FROM wallet_ledger_entries WHERE wallet_id = ?) entries
          WHERE previous IS NOT NULL AND previous <> balance_before`,
        [wallet.id],
      );
      expect(chain?.breaks).toBe(0);
      expect(
        processedBy(workers).filter((count) => count > 0).length,
      ).toBeGreaterThanOrEqual(2);
    },
  );

  it.each([1, 2, 3])(
    'recovers a message whose worker died after the commit and before DeleteMessage (run %i)',
    async () => {
      const wallet = await createWallet(orm);
      const message = envelope(wagerData(wallet));
      const [crasher] = await spawnWorkers(1, { CRASH_BEFORE_DELETE: '1' });
      await send(client, queues, message);
      await crasher?.waitFor('COMMITTED', 30_000);
      const exit = await crasher?.exit(10_000);
      expect(exit?.signalCode).toBe('SIGKILL');
      expect(
        await scalar(
          db,
          'SELECT count(*)::int AS value FROM inbox_messages WHERE message_id = ? AND processed_at IS NOT NULL',
          [message.messageId],
        ),
      ).toBe(1);
      expect(await balanceOf(db, wallet.id)).toBe('75.00');

      const survivors = await spawnWorkers(2);
      await waitUntil(drained, 60_000);
      const duplicates = survivors.flatMap((worker) =>
        worker.output('"result":"DUPLICATE_MESSAGE"'),
      );
      expect(duplicates).toHaveLength(1);
      expect(duplicates[0]).toContain('"receiveCount":2');
      expect(
        await scalar(
          db,
          "SELECT count(*)::int AS value FROM wallet_ledger_entries WHERE wallet_id = ? AND direction = 'DEBIT'",
          [wallet.id],
        ),
      ).toBe(1);
      expect(await balanceOf(db, wallet.id)).toBe('75.00');
    },
  );

  it.each([1, 2, 3])(
    'redelivers a message held past its visibility timeout within one timeout after its worker is SIGKILLed (run %i)',
    async () => {
      const visibilitySeconds = 2;
      const shortVisibility = {
        SQS_VISIBILITY_TIMEOUT_SECONDS: String(visibilitySeconds),
      };
      const wallet = await createWallet(orm);
      const message = envelope(wagerData(wallet));
      const holder = await openTestOrm();
      const em = holder.em.fork();
      try {
        await em.begin();
        await em.execute(
          'SELECT 1 FROM wallets WHERE id = ? FOR NO KEY UPDATE',
          [wallet.id],
        );
        const [victim] = await spawnWorkers(1, shortVisibility);
        await send(client, queues, message);
        await waitUntil(
          async () =>
            (await scalar(
              db,
              "SELECT count(*)::int AS value FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND datname = current_database()",
            )) === 1,
          30_000,
        );
        const receivedAt = Date.now();
        const [survivor] = await spawnWorkers(1, shortVisibility);
        await Bun.sleep(
          Math.max(
            0,
            visibilitySeconds * 2 * 1_000 - (Date.now() - receivedAt),
          ),
        );
        expect(Date.now() - receivedAt).toBeLessThan(4_800);
        expect(await queueDepth(client, queues.queueUrl)).toMatchObject({
          visible: 0,
          inFlight: 1,
        });

        victim?.kill('SIGKILL');
        const killedAt = Date.now();
        await victim?.exit(10_000);
        await em.commit();

        await waitUntil(
          async () =>
            (await processedInbox([message.messageId])()) && (await drained()),
          30_000,
        );
        const [line] = survivor?.output('"event":"message.processed"') ?? [];
        const entry: unknown = JSON.parse(line ?? '{}');
        if (
          typeof entry !== 'object' ||
          entry === null ||
          !('timestamp' in entry) ||
          !('durationMs' in entry) ||
          !('receiveCount' in entry) ||
          typeof entry.timestamp !== 'string' ||
          typeof entry.durationMs !== 'number'
        ) {
          throw new Error(`unexpected log line ${line}`);
        }
        const redeliveredAt =
          new Date(entry.timestamp).getTime() - entry.durationMs;
        const recoveryMs = redeliveredAt - killedAt;
        process.stdout.write(`RECOVERY_MS sigkill ${recoveryMs}\n`);
        expect(entry.receiveCount).toBe(2);
        expect(recoveryMs).toBeLessThan((visibilitySeconds + 3) * 1_000);
        expect(
          await scalar(
            db,
            "SELECT count(*)::int AS value FROM wallet_ledger_entries WHERE wallet_id = ? AND direction = 'DEBIT'",
            [wallet.id],
          ),
        ).toBe(1);
        expect(await balanceOf(db, wallet.id)).toBe('75.00');
      } finally {
        await holder.close(true);
      }
    },
  );

  it('finishes the load after a worker is SIGKILLed in the middle of it', async () => {
    const wallet = await createWallet(orm, '1000.00');
    const messages = Array.from({ length: 40 }, () =>
      envelope(
        wagerData(wallet, { money: { amount: '5.00', currency: 'BRL' } }),
      ),
    );
    const workers = await spawnWorkers(3);
    await Promise.all(
      messages.map((message, index) =>
        send(client, queues, message, { groupId: `load-${index % 8}` }),
      ),
    );
    await waitUntil(
      async () =>
        (await scalar(
          db,
          'SELECT count(*)::int AS value FROM inbox_messages WHERE processed_at IS NOT NULL AND message_id LIKE ?',
          ['msg-%'],
        )) > 0,
      30_000,
    );
    workers[0]?.kill('SIGKILL');
    await waitUntil(
      async () =>
        (await processedInbox(messages.map((m) => m.messageId))()) &&
        (await drained()),
      90_000,
    );
    expect(
      await scalar(
        db,
        "SELECT count(*)::int AS value FROM wallet_ledger_entries WHERE wallet_id = ? AND direction = 'DEBIT'",
        [wallet.id],
      ),
    ).toBe(40);
    expect(await balanceOf(db, wallet.id)).toBe('800.00');
    expect(await readDeadLetters(client, queues, 1, 2_000)).toHaveLength(0);
  });

  it('shuts a worker down on SIGTERM without losing the messages it was handling', async () => {
    const wallet = await createWallet(orm, '1000.00');
    const messages = Array.from({ length: 20 }, () =>
      envelope(
        wagerData(wallet, { money: { amount: '1.00', currency: 'BRL' } }),
      ),
    );
    const [worker] = await spawnWorkers(1);
    await Promise.all(
      messages.map((message, index) =>
        send(client, queues, message, { groupId: `term-${index % 4}` }),
      ),
    );
    await waitUntil(
      () => (worker?.output('"event":"message.processed"').length ?? 0) > 0,
      30_000,
    );
    worker?.kill('SIGTERM');
    const exit = await worker?.exit(30_000);
    expect(exit).toEqual({ exitCode: 0, signalCode: null });
    expect(worker?.output('"event":"worker.exited"')).toHaveLength(1);
    expect(worker?.output('"event":"consumer.stopped"')[0] ?? '').toContain(
      '"graceful":true',
    );

    await spawnWorkers(1);
    await waitUntil(
      async () =>
        (await processedInbox(messages.map((m) => m.messageId))()) &&
        (await drained()),
      60_000,
    );
    expect(await balanceOf(db, wallet.id)).toBe('980.00');
    expect(
      await scalar(
        db,
        "SELECT count(*)::int AS value FROM wallet_ledger_entries WHERE wallet_id = ? AND direction = 'DEBIT'",
        [wallet.id],
      ),
    ).toBe(20);
  });
});
