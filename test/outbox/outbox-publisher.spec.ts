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
import { randomUUID } from 'node:crypto';
import type { SQSClient } from '@aws-sdk/client-sqs';
import { MikroORM } from '@mikro-orm/postgresql';
import { WalletBalanceChanged } from '../../src/application/events/wagering-events.js';
import { OutboxMessage } from '../../src/domain/messaging/outbox-message.js';
import { Money } from '../../src/domain/money/money.js';
import { Wallet } from '../../src/domain/wallet/wallet.js';
import { loadDatabaseConfig } from '../../src/infrastructure/config/database.config.js';
import { createSqsClient } from '../../src/infrastructure/messaging/sqs-client.js';
import { MikroOrmUnitOfWork } from '../../src/infrastructure/persistence/mikro-orm-unit-of-work.js';
import { createMikroOrmConfig } from '../../src/infrastructure/persistence/mikro-orm.config.js';
import { SqlOutboxPublicationStore } from '../../src/infrastructure/persistence/outbox-publication.store.js';
import {
  Db,
  migrateFresh,
  openTestOrm,
} from '../integration/persistence/support.js';
import { TcpProxy } from '../messaging/tcp-proxy.js';
import {
  buildPublisher,
  count,
  createEventQueues,
  deleteEventQueues,
  drainEvents,
  financialFingerprint,
  financials,
  outboxOrder,
  receivedOrder,
  runPublisherUntil,
  sqsConfig,
  waitFor,
  walletWithBets,
  type EventQueues,
  type Financials,
} from './support.js';

setDefaultTimeout(90_000);

let orm: MikroORM;
let db: Db;
let client: SQSClient;
let queues: EventQueues;
let fin: Financials;

const allPublished = async () =>
  (await count(
    db,
    'outbox_messages WHERE published_at IS NULL AND dead_lettered_at IS NULL',
  )) === 0;

beforeAll(async () => {
  orm = await openTestOrm();
  await migrateFresh(orm);
  db = new Db(orm);
  client = createSqsClient(sqsConfig());
  fin = financials(orm);
});

afterAll(async () => {
  client.destroy();
  await orm.close(true);
});

beforeEach(async () => {
  await db.query('DELETE FROM outbox_messages');
  queues = await createEventQueues(client);
});

afterEach(async () => {
  await deleteEventQueues(client, queues);
  expect(await count(db, 'outbox_messages WHERE lease_token IS NOT NULL')).toBe(
    0,
  );
});

describe('outbox rows produced by financial commits', () => {
  it('stores Processed and BalanceChanged events for a confirmed BET in commit order', async () => {
    const walletId = await walletWithBets(fin, ['25.50']);
    const rows = await db.query(
      `SELECT event_type, group_key, attempts, published_at, lease_token,
              payload #>> '{data,money,amount}' AS amount,
              jsonb_typeof(payload #> '{data,money,amount}') AS amount_type
         FROM outbox_messages ORDER BY publish_sequence`,
    );
    expect(rows.map((row) => row.event_type)).toEqual([
      'WagerTransactionProcessed',
      'WalletBalanceChanged',
      'WagerTransactionProcessed',
      'WalletBalanceChanged',
    ]);
    expect(rows.every((row) => row.group_key === walletId)).toBe(true);
    expect(rows.every((row) => row.published_at === null)).toBe(true);
    expect(rows[3]).toMatchObject({ amount: '25.50', amount_type: 'string' });
  });

  it('never publishes an event whose transaction has not committed', async () => {
    const publisher = buildPublisher(orm, queues.queueUrl);
    const uow = new MikroOrmUnitOfWork(orm.em);
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const eventId = randomUUID();
    const pending = uow.run(async (repositories) => {
      await repositories.outbox.enqueue(standaloneEvent(eventId, 'wallet-tx'));
      await gate;
    });
    await Bun.sleep(200);
    const before = await publisher.batch.run();
    expect(before.claimed).toBe(0);
    expect(
      await drainEvents(client, queues.queueUrl, { quietMs: 500 }),
    ).toEqual([]);

    release();
    await pending;
    const after = await publisher.batch.run();
    expect(after.outcomes.map((o) => [o.eventId, o.result])).toEqual([
      [eventId, 'PUBLISHED'],
    ]);
    publisher.client.destroy();
  });
});

