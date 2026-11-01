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
import type { MikroORM } from '@mikro-orm/postgresql';
import {
  Db,
  migrateFresh,
  openTestOrm,
} from '../integration/persistence/support.js';
import {
  assertLedgerMatchesBalance,
  createTestQueues,
  deleteTestQueues,
  envelope,
  queueDepth,
  send,
  sqsClient,
  wagerData,
  type TestQueues,
} from '../messaging/support.js';
import {
  balance,
  command,
  ledgerChainBreaks,
  openWallet,
  stack,
  uniqueRef,
  type Stack,
  type WalletRef,
} from '../pending/support.js';
import { killAll, WorkerProcess } from './support/process-harness.js';

setDefaultTimeout(120_000);

let orm: MikroORM;
let db: Db;
let s: Stack;
let deadlocksBefore = 0;

const FAULT_SQL = {
  install: [
    `CREATE TABLE IF NOT EXISTS pending_fault_config (id integer PRIMARY KEY, sleep_seconds integer NOT NULL)`,
    `CREATE OR REPLACE FUNCTION pending_slow_resolution() RETURNS trigger AS $$
     DECLARE
       configured integer;
     BEGIN
       SELECT sleep_seconds INTO configured FROM pending_fault_config WHERE id = 1;
       IF configured IS NOT NULL THEN
         PERFORM pg_sleep(configured);
       END IF;
       RETURN NEW;
     END
     $$ LANGUAGE plpgsql`,
    `CREATE OR REPLACE TRIGGER pending_slow_resolution
       BEFORE UPDATE ON wager_transactions
       FOR EACH ROW
       WHEN (OLD.status = 'PENDING_REFERENCE' AND NEW.status = 'PROCESSED')
       EXECUTE FUNCTION pending_slow_resolution()`,
  ],
  uninstall: [
    'DROP TRIGGER IF EXISTS pending_slow_resolution ON wager_transactions',
    'DROP FUNCTION IF EXISTS pending_slow_resolution()',
    'DROP TABLE IF EXISTS pending_fault_config',
  ],
};

async function deadlocks(): Promise<number> {
  const [row] = await db.query(
    'SELECT deadlocks::int AS n FROM pg_stat_database WHERE datname = current_database()',
  );
  return Number(row?.n);
}

beforeAll(async () => {
  orm = await openTestOrm();
  await migrateFresh(orm);
  db = new Db(orm);
  for (const sql of FAULT_SQL.install) {
    await db.query(sql);
  }
});

afterAll(async () => {
  await killAll();
  for (const sql of FAULT_SQL.uninstall) {
    await db.query(sql);
  }
  await orm.close(true);
});

beforeEach(async () => {
  await db.query('DELETE FROM pending_fault_config');
  await db.query(
    `UPDATE wager_transactions SET next_reference_attempt_at = '2100-01-01T00:00:00Z'
      WHERE status = 'PENDING_REFERENCE'`,
  );
  s = stack(orm);
  deadlocksBefore = await deadlocks();
});

afterEach(async () => {
  await killAll();
  await db.query('DELETE FROM pending_fault_config');
  expect(await assertLedgerMatchesBalance(db)).toEqual([]);
  expect(await ledgerChainBreaks(db)).toBe(0);
  expect(await count('wallets WHERE balance < 0')).toBe(0);
  await waitUntil(
    async () =>
      (await count(
        "pg_stat_activity WHERE datname = current_database() AND state = 'idle in transaction' AND pid <> pg_backend_pid()",
      )) === 0,
    10_000,
  );
  await Bun.sleep(600);
  expect(await deadlocks()).toBe(deadlocksBefore);
});

async function count(sql: string, params: unknown[] = []): Promise<number> {
  const [row] = await db.query(`SELECT count(*)::int AS n FROM ${sql}`, params);
  return Number(row?.n);
}

async function waitUntil(
  condition: () => Promise<boolean> | boolean,
  timeoutMs = 30_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) {
      return;
    }
    await Bun.sleep(50);
  }
  throw new Error(`condition not met within ${timeoutMs}ms`);
}

let workerSequence = 0;

