import { beforeEach, describe, expect, it } from 'bun:test';
import { PublishOutboxBatch } from '../../../../src/application/outbox/publish-outbox-batch.js';
import { EventTransportError } from '../../../../src/application/ports/outbox-publication.js';
import { SequentialIds, TestClock } from '../support/in-memory-unit-of-work.js';
import {
  balanceChanged,
  claimed,
  FakeStore,
  FakeTransport,
  rehydrated,
} from './support.js';

let store: FakeStore;
let transport: FakeTransport;

function batch(overrides: { leaseMs?: number; sendBudgetMs?: number } = {}) {
  return new PublishOutboxBatch(
    store,
    transport,
    new TestClock(),
    new SequentialIds(),
    {
      owner: 'publisher-1',
      leaseMs: overrides.leaseMs ?? 30_000,
      maxGroups: 7,
      maxPerGroup: 3,
      sendBudgetMs: overrides.sendBudgetMs ?? 1_000,
    },
    () => 0.5,
  );
}

beforeEach(() => {
  store = new FakeStore();
  transport = new FakeTransport();
});

describe('PublishOutboxBatch', () => {
  it('claims with its limits, publishes and confirms with the claim token', async () => {
    const message = balanceChanged('wallet-a');
    store.groups = [[claimed(message, 'wallet-a')]];
    const report = await batch().run();

    expect(store.requests).toEqual([
      {
        owner: 'publisher-1',
        token: report.token,
        leaseMs: 30_000,
        maxGroups: 7,
        maxPerGroup: 3,
      },
    ]);
    expect(transport.sent.map((e) => [e.eventId, e.groupKey])).toEqual([
      [message.id, 'wallet-a'],
    ]);
    expect(store.confirmed).toEqual([
      {
        id: message.id,
        token: report.token,
        transportMessageId: `sqs-${message.id}`,
      },
    ]);
    expect(report.outcomes.map((o) => [o.result, o.attempt])).toEqual([
      ['PUBLISHED', 1],
    ]);
  });

  it('returns an empty report without touching the transport when nothing is due', async () => {
    const report = await batch().run();
    expect(report).toMatchObject({ claimed: 0, groups: 0, outcomes: [] });
    expect(transport.sent).toHaveLength(0);
  });

  it('publishes a group in order and groups in parallel', async () => {
    const a = [balanceChanged('a'), balanceChanged('a'), balanceChanged('a')];
    const b = [balanceChanged('b'), balanceChanged('b')];
    store.groups = [
      a.map((m) => claimed(m, 'a')),
      b.map((m) => claimed(m, 'b')),
    ];
    transport.delayMs = 20;
    const startedAt = performance.now();
    await batch().run();
    const elapsed = performance.now() - startedAt;
    expect(
      transport.sent.filter((e) => e.groupKey === 'a').map((e) => e.eventId),
    ).toEqual(a.map((m) => m.id));
    expect(
      transport.sent.filter((e) => e.groupKey === 'b').map((e) => e.eventId),
    ).toEqual(b.map((m) => m.id));
    expect(elapsed).toBeLessThan(5 * 20);
  });

  it('keeps a failed event eligible with backoff and stops its group', async () => {
    const [first, second, third] = [
      balanceChanged('a'),
      balanceChanged('a'),
      balanceChanged('a'),
    ];
    if (first === undefined || second === undefined || third === undefined) {
      throw new Error('setup');
    }
    store.groups = [[first, second, third].map((m) => claimed(m, 'a'))];
    transport.failures.set(
      first.id,
      new EventTransportError('TRANSIENT', 'TimeoutError'),
    );

    const report = await batch().run();

    expect(store.confirmed).toHaveLength(0);
    expect(store.rescheduled).toEqual([
      { id: first.id, attempts: 1, delayMs: 900, error: 'TimeoutError' },
    ]);
    expect(store.released).toEqual([second.id, third.id]);
    expect(transport.sent).toHaveLength(0);
    expect(report.outcomes).toHaveLength(1);
    expect(report.outcomes[0]).toMatchObject({
      result: 'RETRY_SCHEDULED',
      errorCode: 'TimeoutError',
      failureKind: 'TRANSIENT',
      retryInMs: 900,
      attempt: 1,
    });
  });

  it('grows the retry delay with the persisted attempt count', async () => {
    const base = balanceChanged('a');
    const third = rehydrated(base, { ...base.payload });
    third.scheduleRetry(new Date('2026-07-29T15:00:00.000Z'));
    third.scheduleRetry(new Date('2026-07-29T15:00:00.000Z'));
    store.groups = [[claimed(third, 'a')]];
    transport.failures.set(third.id, new Error('ECONNRESET'));
    await batch().run();
    expect(store.rescheduled[0]).toMatchObject({
      attempts: 3,
      delayMs: 3_600,
    });
  });

  it('treats configuration errors as retryable without losing the event', async () => {
    const message = balanceChanged('a');
    store.groups = [[claimed(message, 'a')]];
    transport.failures.set(
      message.id,
      new EventTransportError('CONFIGURATION', 'QueueDoesNotExist'),
    );
    const report = await batch().run();
    expect(report.outcomes[0]).toMatchObject({
      result: 'RETRY_SCHEDULED',
      failureKind: 'CONFIGURATION',
    });
    expect(store.deadLettered).toHaveLength(0);
  });

  it('dead-letters rejected or invalid events and keeps the group moving', async () => {
    const rejected = balanceChanged('a');
    const invalidBase = balanceChanged('a');
    const invalid = rehydrated(invalidBase, {
      ...invalidBase.payload,
      eventId: 'tampered',
    });
    const healthy = balanceChanged('a');
    store.groups = [[rejected, invalid, healthy].map((m) => claimed(m, 'a'))];
    transport.failures.set(
      rejected.id,
      new EventTransportError('REJECTED', 'InvalidMessageContents'),
    );
    const report = await batch().run();
    expect(store.deadLettered).toEqual([
      { id: rejected.id, error: 'InvalidMessageContents' },
      { id: invalid.id, error: 'EVENT_ID_MISMATCH' },
    ]);
    expect(report.outcomes.map((o) => o.result)).toEqual([
      'DEAD_LETTERED',
      'DEAD_LETTERED',
      'PUBLISHED',
    ]);
  });

  it('stops a group when its lease was taken over', async () => {
    const [first, second] = [balanceChanged('a'), balanceChanged('a')];
    if (first === undefined || second === undefined) {
      throw new Error('setup');
    }
    store.groups = [[first, second].map((m) => claimed(m, 'a'))];
    store.confirmResult = false;
    const report = await batch().run();
    expect(report.outcomes.map((o) => o.result)).toEqual(['LEASE_LOST']);
    expect(transport.sent).toHaveLength(1);
    expect(store.released).toEqual([second.id]);
  });

  it('reports a confirmation failure after a successful send without retrying it', async () => {
    const message = balanceChanged('a');
    store.groups = [[claimed(message, 'a')]];
    store.confirmResult = Object.assign(new Error('db down'), {
      code: 'PERSISTENCE_UNAVAILABLE',
    });
    const report = await batch().run();
    expect(report.outcomes[0]).toMatchObject({
      result: 'CONFIRMATION_FAILED',
      errorCode: 'PERSISTENCE_UNAVAILABLE',
      transportMessageId: `sqs-${message.id}`,
    });
    expect(store.rescheduled).toHaveLength(0);
  });

  it('defers the rest of a group when the lease budget is exhausted', async () => {
    const [first, second] = [balanceChanged('a'), balanceChanged('a')];
    if (first === undefined || second === undefined) {
      throw new Error('setup');
    }
    store.groups = [[first, second].map((m) => claimed(m, 'a'))];
    transport.delayMs = 60;
    const report = await batch({ leaseMs: 1_050, sendBudgetMs: 1_000 }).run();
    expect(report.outcomes.map((o) => o.result)).toEqual([
      'PUBLISHED',
      'DEFERRED',
    ]);
    expect(store.released).toEqual([second.id]);
  });

  it('flags recovered leases with the previous owner', async () => {
    const message = balanceChanged('a');
    store.groups = [[claimed(message, 'a', 'dead-publisher')]];
    const report = await batch().run();
    expect(report.outcomes[0]?.recoveredFrom).toBe('dead-publisher');
  });

  it('publishes events of different versions with their own version attribute', async () => {
    const v1 = balanceChanged('a');
    const base = balanceChanged('b');
    const v2 = rehydrated(base, { ...base.payload, version: 2 });
    store.groups = [[claimed(v1, 'a')], [claimed(v2, 'b')]];
    const report = await batch().run();
    expect(report.outcomes.map((o) => o.result)).toEqual([
      'PUBLISHED',
      'PUBLISHED',
    ]);
    expect(transport.sent.map((e) => [e.eventId, e.version])).toEqual([
      [v1.id, 1],
      [v2.id, 2],
    ]);
  });
});