describe('publication to SQS', () => {
  it('publishes the exact persisted envelope and records the confirmation', async () => {
    const walletId = await walletWithBets(fin, ['25.50']);
    const persisted = await db.query(
      'SELECT id, payload::text AS payload FROM outbox_messages ORDER BY publish_sequence',
    );
    const publisher = buildPublisher(orm, queues.queueUrl);

    await runPublisherUntil(publisher, allPublished);

    const events = await drainEvents(client, queues.queueUrl, {
      expected: persisted.length,
    });
    expect(events.map((e) => e.eventId)).toEqual(
      persisted.map((row) => String(row.id)),
    );
    for (const [index, event] of events.entries()) {
      const stored: unknown = JSON.parse(String(persisted[index]?.payload));
      expect(event.payload).toEqual(
        typeof stored === 'object' && stored !== null ? { ...stored } : {},
      );
      expect(event.groupId).toBe(walletId);
      expect(event.deduplicationId).toBe(event.eventId);
      expect(event.attributes).toMatchObject({
        eventId: event.eventId,
        eventType: String(event.payload.eventType),
        eventVersion: '1',
        correlationId: String(event.payload.correlationId),
      });
    }
    const bet = events.find(
      (e) =>
        e.payload.eventType === 'WalletBalanceChanged' &&
        e.body.includes('"DEBIT"'),
    );
    expect(bet?.body).toContain('"amount":"25.50"');
    expect(bet?.body).not.toMatch(/"amount":\d/);

    const rows = await db.query(
      `SELECT id, attempts, (published_at >= occurred_at)::text AS ordered,
              transport_message_id, lease_owner, last_error
         FROM outbox_messages ORDER BY publish_sequence`,
    );
    expect(
      rows.map((row) => ({
        attempts: row.attempts,
        ordered: row.ordered,
        leaseOwner: row.lease_owner,
        lastError: row.last_error,
      })),
    ).toEqual(
      rows.map(() => ({
        attempts: 1,
        ordered: 'true',
        leaseOwner: null,
        lastError: null,
      })),
    );
    const byText = (a: string, b: string) => a.localeCompare(b);
    expect(
      rows.map((row) => String(row.transport_message_id)).sort(byText),
    ).toEqual(events.map((e) => e.sqsMessageId).sort(byText));
    expect(publisher.log.events('outbox.published')).toHaveLength(
      persisted.length,
    );
    publisher.client.destroy();
  });

  it('does not resend published events on later cycles', async () => {
    await walletWithBets(fin, ['10.00']);
    const publisher = buildPublisher(orm, queues.queueUrl);
    await runPublisherUntil(publisher, allPublished);
    const first = await drainEvents(client, queues.queueUrl, { expected: 4 });
    expect(first).toHaveLength(4);

    for (let cycle = 0; cycle < 5; cycle += 1) {
      expect((await publisher.batch.run()).claimed).toBe(0);
    }
    expect(publisher.transport.attempted).toHaveLength(4);
    expect(
      await drainEvents(client, queues.queueUrl, { quietMs: 1_000 }),
    ).toEqual([]);
    publisher.client.destroy();
  });

  it('leaves wallets, ledger and wager transactions untouched', async () => {
    await walletWithBets(fin, ['10.00', '20.00']);
    await walletWithBets(fin, ['5.00']);
    const before = await financialFingerprint(db);
    const publisher = buildPublisher(orm, queues.queueUrl);
    await runPublisherUntil(publisher, allPublished);
    expect(await financialFingerprint(db)).toBe(before);
    publisher.client.destroy();
  });

  it('publishes several wallets in one claim while keeping each wallet in order', async () => {
    const wallets = [];
    for (let index = 0; index < 4; index += 1) {
      wallets.push(
        await walletWithBets(fin, ['1.00', '2.00', '3.00', '4.00', '5.00']),
      );
    }
    const expected = await outboxOrder(db);
    const first = buildPublisher(orm, queues.queueUrl, { maxPerGroup: 2 });
    const secondOrm = await openTestOrm();
    const second = buildPublisher(secondOrm, queues.queueUrl, {
      maxPerGroup: 2,
    });
    try {
      const runningA = first.worker.start();
      const runningB = second.worker.start();
      await waitFor(allPublished, 30_000);
      await Promise.all([first.worker.stop(), second.worker.stop()]);
      await Promise.all([runningA, runningB]);
    } finally {
      second.client.destroy();
      await secondOrm.close(true);
    }
    const claims = [
      ...first.log.events('outbox.claimed'),
      ...second.log.events('outbox.claimed'),
    ];
    expect(claims.some((claim) => Number(claim.fields.groups) > 1)).toBe(true);
    const events = await drainEvents(client, queues.queueUrl, {
      expected: 4 * 12,
    });
    expect(receivedOrder(events)).toEqual(expected);
    expect(new Set(events.map((e) => e.eventId)).size).toBe(4 * 12);
    first.client.destroy();
  });
});