async function spawnWorkers(
  amount: number,
  extra: Record<string, string> = {},
): Promise<WorkerProcess[]> {
  const workers = Array.from({ length: amount }, () => {
    workerSequence += 1;
    const name = `pending-${workerSequence}`;
    return WorkerProcess.spawnPendingWorker(name, {
      PENDING_WORKER_ID: name,
      PENDING_REFERENCE_BASE_DELAY_MS: '100',
      PENDING_REFERENCE_MAX_DELAY_MS: '400',
      PENDING_REFERENCE_MAX_ATTEMPTS: '500',
      PENDING_WORKER_IDLE_POLL_MS: '50',
      PENDING_WORKER_BATCH_SIZE: '20',
      PENDING_WORKER_SHUTDOWN_GRACE_MS: '10000',
      ...extra,
    });
  });
  await Promise.all(workers.map((worker) => worker.waitFor('READY', 30_000)));
  return workers;
}

async function spawnServers(amount: number): Promise<string[]> {
  const servers = Array.from({ length: amount }, (_, index) =>
    WorkerProcess.spawnServer(`api-${index + 1}`),
  );
  return Promise.all(servers.map((server) => server.waitFor('READY', 30_000)));
}

interface HttpBody {
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: string;
  money: { amount: string; currency: string };
  referenceExternalTransactionId?: string;
}

function httpBody(
  wallet: WalletRef,
  overrides: Partial<HttpBody> = {},
): HttpBody {
  return {
    providerId: 'provider-a',
    externalTransactionId: uniqueRef('http'),
    playerId: wallet.playerId,
    walletId: wallet.id,
    roundId: 'round-1',
    gameId: 'fortune-chimp',
    kind: 'BET',
    money: { amount: '10.00', currency: 'BRL' },
    ...overrides,
  };
}

