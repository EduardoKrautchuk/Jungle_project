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
import { createSqsClient } from '../../src/infrastructure/messaging/sqs-client.js';
import {
  Db,
  migrateFresh,
  openTestOrm,
} from '../integration/persistence/support.js';
import { assertLedgerMatchesBalance } from '../messaging/support.js';
import {
  count,
  createEventQueues,
  deleteEventQueues,
  drainEvents,
  financialFingerprint,
  financials,
  outboxOrder,
  receivedOrder,
  sqsConfig,
  waitFor,
  walletWithBets,
  type EventQueues,
  type Financials,
} from '../outbox/support.js';
import { killAll, WorkerProcess } from './support/process-harness.js';

setDefaultTimeout(120_000);

const LEASE_MS = 3_000;

let orm: MikroORM;
let db: Db;
let client: SQSClient;
let queues: EventQueues;
let fin: Financials;

beforeAll(async () => {
  orm = await openTestOrm();
  await migrateFresh(orm);
  db = new Db(orm);
  client = createSqsClient(sqsConfig());
  fin = financials(orm);
});

afterAll(async () => {
  await killAll();
  client.destroy();
  await orm.close(true);
});

beforeEach(async () => {
  await db.query('DELETE FROM outbox_messages');
  queues = await createEventQueues(client);
});

afterEach(async () => {
  await killAll();
  await deleteEventQueues(client, queues);
  expect(await assertLedgerMatchesBalance(db)).toEqual([]);
  expect(
    await count(
      db,
      "pg_stat_activity WHERE datname = current_database() AND state = 'idle in transaction' AND pid <> pg_backend_pid()",
    ),
  ).toBe(0);
});

let publisherSequence = 0;

async function spawnPublishers(
  count: number,
  extra: Record<string, string> = {},
): Promise<WorkerProcess[]> {
  const publishers = Array.from({ length: count }, () => {
    publisherSequence += 1;
    const name = `publisher-${publisherSequence}`;
    return WorkerProcess.spawnOutboxPublisher(name, {
      OUTBOX_PUBLISHER_ID: name,
      SQS_EVENTS_QUEUE_URL: queues.queueUrl,
      SQS_WAIT_TIME_SECONDS: '1',
      SQS_REQUEST_TIMEOUT_MS: '1200',
      OUTBOX_LEASE_MS: String(LEASE_MS),
      OUTBOX_IDLE_POLL_MS: '100',
      OUTBOX_MAX_GROUPS: '2',
      OUTBOX_MAX_PER_GROUP: '3',
      OUTBOX_SHUTDOWN_GRACE_MS: '10000',
      ...extra,
    });
  });
  await Promise.all(publishers.map((p) => p.waitFor('READY', 30_000)));
  return publishers;
}

async function seed(wallets: number, bets: number): Promise<number> {
  for (let index = 0; index < wallets; index += 1) {
    await walletWithBets(
      fin,
      Array.from({ length: bets }, (_, bet) => `${bet + 1}.00`),
    );
  }
  return wallets * (2 + bets * 2);
}

const allPublished = async () =>
  (await count(
    db,
    'outbox_messages WHERE published_at IS NULL AND dead_lettered_at IS NULL',
  )) === 0;

async function expectCompleteAndOrdered(total: number): Promise<void> {
  const expectedOrder = await outboxOrder(db);
  const events = await drainEvents(client, queues.queueUrl, {
    expected: total,
    timeoutMs: 30_000,
  });
  const unique = new Set(events.map((e) => e.eventId));
  expect(unique.size).toBe(total);
  expect(receivedOrder(events)).toEqual(expectedOrder);
  const bodies = new Map<string, Set<string>>();
  for (const event of events) {
    bodies.set(
      event.eventId,
      (bodies.get(event.eventId) ?? new Set()).add(event.body),
    );
  }
  expect([...bodies.values()].every((set) => set.size === 1)).toBe(true);
  expect(
    await count(
      db,
      'outbox_messages WHERE published_at IS NULL OR lease_token IS NOT NULL',
    ),
  ).toBe(0);
}

function published(publisher: WorkerProcess): number {
  return publisher.output('"event":"outbox.published"').length;
}