describe('claims and leases', () => {
  it('never hands the same row to two concurrent claimers', async () => {
    for (let index = 0; index < 10; index += 1) {
      await walletWithBets(fin, ['1.00']);
    }
    const otherOrm = await openTestOrm();
    try {
      const stores = [
        new SqlOutboxPublicationStore(orm.em),
        new SqlOutboxPublicationStore(otherOrm.em),
        new SqlOutboxPublicationStore(orm.em),
      ];
      const claims = await Promise.all(
        stores.map((store, index) =>
          store.claim({
            owner: `claimer-${index}`,
            token: randomUUID(),
            leaseMs: 60_000,
            maxGroups: 4,
            maxPerGroup: 10,
          }),
        ),
      );
      const ids = claims.flatMap((claim) =>
        claim.groups.flat().map((item) => item.message.id),
      );
      expect(new Set(ids).size).toBe(ids.length);
      const groups = claims.flatMap((claim) =>
        claim.groups.map((group) => group[0]?.groupKey),
      );
      expect(new Set(groups).size).toBe(groups.length);
      expect(ids.length).toBeGreaterThan(0);
      for (const [index, claim] of claims.entries()) {
        await stores[index]?.release(
          claim.groups.flat().map((item) => item.message.id),
          claim.token,
        );
      }
    } finally {
      await otherOrm.close(true);
    }
  });

  it('recovers an abandoned claim only after its lease expires and fences the old token', async () => {
    await walletWithBets(fin, ['7.00']);
    const ghost = new SqlOutboxPublicationStore(orm.em);
    const ghostToken = randomUUID();
    const abandoned = await ghost.claim({
      owner: 'ghost-publisher',
      token: ghostToken,
      leaseMs: 2_500,
      maxGroups: 10,
      maxPerGroup: 10,
    });
    const abandonedIds = abandoned.groups.flat().map((c) => c.message.id);
    expect(abandonedIds).toHaveLength(4);

    const publisher = buildPublisher(orm, queues.queueUrl);
    expect((await publisher.batch.run()).claimed).toBe(0);
    expect((await ghost.backlog()).leased).toBe(4);

    await Bun.sleep(2_700);
    expect((await ghost.backlog()).expiredLeases).toBe(4);
    const recovered = await publisher.batch.run();
    expect(recovered.outcomes.map((o) => o.result)).toEqual([
      'PUBLISHED',
      'PUBLISHED',
      'PUBLISHED',
      'PUBLISHED',
    ]);
    expect(recovered.outcomes.map((o) => o.recoveredFrom)).toEqual([
      'ghost-publisher',
      'ghost-publisher',
      'ghost-publisher',
      'ghost-publisher',
    ]);
    expect(
      await ghost.confirm(abandonedIds[0] ?? '', ghostToken, 'stale'),
    ).toBe(false);
    const [row] = await db.query(
      'SELECT transport_message_id FROM outbox_messages WHERE id = ?',
      [abandonedIds[0]],
    );
    expect(row?.transport_message_id).not.toBe('stale');
    publisher.client.destroy();
  });

  it('reports the backlog by state', async () => {
    await walletWithBets(fin, ['3.00']);
    const store = new SqlOutboxPublicationStore(orm.em);
    const before = await store.backlog();
    expect(before).toMatchObject({
      pending: 4,
      due: 4,
      retrying: 0,
      leased: 0,
      published: 0,
      deadLettered: 0,
    });
    expect(before.oldestPendingAgeMs).toBeGreaterThanOrEqual(0);
    const publisher = buildPublisher(orm, queues.queueUrl);
    await runPublisherUntil(publisher, allPublished);
    expect(await store.backlog()).toMatchObject({
      pending: 0,
      published: 4,
      oldestPendingAgeMs: undefined,
    });
    publisher.client.destroy();
  });
});

