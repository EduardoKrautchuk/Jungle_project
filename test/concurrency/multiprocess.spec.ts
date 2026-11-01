import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test';
import type { MikroORM } from '@mikro-orm/postgresql';
import type { Wallet } from '../../src/domain/wallet/wallet.js';
import { MikroOrmUnitOfWork } from '../../src/infrastructure/persistence/mikro-orm-unit-of-work.js';
import {
  persistOpenedWallet,
  sha256,
  sleep,
} from '../integration/persistence/domain-fixtures.js';
import {
  Db,
  migrateFresh,
  openTestOrm,
} from '../integration/persistence/support.js';
import {
  WorkerProcess,
  killAll,
  startTogether,
} from './support/process-harness.js';
import type {
  DebitRequest,
  WorkerJob,
  WorkerResult,
} from './support/protocol.js';

const READY_TIMEOUT_MS = 20_000;
const RESULT_TIMEOUT_MS = 30_000;
const EXIT_TIMEOUT_MS = 10_000;
const TEST_TIMEOUT_MS = 90_000;

let orm: MikroORM;
let uow: MikroOrmUnitOfWork;
let db: Db;

function request(amount: string): DebitRequest {
  const externalTransactionId = `ext-${randomUUID()}`;
  return {
    id: randomUUID(),
    externalTransactionId,
    idempotencyKey: `provider-a:${externalTransactionId}`,
    payloadHash: sha256(`${externalTransactionId}:${amount}`),
    amount,
  };
}

function resend(original: DebitRequest): DebitRequest {
  return { ...original, id: randomUUID() };
}

function job(
  wallet: Wallet,
  requests: DebitRequest[],
  mode: WorkerJob['mode'] = 'debits',
): WorkerJob {
  return { mode, walletId: wallet.id, playerId: wallet.playerId, requests };
}

async function runWorkers(jobs: WorkerJob[]): Promise<WorkerResult[]> {
  const workers = jobs.map((j, i) => WorkerProcess.spawn(`worker-${i + 1}`, j));
  const pids = workers.map((worker) => worker.pid);
  expect(new Set(pids).size).toBe(workers.length);
  expect(pids).not.toContain(process.pid);
  await startTogether(workers, READY_TIMEOUT_MS);
  const results = await Promise.all(
    workers.map((worker) => worker.results(RESULT_TIMEOUT_MS)),
  );
  const exits = await Promise.all(
    workers.map((worker) => worker.exit(EXIT_TIMEOUT_MS)),
  );
  expect(exits).toEqual(workers.map(() => ({ exitCode: 0, signalCode: null })));
  for (const worker of workers) {
    expect(worker.errorOutput).not.toMatch(/deadlock|40P01|Error/);
  }
  const flat = results.flat();
  expect(flat.filter((r) => r.outcome === 'ERROR')).toEqual([]);
  return flat;
}

async function state(walletId: string) {
  const [wallet] = await db.query(
    'SELECT balance, version FROM wallets WHERE id = ?',
    [walletId],
  );
  const transactions = await db.query(
    `SELECT id, status, failure_code, result_balance FROM wager_transactions
     WHERE wallet_id = ? AND kind = 'BET'`,
    [walletId],
  );
  const ledger = await db.query(
    `SELECT direction, amount, balance_before, balance_after, transaction_id
     FROM wallet_ledger_entries WHERE wallet_id = ?`,
    [walletId],
  );
  const outbox = await db.query(
    `SELECT o.aggregate_id, o.event_type FROM outbox_messages o
     JOIN wager_transactions t ON t.id::text = o.aggregate_id
     WHERE t.wallet_id = ?`,
    [walletId],
  );
  const [rebuilt] = await db.query(
    `SELECT COALESCE(SUM(CASE direction WHEN 'CREDIT' THEN amount ELSE -amount END), 0)::numeric(20,2)::text AS total
     FROM wallet_ledger_entries WHERE wallet_id = ?`,
    [walletId],
  );
  return {
    balance: String(wallet?.balance),
    version: Number(wallet?.version),
    transactions,
    ledger,
    debits: ledger.filter((e) => e.direction === 'DEBIT'),
    outbox,
    rebuilt: String(rebuilt?.total),
  };
}

