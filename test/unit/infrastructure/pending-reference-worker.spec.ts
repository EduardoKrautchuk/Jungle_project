import { describe, expect, it } from 'bun:test';
import { ResolvePendingReference } from '../../../src/application/wagering/resolve-pending-reference.js';
import { recordEvent } from '../../../src/infrastructure/observability/metered-log.js';
import {
  METRIC,
  Metrics,
} from '../../../src/infrastructure/observability/metrics.js';
import { PendingReferenceWorker } from '../../../src/infrastructure/pending/pending-reference-worker.js';
import { MemoryLog } from '../../messaging/support.js';
import {
  createHarness,
  openWallet,
  wager,
} from '../application/support/wagering-harness.js';

async function setup(idlePollMs = 100) {
  const h = createHarness();
  const resolver = new ResolvePendingReference(
    h.uow,
    h.settlement,
    h.clock,
    h.ids,
    { maxAttempts: 5, baseDelayMs: 1_000, maxDelayMs: 4_000 },
  );
  const log = new MemoryLog();
  const worker = new PendingReferenceWorker(
    resolver,
    {
      workerId: 'pending-1',
      batchSize: 10,
      idlePollMs,
      errorBackoffMaxMs: 400,
      shutdownGraceMs: 2_000,
    },
    log,
  );
  return { h, worker, log };
}

describe('PendingReferenceWorker', () => {
  it('sleeps between empty polls', async () => {
    const { worker } = await setup(100);
    const running = worker.start();
    await Bun.sleep(450);
    await worker.stop();
    await running;
    expect(worker.cycles).toBeGreaterThanOrEqual(3);
    expect(worker.cycles).toBeLessThanOrEqual(6);
  });

  it('resolves due pendings and logs structured outcomes', async () => {
    const { h, worker, log } = await setup();
    const wallet = await openWallet(h);
    const refund = await h.submit.execute(
      wager(wallet, {
        kind: 'REFUND',
        referenceExternalTransactionId: 'bet-late',
      }),
    );
    await h.submit.execute(
      wager(wallet, { externalTransactionId: 'bet-late' }),
    );
    h.clock.advance(1_000);
    const running = worker.start();
    await Bun.sleep(200);
    await worker.stop();
    await running;
    expect(log.events('pending.resolution')[0]?.fields).toMatchObject({
      workerId: 'pending-1',
      transactionId: refund.transactionId,
      walletId: wallet.id,
      providerId: 'provider-a',
      result: 'PROCESSED',
      attempt: 1,
    });
    expect(typeof log.events('pending.resolution')[0]?.fields.durationMs).toBe(
      'number',
    );
    const metrics = new Metrics();
    for (const entry of log.entries) {
      recordEvent(metrics, entry.event, entry.fields);
    }
    expect(
      metrics.counterValue(METRIC.operations, {
        source: 'pending_worker',
        result: 'PROCESSED',
      }),
    ).toBe(1);
  });

  it('logs failures without consuming the attempt and keeps polling', async () => {
    const { h, worker, log } = await setup();
    const wallet = await openWallet(h);
    const refund = await h.submit.execute(
      wager(wallet, {
        kind: 'REFUND',
        referenceExternalTransactionId: 'bet-late',
      }),
    );
    await h.submit.execute(
      wager(wallet, { externalTransactionId: 'bet-late' }),
    );
    h.clock.advance(1_000);
    h.uow.faults.add('ledger.append');
    const running = worker.start();
    await Bun.sleep(250);
    h.uow.faults.clear();
    await Bun.sleep(250);
    await worker.stop();
    await running;
    expect(log.events('pending.resolution_failed')[0]?.fields).toMatchObject({
      transactionId: refund.transactionId,
      result: 'UNEXPECTED_FAILURE',
      errorCode: 'InjectedFault',
      attempt: 0,
    });
    expect(
      log.events('pending.resolution').map((e) => e.fields.result),
    ).toEqual(['PROCESSED']);
  });

  it('stops promptly', async () => {
    const { worker, log } = await setup(10_000);
    const running = worker.start();
    await Bun.sleep(50);
    const startedAt = Date.now();
    await worker.stop();
    await running;
    expect(Date.now() - startedAt).toBeLessThan(500);
    expect(log.events('pending_worker.stopped')[0]?.fields.graceful).toBe(true);
  });
});