describe('failures', () => {
  it('keeps events eligible while SQS is unreachable and publishes them once it returns', async () => {
    await walletWithBets(fin, ['4.00']);
    const endpoint = new URL(sqsConfig().endpoint ?? 'http://127.0.0.1:54566');
    const proxy = await TcpProxy.start(
      endpoint.hostname,
      Number(endpoint.port),
    );
    const publisher = buildPublisher(orm, queues.queueUrl, {
      sqs: { endpoint: `http://127.0.0.1:${proxy.port}` },
    });
    try {
      await proxy.pause();
      const failed = await publisher.batch.run();
      expect(failed.outcomes).toHaveLength(1);
      expect(failed.outcomes[0]).toMatchObject({
        result: 'RETRY_SCHEDULED',
        failureKind: 'TRANSIENT',
        attempt: 1,
      });
      const [row] = await db.query(
        `SELECT attempts, published_at, last_error, lease_token,
                next_attempt_at > now() AS scheduled
           FROM outbox_messages WHERE id = ?`,
        [failed.outcomes[0]?.eventId],
      );
      expect(row).toMatchObject({
        attempts: 1,
        published_at: null,
        lease_token: null,
        scheduled: true,
      });
      expect(String(row?.last_error)).not.toBe('');
      expect((await publisher.batch.run()).claimed).toBe(0);

      await proxy.resume();
      await runPublisherUntil(publisher, allPublished);
      const events = await drainEvents(client, queues.queueUrl, {
        expected: 4,
      });
      expect(events).toHaveLength(4);
      const [retried] = await db.query(
        'SELECT attempts, last_error FROM outbox_messages WHERE id = ?',
        [failed.outcomes[0]?.eventId],
      );
      expect(retried).toMatchObject({ attempts: 2, last_error: null });
    } finally {
      await proxy.pause();
      publisher.client.destroy();
    }
  });

  it('republishes the same eventId when PostgreSQL fails right after SendMessage', async () => {
    await walletWithBets(fin, ['6.00'], '50.00');
    const database = loadDatabaseConfig(process.env, 'test');
    const proxy = await TcpProxy.start(database.host, database.port);
    const proxiedOrm = await MikroORM.init(
      createMikroOrmConfig({ ...database, port: proxy.port, poolMin: 0 }),
    );
    const flaky = buildPublisher(proxiedOrm, queues.queueUrl, {
      owner: 'flaky-publisher',
      leaseMs: 2_500,
      maxPerGroup: 1,
    });
    const healthy = buildPublisher(orm, queues.queueUrl, {
      owner: 'healthy-publisher',
    });
    try {
      flaky.transport.hook = async (_event, phase) => {
        if (phase === 'after') {
          flaky.transport.hook = undefined;
          await proxy.pause();
        }
      };
      const report = await flaky.batch.run();
      expect(report.outcomes).toHaveLength(1);
      expect(report.outcomes[0]?.result).toBe('CONFIRMATION_FAILED');
      const lostId = report.outcomes[0]?.eventId;
      const [row] = await db.query(
        'SELECT published_at, lease_owner FROM outbox_messages WHERE id = ?',
        [lostId],
      );
      expect(row).toMatchObject({
        published_at: null,
        lease_owner: 'flaky-publisher',
      });

      await Bun.sleep(2_700);
      await runPublisherUntil(healthy, allPublished);
      expect(
        healthy.log
          .events('outbox.lease_recovered')
          .map((e) => e.fields.previousOwner),
      ).toContain('flaky-publisher');
      const events = await drainEvents(client, queues.queueUrl, {
        expected: 4,
      });
      const copies = events.filter((e) => e.eventId === lostId);
      expect(copies.length).toBeGreaterThanOrEqual(1);
      expect(new Set(copies.map((e) => e.body)).size).toBe(1);
      expect(new Set(events.map((e) => e.eventId)).size).toBe(4);
      expect(healthy.transport.attempted).toContain(lostId ?? '');
    } finally {
      await proxy.pause();
      flaky.client.destroy();
      healthy.client.destroy();
      await proxiedOrm.close(true);
    }
  });

  it('dead-letters a corrupted event without blocking the rest of its wallet or other wallets', async () => {
    const walletA = await walletWithBets(fin, ['1.00', '2.00']);
    const walletB = await walletWithBets(fin, ['3.00']);
    const [victim] = await db.query(
      `SELECT id FROM outbox_messages WHERE group_key = ?
        ORDER BY publish_sequence OFFSET 1 LIMIT 1`,
      [walletA],
    );
    await db.query(
      `UPDATE outbox_messages
          SET payload = jsonb_set(payload, '{data,money,amount}', '1'::jsonb)
        WHERE id = ?`,
      [victim?.id],
    );
    const publisher = buildPublisher(orm, queues.queueUrl);
    await runPublisherUntil(publisher, allPublished);

    const [dead] = await db.query(
      'SELECT dead_lettered_at, published_at, last_error FROM outbox_messages WHERE id = ?',
      [victim?.id],
    );
    expect(dead).toMatchObject({
      published_at: null,
      last_error: 'EVENT_AMOUNT_NOT_DECIMAL_STRING',
    });
    expect(dead?.dead_lettered_at).not.toBeNull();
    expect(publisher.log.events('outbox.dead_lettered')).toHaveLength(1);
    const events = await drainEvents(client, queues.queueUrl, {
      expected: 5 + 4,
    });
    expect(events.map((e) => e.eventId)).not.toContain(String(victim?.id));
    expect(events.filter((e) => e.groupId === walletA)).toHaveLength(5);
    expect(events.filter((e) => e.groupId === walletB)).toHaveLength(4);
    expect((await publisher.store.backlog()).deadLettered).toBe(1);
    publisher.client.destroy();
  });

  it('drains the backlog accumulated while no publisher was running after a restart', async () => {
    await walletWithBets(fin, ['1.00', '1.00']);
    const first = buildPublisher(orm, queues.queueUrl);
    await runPublisherUntil(first, allPublished);
    first.client.destroy();

    await walletWithBets(fin, ['2.00', '2.00', '2.00']);
    const ghost = new SqlOutboxPublicationStore(orm.em);
    await ghost.claim({
      owner: 'crashed-before-restart',
      token: randomUUID(),
      leaseMs: 1_000,
      maxGroups: 1,
      maxPerGroup: 2,
    });
    expect((await ghost.backlog()).pending).toBe(8);
    await Bun.sleep(1_200);

    const restarted = buildPublisher(orm, queues.queueUrl);
    await runPublisherUntil(restarted, allPublished);
    const events = await drainEvents(client, queues.queueUrl, {
      expected: 6 + 8,
    });
    expect(new Set(events.map((e) => e.eventId)).size).toBe(14);
    expect(await count(db, 'outbox_messages WHERE published_at IS NULL')).toBe(
      0,
    );
    restarted.client.destroy();
  });
});

function standaloneEvent(eventId: string, walletId: string): OutboxMessage {
  const at = new Date();
  const { wallet } = Wallet.open({
    id: walletId,
    playerId: 'player',
    initialBalance: Money.from({ amount: '10.00', currency: 'BRL' }),
    at,
    opening: { entryId: randomUUID(), transactionId: randomUUID() },
  });
  const entry = wallet.credit(Money.from({ amount: '1.00', currency: 'BRL' }), {
    entryId: randomUUID(),
    transactionId: randomUUID(),
    at,
  });
  return OutboxMessage.enqueue(
    WalletBalanceChanged.from(wallet, entry, {
      eventId,
      correlationId: 'corr-standalone',
      occurredAt: at,
    }),
  );
}