async function post(url: string, body: HttpBody): Promise<number> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const response = await fetch(`${url}/wagering/transactions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'idempotency-key': `${body.providerId}:${body.externalTransactionId}`,
      },
      body: JSON.stringify(body),
    });
    await response.arrayBuffer();
    if (response.status !== 503) {
      return response.status;
    }
    await Bun.sleep(100);
  }
  throw new Error('API stayed unavailable');
}

async function statusOf(
  walletId: string,
  externalTransactionId: string,
): Promise<string> {
  const [row] = await db.query(
    'SELECT status, failure_code FROM wager_transactions WHERE wallet_id = ? AND external_transaction_id = ?',
    [walletId, externalTransactionId],
  );
  return `${String(row?.status)}${row?.failure_code ? `:${String(row.failure_code)}` : ''}`;
}

const noPendingFor = (walletId: string) => async () =>
  (await count(
    "wager_transactions WHERE wallet_id = ? AND status IN ('PENDING', 'PENDING_REFERENCE')",
    [walletId],
  )) === 0;

function resolutions(workers: readonly WorkerProcess[], result: string) {
  return workers.flatMap((worker) => worker.output(`"result":"${result}"`));
}

async function walletConsistency(walletId: string): Promise<void> {
  const [row] = await db.query(
    `SELECT w.version, (SELECT count(*)::int FROM wallet_ledger_entries l WHERE l.wallet_id = w.id) AS entries
       FROM wallets w WHERE w.id = ?`,
    [walletId],
  );
  expect(Number(row?.version)).toBe(Math.max(1, Number(row?.entries)));
  const [events] = await db.query(
    `SELECT
       (SELECT count(*)::int FROM outbox_messages WHERE aggregate_id = ? AND event_type = 'WalletBalanceChanged') AS balance_events,
       (SELECT count(*)::int FROM wallet_ledger_entries WHERE wallet_id = ?) AS entries`,
    [walletId, walletId],
  );
  expect(Number(events?.balance_events)).toBe(Number(events?.entries));
  const duplicated = await db.query(
    `SELECT t.id FROM wager_transactions t
      WHERE t.wallet_id = ? AND t.status IN ('PROCESSED', 'REJECTED')
        AND (SELECT count(*) FROM outbox_messages o
              WHERE o.aggregate_id = t.id::text
                AND o.event_type IN ('WagerTransactionProcessed', 'WagerTransactionRejected')) <> 1`,
    [walletId],
  );
  expect(duplicated).toEqual([]);
  const reversals = await db.query(
    `SELECT reference_transaction_id FROM wager_transactions
      WHERE wallet_id = ? AND status = 'PROCESSED' AND kind IN ('REFUND', 'ROLLBACK')
      GROUP BY reference_transaction_id HAVING count(*) > 1`,
    [walletId],
  );
  expect(reversals).toEqual([]);
}

describe('pending reference workers in independent Bun processes', () => {
  it.each([1, 2, 3])(
    'A: three workers settle a single pending exactly once (run %i)',
    async () => {
      const wallet = await openWallet(s);
      const betId = uniqueRef('bet');
      const refund = await s.submit.execute(
        command(wallet, {
          kind: 'REFUND',
          referenceExternalTransactionId: betId,
        }),
      );
      const workers = await spawnWorkers(3);
      await s.submit.execute(command(wallet, { externalTransactionId: betId }));
      await waitUntil(noPendingFor(wallet.id));
      await Bun.sleep(500);

      expect(
        resolutions(workers, 'PROCESSED').filter((line) =>
          line.includes(refund.transactionId),
        ),
      ).toHaveLength(1);
      expect(
        await count(
          "wallet_ledger_entries WHERE wallet_id = ? AND direction = 'CREDIT'",
          [wallet.id],
        ),
      ).toBe(2);
      expect(await balance(db, wallet.id)).toBe('100.00');
      await walletConsistency(wallet.id);
    },
  );

  it('A: three concurrent workers resolve a shared backlog of pendings exactly once', async () => {
    const wallets: WalletRef[] = [];
    const pendingIds: string[] = [];
    for (let index = 0; index < 30; index += 1) {
      const wallet = await openWallet(s);
      const betId = uniqueRef('bet');
      const refund = await s.submit.execute(
        command(wallet, {
          kind: 'REFUND',
          referenceExternalTransactionId: betId,
        }),
      );
      await s.submit.execute(command(wallet, { externalTransactionId: betId }));
      wallets.push(wallet);
      pendingIds.push(refund.transactionId);
    }
    const idList = pendingIds.map(() => '?').join(', ');
    await db.query(
      `UPDATE wager_transactions SET next_reference_attempt_at = '2100-01-01T00:00:00Z'
        WHERE id IN (${idList})`,
      pendingIds,
    );
    const workers = await spawnWorkers(3);
    await waitUntil(() =>
      workers.every(
        (worker) =>
          worker.output('"event":"pending_worker.started"').length > 0,
      ),
    );
    const released = await db.query(
      `UPDATE wager_transactions SET next_reference_attempt_at = now() - interval '1 second'
        WHERE id IN (${idList}) AND status = 'PENDING_REFERENCE'
        RETURNING id`,
      pendingIds,
    );
    expect(released).toHaveLength(30);
    await waitUntil(async () => {
      for (const wallet of wallets) {
        if (!(await noPendingFor(wallet.id)())) {
          return false;
        }
      }
      return true;
    }, 60_000);
    expect(new Set(workers.map((worker) => worker.pid)).size).toBe(3);
    for (const worker of workers) {
      expect(process.kill(worker.pid, 0)).toBe(true);
      expect(worker.output('"result":"UNEXPECTED_FAILURE"')).toHaveLength(0);
    }
    for (const transactionId of pendingIds) {
      const applied = workers.flatMap((worker) =>
        worker
          .output('"result":"PROCESSED"')
          .filter((line) => line.includes(transactionId)),
      );
      expect(applied).toHaveLength(1);
    }
    expect(
      await count(
        `wager_transactions WHERE id IN (${idList}) AND status = 'PROCESSED'`,
        pendingIds,
      ),
    ).toBe(30);
    expect(
      await count(
        `wallet_ledger_entries WHERE transaction_id IN (${idList}) AND direction = 'CREDIT'`,
        pendingIds,
      ),
    ).toBe(30);
    for (const wallet of wallets) {
      expect(await balance(db, wallet.id)).toBe('100.00');
      expect(
        await count('wallet_ledger_entries WHERE wallet_id = ?', [wallet.id]),
      ).toBe(3);
      await walletConsistency(wallet.id);
    }
  });

  it.each([1, 2, 3])(
    'B: workers and three API processes share one wallet without deadlocks (run %i)',
    async () => {
      const wallet = await openWallet(s, '500.00');
      const urls = await spawnServers(3);
      await spawnWorkers(3);
      const bets = Array.from({ length: 15 }, () =>
        httpBody(wallet, { externalTransactionId: uniqueRef('bet') }),
      );
      const reversals = bets.slice(0, 12).map((bet, index) =>
        httpBody(wallet, {
          kind: index < 8 ? 'REFUND' : 'ROLLBACK',
          referenceExternalTransactionId: bet.externalTransactionId,
        }),
      );
      const requests = [
        ...reversals.slice(0, 6),
        ...bets,
        ...reversals.slice(6),
      ];
      const statuses = await Promise.all(
        requests.map((body, index) =>
          post(urls[index % urls.length] ?? '', body),
        ),
      );
      expect(statuses.every((status) => [200, 202].includes(status))).toBe(
        true,
      );
      await waitUntil(noPendingFor(wallet.id), 60_000);

      for (const reversal of reversals) {
        expect(await statusOf(wallet.id, reversal.externalTransactionId)).toBe(
          'PROCESSED',
        );
      }
      expect(await balance(db, wallet.id)).toBe('470.00');
      await walletConsistency(wallet.id);
    },
  );

  it('C: a reference delivered through SQS while workers resolve the pending is applied once', async () => {
    const client = sqsClient();
    const queues: TestQueues = await createTestQueues(client);
    try {
      const wallet = await openWallet(s);
      const betData = wagerData(wallet);
      const refund = envelope(
        wagerData(wallet, {
          kind: 'REFUND',
          referenceExternalTransactionId: betData.externalTransactionId,
        }),
      );
      const consumerEnv = {
        SQS_WAGER_QUEUE_URL: queues.queueUrl,
        SQS_WAGER_DLQ_URL: queues.deadLetterQueueUrl,
        SQS_WAIT_TIME_SECONDS: '1',
        SQS_REQUEST_TIMEOUT_MS: '5000',
        SQS_VISIBILITY_TIMEOUT_SECONDS: '4',
        SQS_MAX_RECEIVE_COUNT: '3',
        SQS_RETRY_BASE_SECONDS: '1',
        SQS_RETRY_MAX_SECONDS: '2',
      };
      const consumers = [
        WorkerProcess.spawnSqsWorker('sqs-1', consumerEnv),
        WorkerProcess.spawnSqsWorker('sqs-2', consumerEnv),
      ];
      await Promise.all(consumers.map((c) => c.waitFor('READY', 30_000)));
      const workers = await spawnWorkers(2);

      await send(client, queues, refund);
      await waitUntil(
        async () =>
          (await statusOf(wallet.id, refund.data.externalTransactionId)) ===
          'PENDING_REFERENCE',
      );
      const bet = envelope(betData);
      await Promise.all([
        send(client, queues, bet, { groupId: 'c-1' }),
        send(client, queues, bet, { groupId: 'c-2' }),
        send(client, queues, envelope(betData), { groupId: 'c-3' }),
        send(client, queues, envelope(betData), { groupId: 'c-4' }),
      ]);
      await waitUntil(noPendingFor(wallet.id), 60_000);
      await waitUntil(async () => {
        const depth = await queueDepth(client, queues.queueUrl);
        return depth.visible + depth.inFlight + depth.delayed === 0;
      }, 60_000);

      expect(await statusOf(wallet.id, refund.data.externalTransactionId)).toBe(
        'PROCESSED',
      );
      expect(
        await count(
          "wallet_ledger_entries WHERE wallet_id = ? AND direction = 'DEBIT'",
          [wallet.id],
        ),
      ).toBe(1);
      expect(
        await count(
          "wallet_ledger_entries WHERE wallet_id = ? AND direction = 'CREDIT'",
          [wallet.id],
        ),
      ).toBe(2);
      expect(await count('inbox_messages WHERE processed_at IS NULL')).toBe(0);
      expect(
        await count('inbox_messages WHERE message_id IN (?, ?)', [
          refund.messageId,
          bet.messageId,
        ]),
      ).toBe(2);
      expect(resolutions(workers, 'PROCESSED').length).toBeLessThanOrEqual(1);
      await walletConsistency(wallet.id);
    } finally {
      await killAll();
      await deleteTestQueues(client, queues);
      client.destroy();
    }
  });

  it.each([1, 2, 3])(
    'D: competing REFUNDs and ROLLBACK for one late BET reverse it only once (run %i)',
    async () => {
      const wallet = await openWallet(s);
      const betId = uniqueRef('bet');
      const reversals = [];
      for (const kind of [
        'REFUND',
        'ROLLBACK',
        'REFUND',
        'ROLLBACK',
      ] as const) {
        reversals.push(
          await s.submit.execute(
            command(wallet, { kind, referenceExternalTransactionId: betId }),
          ),
        );
      }
      await spawnWorkers(3);
      await s.submit.execute(command(wallet, { externalTransactionId: betId }));
      await waitUntil(noPendingFor(wallet.id));

      const rows = await db.query(
        `SELECT status, failure_code FROM wager_transactions
          WHERE id IN (?, ?, ?, ?)`,
        reversals.map((r) => r.transactionId),
      );
      expect(rows.filter((row) => row.status === 'PROCESSED')).toHaveLength(1);
      expect(
        rows
          .filter((row) => row.status !== 'PROCESSED')
          .map((row) => `${String(row.status)}:${String(row.failure_code)}`),
      ).toEqual([
        'REJECTED:ALREADY_REVERSED',
        'REJECTED:ALREADY_REVERSED',
        'REJECTED:ALREADY_REVERSED',
      ]);
      expect(await balance(db, wallet.id)).toBe('100.00');
      await walletConsistency(wallet.id);
    },
  );

  it('E: SIGKILL in the middle of the settlement rolls back and another worker finishes', async () => {
    const wallet = await openWallet(s);
    const betId = uniqueRef('bet');
    const refund = await s.submit.execute(
      command(wallet, {
        kind: 'REFUND',
        referenceExternalTransactionId: betId,
      }),
    );
    await s.submit.execute(command(wallet, { externalTransactionId: betId }));
    await db.query(
      'INSERT INTO pending_fault_config (id, sleep_seconds) VALUES (1, 3)',
    );
    const [victim] = await spawnWorkers(1);
    await waitUntil(
      async () =>
        (await count(
          "pg_stat_activity WHERE datname = current_database() AND wait_event = 'PgSleep'",
        )) === 1,
    );
    expect(
      await count(
        "wallet_ledger_entries WHERE wallet_id = ? AND direction = 'CREDIT'",
        [wallet.id],
      ),
    ).toBe(1);
    victim?.kill('SIGKILL');
    await victim?.exit(10_000);
    await db.query('DELETE FROM pending_fault_config');
    await waitUntil(
      async () =>
        (await count(
          "pg_stat_activity WHERE datname = current_database() AND wait_event = 'PgSleep'",
        )) === 0,
      15_000,
    );
    const [row] = await db.query(
      'SELECT status, reference_attempts FROM wager_transactions WHERE id = ?',
      [refund.transactionId],
    );
    expect(row).toMatchObject({
      status: 'PENDING_REFERENCE',
      reference_attempts: 0,
    });
    expect(await balance(db, wallet.id)).toBe('75.00');

    const survivors = await spawnWorkers(2);
    await waitUntil(noPendingFor(wallet.id));
    expect(resolutions(survivors, 'PROCESSED')).toHaveLength(1);
    expect(await balance(db, wallet.id)).toBe('100.00');
    await walletConsistency(wallet.id);
  });

  it('F: SIGKILL right after the commit does not repeat the movement', async () => {
    const wallet = await openWallet(s);
    const betId = uniqueRef('bet');
    const refund = await s.submit.execute(
      command(wallet, {
        kind: 'REFUND',
        referenceExternalTransactionId: betId,
      }),
    );
    await s.submit.execute(command(wallet, { externalTransactionId: betId }));
    const [crasher] = await spawnWorkers(1, { CRASH_POINT: 'after-commit' });
    const committed = await crasher?.waitFor('COMMITTED', 30_000);
    expect(committed).toBe(refund.transactionId);
    expect((await crasher?.exit(10_000))?.signalCode).toBe('SIGKILL');

    const survivors = await spawnWorkers(2);
    await Bun.sleep(1_500);
    expect(resolutions(survivors, 'PROCESSED')).toHaveLength(0);
    expect(
      await count(
        "outbox_messages WHERE aggregate_id = ? AND event_type = 'WagerTransactionProcessed'",
        [refund.transactionId],
      ),
    ).toBe(1);
    expect(
      await count(
        "wallet_ledger_entries WHERE wallet_id = ? AND direction = 'CREDIT'",
        [wallet.id],
      ),
    ).toBe(2);
    expect(await balance(db, wallet.id)).toBe('100.00');
    await walletConsistency(wallet.id);
  });

  it('G: a worker waiting for the wallet holds no pending, inbox or outbox locks', async () => {
    const wallet = await openWallet(s);
    const betId = uniqueRef('bet');
    const refund = await s.submit.execute(
      command(wallet, {
        kind: 'REFUND',
        referenceExternalTransactionId: betId,
      }),
    );
    await s.submit.execute(command(wallet, { externalTransactionId: betId }));
    const [url] = await spawnServers(1);
    const holder = await openTestOrm();
    const em = holder.em.fork();
    try {
      await em.begin();
      await em.execute('SELECT 1 FROM wallets WHERE id = ? FOR NO KEY UPDATE', [
        wallet.id,
      ]);
      await spawnWorkers(1);
      const waitingOnWallet = async () =>
        db.query(
          `SELECT pid FROM pg_stat_activity
            WHERE datname = current_database()
              AND wait_event_type = 'Lock'
              AND query ILIKE '%FROM wallets WHERE id%FOR NO KEY UPDATE%'`,
        );
      await waitUntil(async () => (await waitingOnWallet()).length === 1);
      const [worker] = await waitingOnWallet();
      const locks = await db.query(
        `SELECT coalesce(relation::regclass::text, locktype) AS target, mode, granted::text AS granted
           FROM pg_locks WHERE pid = ? AND locktype IN ('relation', 'tuple')`,
        [worker?.pid],
      );
      const targets = locks.map((lock) => String(lock.target));
      expect(targets).not.toContain('wager_transactions');
      expect(targets).not.toContain('inbox_messages');
      expect(targets).not.toContain('outbox_messages');
      expect(targets).not.toContain('wallet_ledger_entries');
      expect(targets).toContain('wallets');

      const api = post(
        url ?? '',
        httpBody(wallet, { money: { amount: '5.00', currency: 'BRL' } }),
      );
      await waitUntil(async () => (await waitingOnWallet()).length === 2);
      await Bun.sleep(300);
      await em.commit();
      expect(await api).toBe(200);
    } finally {
      await holder.close(true);
    }
    await waitUntil(noPendingFor(wallet.id));
    expect(
      (
        await db.query('SELECT status FROM wager_transactions WHERE id = ?', [
          refund.transactionId,
        ])
      )[0]?.status,
    ).toBe('PROCESSED');
    expect(await balance(db, wallet.id)).toBe('95.00');
    await walletConsistency(wallet.id);
  });

  it.each([1, 2, 3])(
    'H: dozens of mixed and duplicated operations on one wallet stay consistent (run %i)',
    async () => {
      const wallet = await openWallet(s, '1000.00');
      const urls = await spawnServers(3);
      await spawnWorkers(3);
      const bets = Array.from({ length: 20 }, () =>
        httpBody(wallet, {
          externalTransactionId: uniqueRef('bet'),
          money: { amount: '5.00', currency: 'BRL' },
        }),
      );
      const reversals = bets.slice(0, 15).map((bet, index) =>
        httpBody(wallet, {
          kind: index < 10 ? 'REFUND' : 'ROLLBACK',
          money: bet.money,
          referenceExternalTransactionId: bet.externalTransactionId,
        }),
      );
      const duplicates = [...bets.slice(0, 5), ...reversals.slice(0, 5)];
      const requests = [
        ...reversals.slice(0, 8),
        ...bets,
        ...duplicates,
        ...reversals.slice(8),
      ];
      const statuses = await Promise.all(
        requests.map((body, index) =>
          post(urls[index % urls.length] ?? '', body),
        ),
      );
      expect(statuses.every((status) => [200, 202].includes(status))).toBe(
        true,
      );
      await waitUntil(noPendingFor(wallet.id), 60_000);

      expect(await balance(db, wallet.id)).toBe('975.00');
      expect(
        await count(
          "wager_transactions WHERE wallet_id = ? AND kind <> 'OPENING'",
          [wallet.id],
        ),
      ).toBe(35);
      expect(
        await count(
          "wager_transactions WHERE wallet_id = ? AND status = 'PROCESSED' AND kind <> 'OPENING'",
          [wallet.id],
        ),
      ).toBe(35);
      expect(
        await count('wallet_ledger_entries WHERE wallet_id = ?', [wallet.id]),
      ).toBe(36);
      await walletConsistency(wallet.id);
    },
  );
});
