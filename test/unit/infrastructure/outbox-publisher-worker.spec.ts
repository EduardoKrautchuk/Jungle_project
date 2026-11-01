import { describe, expect, it } from 'bun:test';
import { PublishOutboxBatch } from '../../../src/application/outbox/publish-outbox-batch.js';
import { recordEvent } from '../../../src/infrastructure/observability/metered-log.js';
import {
  METRIC,
  Metrics,
} from '../../../src/infrastructure/observability/metrics.js';
import { OutboxPublisherWorker } from '../../../src/infrastructure/outbox/outbox-publisher-worker.js';
import { MemoryLog } from '../../messaging/support.js';
import {
  SequentialIds,
  TestClock,
} from '../application/support/in-memory-unit-of-work.js';
import {
  balanceChanged,
  claimed,
  FakeStore,
  FakeTransport,
} from '../application/outbox/support.js';

class FailingStore extends FakeStore {
  failures = 0;

  override async claim(
    ...args: Parameters<FakeStore['claim']>
  ): ReturnType<FakeStore['claim']> {
    this.failures += 1;
    if (this.failures <= 3) {
      throw Object.assign(new Error('down'), {
        code: 'PERSISTENCE_UNAVAILABLE',
      });
    }
    return super.claim(...args);
  }
}

function worker(store: FakeStore, idlePollMs = 100) {
  const log = new MemoryLog();
  const batch = new PublishOutboxBatch(
    store,
    new FakeTransport(),
    new TestClock(),
    new SequentialIds(),
    {
      owner: 'p1',
      leaseMs: 30_000,
      maxGroups: 10,
      maxPerGroup: 10,
      sendBudgetMs: 1_000,
    },
  );
  return {
    log,
    worker: new OutboxPublisherWorker(
      batch,
      {
        publisherId: 'p1',
        idlePollMs,
        errorBackoffMaxMs: 400,
        shutdownGraceMs: 2_000,
      },
      log,
    ),
  };
}

describe('OutboxPublisherWorker', () => {
  it('sleeps between empty polls instead of busy looping', async () => {
    const { worker: publisher } = worker(new FakeStore(), 100);
    const running = publisher.start();
    await Bun.sleep(450);
    await publisher.stop();
    await running;
    expect(publisher.cycles).toBeGreaterThanOrEqual(3);
    expect(publisher.cycles).toBeLessThanOrEqual(6);
  });

  it('logs claims and publications with correlation data', async () => {
    const store = new FakeStore();
    const message = balanceChanged('wallet-x');
    store.groups = [[claimed(message, 'wallet-x', 'old-owner')]];
    const { worker: publisher, log } = worker(store);
    const running = publisher.start();
    await Bun.sleep(150);
    await publisher.stop();
    await running;
    expect(log.events('outbox.claimed')[0]?.fields).toMatchObject({
      claimed: 1,
      groups: 1,
    });
    expect(log.events('outbox.lease_recovered')[0]?.fields).toMatchObject({
      eventId: message.id,
      previousOwner: 'old-owner',
    });
    expect(log.events('outbox.published')[0]?.fields).toMatchObject({
      eventId: message.id,
      eventType: 'WalletBalanceChanged',
      aggregateId: 'wallet-x',
      groupKey: 'wallet-x',
      correlationId: expect.stringMatching(/^corr-/),
      attempt: 1,
      result: 'PUBLISHED',
    });
    expect(JSON.stringify(log.entries)).not.toContain('"amount"');
    const metrics = new Metrics();
    for (const entry of log.entries) {
      recordEvent(metrics, entry.event, entry.fields);
    }
    expect(
      metrics.counterValue(METRIC.operations, {
        source: 'outbox_publisher',
        result: 'PUBLISHED',
      }),
    ).toBe(1);
  });

  it('backs off exponentially while the store is unavailable and then recovers', async () => {
    const store = new FailingStore();
    const { worker: publisher, log } = worker(store, 50);
    const running = publisher.start();
    await Bun.sleep(700);
    await publisher.stop();
    await running;
    expect(
      log.events('publisher.cycle_failed').map((e) => e.fields.backoffMs),
    ).toEqual([50, 100, 200]);
    expect(publisher.cycles).toBeGreaterThanOrEqual(1);
  });

  it('stops promptly and reports a graceful shutdown', async () => {
    const { worker: publisher, log } = worker(new FakeStore(), 10_000);
    const running = publisher.start();
    await Bun.sleep(50);
    const startedAt = Date.now();
    await publisher.stop();
    await running;
    expect(Date.now() - startedAt).toBeLessThan(500);
    expect(publisher.state).toBe('STOPPED');
    expect(log.events('publisher.stopped')[0]?.fields.graceful).toBe(true);
  });
});