function expectContiguousChain(
  ledger: Awaited<ReturnType<typeof state>>['ledger'],
  initial: string,
): void {
  const byBefore = new Map(ledger.map((e) => [String(e.balance_before), e]));
  const opening = ledger.find((e) => e.direction === 'CREDIT');
  expect(opening?.balance_after).toBe(initial);
  let current = initial;
  let visited = 1;
  for (;;) {
    const next = byBefore.get(current);
    if (next === undefined || next.direction !== 'DEBIT') {
      break;
    }
    expect(Number(next.balance_before) >= 0).toBe(true);
    current = String(next.balance_after);
    visited += 1;
  }
  expect(visited).toBe(ledger.length);
}

async function openBackendsInTransaction(): Promise<number> {
  const [row] = await db.query(
    `SELECT count(*)::int AS open FROM pg_stat_activity
     WHERE datname = current_database() AND state LIKE 'idle in transaction%'`,
  );
  return Number(row?.open);
}

describe('three independent Bun processes on one PostgreSQL', () => {
  beforeAll(async () => {
    orm = await openTestOrm();
    await migrateFresh(orm);
    uow = new MikroOrmUnitOfWork(orm.em);
    db = new Db(orm);
  });

  afterEach(async () => {
    await killAll();
  });

  afterAll(async () => {
    await killAll();
    await orm.close(true);
  });

  it.each([1, 2, 3, 4, 5])(
    'run %p: two 80.00 bets and a resend on 100.00 debit exactly once',
    async () => {
      const wallet = await persistOpenedWallet(uow, '100.00');
      const betA = request('80.00');
      const betB = request('80.00');

      const results = await runWorkers([
        job(wallet, [betA]),
        job(wallet, [betB]),
        job(wallet, [resend(betA)]),
      ]);

      const firstAttempts = results.filter((r) =>
        ['PROCESSED', 'REJECTED'].includes(r.outcome),
      );
      expect(firstAttempts.map((r) => r.outcome).sort()).toEqual([
        'PROCESSED',
        'REJECTED',
      ]);
      expect(results.filter((r) => r.outcome === 'REPLAY')).toHaveLength(1);

      const final = await state(wallet.id);
      expect(final.balance).toBe('20.00');
      expect(final.version).toBe(2);
      expect(final.debits).toHaveLength(1);
      expect(final.debits[0]).toMatchObject({
        amount: '80.00',
        balance_before: '100.00',
        balance_after: '20.00',
      });
      expect(
        final.transactions
          .map((t) => `${String(t.status)}:${String(t.failure_code)}`)
          .sort((a, b) => a.localeCompare(b)),
      ).toEqual(['PROCESSED:null', 'REJECTED:INSUFFICIENT_FUNDS']);
      expect(final.outbox).toHaveLength(2);
      expect(final.rebuilt).toBe(final.balance);
      expectContiguousChain(final.ledger, '100.00');
    },
    TEST_TIMEOUT_MS,
  );

  it.each([1, 2, 3])(
    'run %p: 50 identical requests across three processes debit once',
    async () => {
      const wallet = await persistOpenedWallet(uow, '100.00');
      const original = request('25.00');
      const copies = Array.from({ length: 50 }, () => resend(original));

      const results = await runWorkers([
        job(wallet, copies.slice(0, 17)),
        job(wallet, copies.slice(17, 34)),
        job(wallet, copies.slice(34)),
      ]);

      expect(results).toHaveLength(50);
      expect(results.filter((r) => r.outcome === 'PROCESSED')).toHaveLength(1);
      const replays = results.filter((r) => r.outcome === 'REPLAY');
      expect(replays).toHaveLength(49);
      for (const replay of replays) {
        expect(replay).toMatchObject({ status: 'PROCESSED', balance: '75.00' });
      }

      const final = await state(wallet.id);
      expect(final.balance).toBe('75.00');
      expect(final.version).toBe(2);
      expect(final.transactions).toHaveLength(1);
      expect(final.debits).toHaveLength(1);
      expect(final.outbox).toEqual([
        {
          aggregate_id: final.transactions[0]?.id ?? '',
          event_type: 'WagerTransactionProcessed',
        },
      ]);
    },
    TEST_TIMEOUT_MS,
  );

  it.each([1, 2, 3])(
    'run %p: distinct concurrent bets never overdraw and chain the ledger',
    async () => {
      const wallet = await persistOpenedWallet(uow, '100.00');
      const amounts = ['7.00', '9.50', '13.25', '4.75'];
      const batch = (offset: number) =>
        Array.from({ length: 12 }, (_, i) =>
          request(amounts[(i + offset) % amounts.length] ?? '1.00'),
        );

      const results = await runWorkers([
        job(wallet, batch(0)),
        job(wallet, batch(1)),
        job(wallet, batch(2)),
      ]);

      const processed = results.filter((r) => r.outcome === 'PROCESSED');
      const rejected = results.filter((r) => r.outcome === 'REJECTED');
      expect(processed.length + rejected.length).toBe(36);
      expect(rejected.length).toBeGreaterThan(0);

      const final = await state(wallet.id);
      expect(Number(final.balance) >= 0).toBe(true);
      expect(final.version).toBe(1 + processed.length);
      expect(final.debits).toHaveLength(processed.length);
      expect(final.rebuilt).toBe(final.balance);
      expect(final.outbox).toHaveLength(36);
      for (const entry of final.debits) {
        expect(Number(entry.balance_after) >= 0).toBe(true);
      }
      expectContiguousChain(final.ledger, '100.00');
      expect(
        final.transactions.filter((t) => t.status === 'REJECTED'),
      ).toHaveLength(rejected.length);
      expect(
        final.transactions.every(
          (t) =>
            t.status !== 'REJECTED' || t.failure_code === 'INSUFFICIENT_FUNDS',
        ),
      ).toBe(true);
    },
    TEST_TIMEOUT_MS,
  );

  it.each([1, 2, 3])(
    'run %p: replays the committed result of another process and flags payload conflicts',
    async () => {
      const wallet = await persistOpenedWallet(uow, '100.00');
      const original = request('25.00');
      await runWorkers([job(wallet, [original])]);

      const tampered = { ...resend(original), payloadHash: sha256('tampered') };
      const results = await runWorkers([
        job(wallet, [resend(original), resend(original)]),
        job(wallet, [resend(original), tampered]),
        job(wallet, [resend(original)]),
      ]);

      expect(results.filter((r) => r.outcome === 'REPLAY')).toHaveLength(4);
      for (const replay of results.filter((r) => r.outcome === 'REPLAY')) {
        expect(replay).toMatchObject({ status: 'PROCESSED', balance: '75.00' });
      }
      expect(results.filter((r) => r.outcome === 'CONFLICT')).toHaveLength(1);

      const final = await state(wallet.id);
      expect(final.balance).toBe('75.00');
      expect(final.version).toBe(2);
      expect(final.debits).toHaveLength(1);
      expect(final.outbox).toHaveLength(1);
    },
    TEST_TIMEOUT_MS,
  );

  it.each([1, 2, 3])(
    'run %p: a process killed before commit leaves no partial debit and does not block others',
    async () => {
      const wallet = await persistOpenedWallet(uow, '100.00');
      const doomed = request('30.00');
      const betB = request('20.00');
      const betC = request('20.00');

      const victim = WorkerProcess.spawn(
        'victim',
        job(wallet, [doomed], 'crash-before-commit'),
      );
      await startTogether([victim], READY_TIMEOUT_MS);
      await victim.waitFor('HOLDING', RESULT_TIMEOUT_MS);

      const survivors = [
        WorkerProcess.spawn('survivor-1', job(wallet, [betB])),
        WorkerProcess.spawn('survivor-2', job(wallet, [betC])),
      ];
      await startTogether(survivors, READY_TIMEOUT_MS);
      await sleep(300);
      expect(survivors.some((s) => s.hasPrinted('RESULT'))).toBe(false);

      victim.kill('SIGKILL');
      expect(await victim.exit(EXIT_TIMEOUT_MS)).toEqual({
        exitCode: null,
        signalCode: 'SIGKILL',
      });

      const survivorResults = (
        await Promise.all(survivors.map((s) => s.results(RESULT_TIMEOUT_MS)))
      ).flat();
      await Promise.all(survivors.map((s) => s.exit(EXIT_TIMEOUT_MS)));
      expect(survivorResults.map((r) => r.outcome)).toEqual([
        'PROCESSED',
        'PROCESSED',
      ]);

      const afterCrash = await state(wallet.id);
      expect(afterCrash.balance).toBe('60.00');
      expect(afterCrash.version).toBe(3);
      expect(afterCrash.transactions.map((t) => t.id)).not.toContain(doomed.id);
      expect(afterCrash.debits).toHaveLength(2);
      expect(afterCrash.outbox).toHaveLength(2);
      expect(afterCrash.rebuilt).toBe('60.00');
      expect(await openBackendsInTransaction()).toBe(0);

      const [retried] = await runWorkers([job(wallet, [resend(doomed)])]);
      expect(retried).toMatchObject({ outcome: 'PROCESSED', balance: '30.00' });
      const [again] = await runWorkers([job(wallet, [resend(doomed)])]);
      expect(again).toMatchObject({
        outcome: 'REPLAY',
        status: 'PROCESSED',
        balance: '30.00',
      });

      const final = await state(wallet.id);
      expect(final.balance).toBe('30.00');
      expect(final.version).toBe(4);
      expect(final.debits).toHaveLength(3);
      expectContiguousChain(final.ledger, '100.00');
    },
    TEST_TIMEOUT_MS,
  );

  it.each([1, 2, 3])(
    'run %p: a process killed right after commit keeps every record consistent',
    async () => {
      const wallet = await persistOpenedWallet(uow, '100.00');
      const committed = request('30.00');

      const victim = WorkerProcess.spawn(
        'victim',
        job(wallet, [committed], 'crash-after-commit'),
      );
      await startTogether([victim], READY_TIMEOUT_MS);
      const report = await victim.waitFor('COMMITTED', RESULT_TIMEOUT_MS);
      victim.kill('SIGKILL');
      expect(await victim.exit(EXIT_TIMEOUT_MS)).toEqual({
        exitCode: null,
        signalCode: 'SIGKILL',
      });
      expect(JSON.parse(report)).toMatchObject({
        outcome: 'PROCESSED',
        balance: '70.00',
      });

      const afterCrash = await state(wallet.id);
      expect(afterCrash.balance).toBe('70.00');
      expect(afterCrash.version).toBe(2);
      expect(afterCrash.transactions).toEqual([
        {
          id: committed.id,
          status: 'PROCESSED',
          failure_code: null,
          result_balance: '70.00',
        },
      ]);
      expect(afterCrash.debits).toHaveLength(1);
      expect(afterCrash.outbox).toEqual([
        { aggregate_id: committed.id, event_type: 'WagerTransactionProcessed' },
      ]);
      expect(afterCrash.rebuilt).toBe('70.00');
      expect(await openBackendsInTransaction()).toBe(0);

      const results = await runWorkers([
        job(wallet, [resend(committed), resend(committed), resend(committed)]),
        job(wallet, [resend(committed), resend(committed), resend(committed)]),
      ]);
      expect(results.map((r) => r.outcome)).toEqual(
        Array.from({ length: 6 }, () => 'REPLAY'),
      );

      const final = await state(wallet.id);
      expect(final.balance).toBe('70.00');
      expect(final.version).toBe(2);
      expect(final.debits).toHaveLength(1);
      expect(final.outbox).toHaveLength(1);
    },
    TEST_TIMEOUT_MS,
  );
});