describe('outbox publishers in three independent Bun processes', () => {
  it.each([1, 2, 3])(
    'publishes dozens of events once each, in wallet order, sharing the load (run %i)',
    async () => {
      const total = await seed(6, 4);
      const before = await financialFingerprint(db);
      const publishers = await spawnPublishers(3);
      expect(new Set(publishers.map((p) => p.pid)).size).toBe(3);

      await waitFor(allPublished, 60_000);

      await expectCompleteAndOrdered(total);
      const shares = publishers.map(published);
      expect(shares.reduce((sum, value) => sum + value, 0)).toBe(total);
      expect(shares.filter((share) => share > 0).length).toBeGreaterThanOrEqual(
        2,
      );
      expect(await count(db, 'outbox_messages WHERE attempts <> 1')).toBe(0);
      expect(await financialFingerprint(db)).toBe(before);
    },
  );

  it.each(['before-send', 'after-send'])(
    'recovers a batch whose publisher was SIGKILLed %s',
    async (crashPoint) => {
      const total = await seed(3, 3);
      const before = await financialFingerprint(db);
      const [crasher] = await spawnPublishers(1, { CRASH_POINT: crashPoint });
      const crashLine = await crasher?.waitFor('CRASHING', 30_000);
      const crashedEventId = crashLine?.split(' ')[1] ?? '';
      const exit = await crasher?.exit(10_000);
      expect(exit?.signalCode).toBe('SIGKILL');
      const killedAt = Date.now();
      const crasherName = `publisher-${publisherSequence}`;
      expect(
        await count(db, 'outbox_messages WHERE lease_owner = ?', [crasherName]),
      ).toBeGreaterThan(0);
      expect(
        await count(db, 'outbox_messages WHERE published_at IS NOT NULL'),
      ).toBe(0);

      const survivors = await spawnPublishers(2);
      await waitFor(allPublished, 60_000);
      const recoveredAfterMs = Date.now() - killedAt;
      process.stdout.write(
        `OUTBOX_RECOVERY_MS ${crashPoint} ${recoveredAfterMs}\n`,
      );

      const recoveries = survivors.flatMap((p) =>
        p.output('"event":"outbox.lease_recovered"'),
      );
      expect(recoveries.length).toBeGreaterThan(0);
      expect(recoveries.every((line) => line.includes(crasherName))).toBe(true);
      await expectCompleteAndOrdered(total);
      const [row] = await db.query(
        'SELECT (published_at IS NOT NULL)::text AS done FROM outbox_messages WHERE id = ?',
        [crashedEventId],
      );
      expect(row?.done).toBe('true');
      expect(await financialFingerprint(db)).toBe(before);
    },
  );

  it('finishes the load after one of three publishers is SIGKILLed mid-batch', async () => {
    const total = await seed(10, 6);
    const publishers = await spawnPublishers(3);
    await waitFor(
      async () =>
        (await count(db, 'outbox_messages WHERE published_at IS NOT NULL')) >=
        10,
      30_000,
    );
    publishers[0]?.kill('SIGKILL');
    await waitFor(allPublished, 90_000);
    await expectCompleteAndOrdered(total);
  });

  it('drains the backlog after every publisher is killed and new ones start', async () => {
    const total = await seed(8, 5);
    const first = await spawnPublishers(3);
    await waitFor(
      async () =>
        (await count(db, 'outbox_messages WHERE published_at IS NOT NULL')) >=
        5,
      30_000,
    );
    for (const publisher of first) {
      publisher.kill('SIGKILL');
    }
    await Promise.all(first.map((publisher) => publisher.exit(10_000)));
    const remaining = await count(
      db,
      'outbox_messages WHERE published_at IS NULL',
    );
    expect(remaining).toBeGreaterThan(0);

    await spawnPublishers(3);
    await waitFor(allPublished, 90_000);
    await expectCompleteAndOrdered(total);
  });

  it('stops on SIGTERM after finishing its batch and leaves no claims behind', async () => {
    const total = await seed(4, 4);
    const [publisher] = await spawnPublishers(1, { OUTBOX_MAX_GROUPS: '1' });
    await waitFor(async () => (publisher ? published(publisher) > 0 : false));
    publisher?.kill('SIGTERM');
    const exit = await publisher?.exit(30_000);
    expect(exit).toEqual({ exitCode: 0, signalCode: null });
    expect(publisher?.output('"event":"publisher.exited"')).toHaveLength(1);
    expect(publisher?.output('"event":"publisher.stopped"')[0]).toContain(
      '"graceful":true',
    );
    expect(
      await count(db, 'outbox_messages WHERE lease_token IS NOT NULL'),
    ).toBe(0);

    await spawnPublishers(1);
    await waitFor(allPublished, 60_000);
    await expectCompleteAndOrdered(total);
  });
});
