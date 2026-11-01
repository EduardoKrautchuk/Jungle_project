import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { MikroORM } from '@mikro-orm/postgresql';
import {
  Db,
  migrateFresh,
  openTestOrm,
} from '../integration/persistence/support.js';
import { WorkerProcess, killAll } from './support/process-harness.js';

const READY_TIMEOUT_MS = 30_000;
const EXIT_TIMEOUT_MS = 10_000;
const TEST_TIMEOUT_MS = 120_000;
const REPETITIONS = 3;

type Json = Record<string, unknown>;

interface HttpOutcome {
  status: number;
  body: Json;
}

interface Wallet {
  id: string;
  playerId: string;
}

interface WagerBody {
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

let orm: MikroORM;
let db: Db;
let servers: WorkerProcess[] = [];
let urls: string[] = [];
let sequence = 0;

const unique = (prefix: string) =>
  `${prefix}-${process.pid}-${Date.now().toString(36)}-${++sequence}`;

function toJson(value: unknown): Json {
  const record: Json = {};
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    for (const [key, item] of Object.entries(value)) {
      record[key] = item;
    }
  }
  return record;
}

async function call(
  url: string,
  path: string,
  body: object,
  headers: Record<string, string> = {},
): Promise<HttpOutcome> {
  try {
    const response = await fetch(`${url}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
    const parsed: unknown = await response.json();
    return { status: response.status, body: toJson(parsed) };
  } catch (error) {
    return {
      status: 0,
      body: { error: error instanceof Error ? error.name : String(error) },
    };
  }
}

function server(index: number): string {
  const url = urls[index % urls.length];
  if (url === undefined) {
    throw new Error('servers are not running');
  }
  return url;
}

async function createWallet(amount: string): Promise<Wallet> {
  const playerId = unique('player');
  const response = await call(server(0), '/wallets', {
    playerId,
    initialBalance: { amount, currency: 'BRL' },
  });
  expect(response.status).toBe(201);
  const id = response.body.id;
  if (typeof id !== 'string') {
    throw new Error('wallet id missing');
  }
  return { id, playerId };
}

function wager(wallet: Wallet, overrides: Partial<WagerBody> = {}): WagerBody {
  return {
    providerId: 'provider-a',
    externalTransactionId: unique('ext'),
    playerId: wallet.playerId,
    walletId: wallet.id,
    roundId: 'round-1',
    gameId: 'fortune-chimp',
    kind: 'BET',
    money: { amount: '10.00', currency: 'BRL' },
    ...overrides,
  };
}

function submit(index: number, body: WagerBody): Promise<HttpOutcome> {
  return call(server(index), '/wagering/transactions', body, {
    'Idempotency-Key': `${body.providerId}:${body.externalTransactionId}`,
  });
}

async function scalar(sql: string, params: unknown[]): Promise<string> {
  const [row] = await db.query(sql, params);
  return String(row?.value);
}

async function expectWalletInvariants(walletId: string): Promise<void> {
  const [row] = await db.query(
    `SELECT w.balance::text AS balance,
            coalesce(sum(CASE l.direction WHEN 'CREDIT' THEN l.amount ELSE -l.amount END), 0)::text AS ledger,
            min(l.balance_after)::text AS lowest
       FROM wallets w LEFT JOIN wallet_ledger_entries l ON l.wallet_id = w.id
      WHERE w.id = ? GROUP BY w.balance`,
    [walletId],
  );
  expect(Number(row?.balance)).toBe(Number(row?.ledger));
  expect(Number(row?.lowest)).toBeGreaterThanOrEqual(0);

  const breaks = await scalar(
    `SELECT count(*)::int AS value FROM (
       SELECT balance_before,
              lag(balance_after) OVER w AS previous,
              row_number() OVER w AS position
         FROM wallet_ledger_entries
        WHERE wallet_id = ?
       WINDOW w AS (ORDER BY created_at, id)
     ) chain
     WHERE (position = 1 AND balance_before <> 0)
        OR (position > 1 AND balance_before <> previous)`,
    [walletId],
  );
  expect(breaks).toBe('0');

  const [version] = await db.query(
    `SELECT w.version, count(l.id)::int AS entries
       FROM wallets w LEFT JOIN wallet_ledger_entries l ON l.wallet_id = w.id
      WHERE w.id = ? GROUP BY w.version`,
    [walletId],
  );
  expect(Number(version?.version)).toBe(Math.max(1, Number(version?.entries)));
}

async function startServers(count: number): Promise<WorkerProcess[]> {
  const started = Array.from({ length: count }, (_, i) =>
    WorkerProcess.spawnServer(`server-${i + 1}`),
  );
  const ready = await Promise.all(
    started.map((s) => s.waitFor('READY', READY_TIMEOUT_MS)),
  );
  urls = ready;
  return started;
}

describe('HTTP API across three independent NestJS processes', () => {
  beforeAll(async () => {
    orm = await openTestOrm();
    await migrateFresh(orm);
    db = new Db(orm);
    servers = await startServers(3);
  }, TEST_TIMEOUT_MS);

  afterAll(async () => {
    await killAll();
    await orm.close(true);
  });

  it('runs three distinct server processes', () => {
    const pids = new Set(servers.map((s) => s.pid));
    expect(pids.size).toBe(3);
    expect(pids.has(process.pid)).toBe(false);
    expect(new Set(urls).size).toBe(3);
  });

  for (let run = 1; run <= REPETITIONS; run += 1) {
    it(
      `debits once for 50 identical requests spread over 3 servers (run ${run})`,
      async () => {
        const wallet = await createWallet('100.00');
        const body = wager(wallet, {
          money: { amount: '25.00', currency: 'BRL' },
        });
        const responses = await Promise.all(
          Array.from({ length: 50 }, (_, i) => submit(i, body)),
        );
        expect(responses.map((r) => r.status)).toEqual(Array(50).fill(200));
        expect(
          responses.filter((r) => r.body.idempotentReplay === false),
        ).toHaveLength(1);
        expect(new Set(responses.map((r) => r.body.transactionId)).size).toBe(
          1,
        );
        expect(
          responses.every(
            (r) =>
              JSON.stringify(r.body.balance) ===
              '{"amount":"75.00","currency":"BRL"}',
          ),
        ).toBe(true);

        expect(
          await scalar(
            'SELECT balance::text AS value FROM wallets WHERE id = ?',
            [wallet.id],
          ),
        ).toBe('75.00');
        expect(
          await scalar(
            'SELECT count(*)::int AS value FROM wager_transactions WHERE external_transaction_id = ?',
            [body.externalTransactionId],
          ),
        ).toBe('1');
        expect(
          await scalar(
            `SELECT count(*)::int AS value FROM wallet_ledger_entries WHERE wallet_id = ? AND direction = 'DEBIT'`,
            [wallet.id],
          ),
        ).toBe('1');
        expect(
          await scalar(
            'SELECT count(*)::int AS value FROM outbox_messages WHERE aggregate_id = ?',
            [String(responses[0]?.body.transactionId)],
          ),
        ).toBe('1');
        await expectWalletInvariants(wallet.id);
      },
      TEST_TIMEOUT_MS,
    );
  }

  for (let run = 1; run <= REPETITIONS; run += 1) {
    it(
      `lets one of two 80.00 bets on different servers win 100.00 (run ${run})`,
      async () => {
        const wallet = await createWallet('100.00');
        const amount = { amount: '80.00', currency: 'BRL' };
        const responses = await Promise.all([
          submit(0, wager(wallet, { money: amount })),
          submit(1, wager(wallet, { money: amount })),
        ]);
        expect(responses.map((r) => r.status).sort((a, b) => a - b)).toEqual([
          200, 422,
        ]);
        expect(responses.find((r) => r.status === 422)?.body.failureCode).toBe(
          'INSUFFICIENT_FUNDS',
        );
        expect(
          await scalar(
            'SELECT balance::text AS value FROM wallets WHERE id = ?',
            [wallet.id],
          ),
        ).toBe('20.00');
        await expectWalletInvariants(wallet.id);
      },
      TEST_TIMEOUT_MS,
    );
  }

  for (let run = 1; run <= REPETITIONS; run += 1) {
    it(
      `never double credits a BET hit by REFUND and ROLLBACK on different servers (run ${run})`,
      async () => {
        const wallet = await createWallet('100.00');
        const bets = Array.from({ length: 8 }, () => wager(wallet));
        const placed = await Promise.all(bets.map((bet, i) => submit(i, bet)));
        expect(placed.every((r) => r.status === 200)).toBe(true);

        const reversals = await Promise.all(
          bets.flatMap((bet, i) => [
            submit(
              i,
              wager(wallet, {
                kind: 'REFUND',
                referenceExternalTransactionId: bet.externalTransactionId,
              }),
            ),
            submit(
              i + 1,
              wager(wallet, {
                kind: 'ROLLBACK',
                referenceExternalTransactionId: bet.externalTransactionId,
              }),
            ),
          ]),
        );
        for (let i = 0; i < bets.length; i += 1) {
          const pair = reversals.slice(i * 2, i * 2 + 2);
          expect(pair.map((r) => r.status).sort((a, b) => a - b)).toEqual([
            200, 422,
          ]);
          expect(pair.find((r) => r.status === 422)?.body.failureCode).toBe(
            'ALREADY_REVERSED',
          );
        }
        expect(
          await scalar(
            'SELECT balance::text AS value FROM wallets WHERE id = ?',
            [wallet.id],
          ),
        ).toBe('100.00');
        expect(
          await scalar(
            `SELECT count(*)::int AS value FROM wager_transactions
              WHERE wallet_id = ? AND kind IN ('REFUND', 'ROLLBACK') AND status = 'PROCESSED'`,
            [wallet.id],
          ),
        ).toBe(String(bets.length));
        await expectWalletInvariants(wallet.id);
      },
      TEST_TIMEOUT_MS,
    );
  }

  for (let run = 1; run <= REPETITIONS; run += 1) {
    it(
      `keeps a hot wallet consistent under mixed operations from 3 servers (run ${run})`,
      async () => {
        const wallet = await createWallet('50.00');
        const bodies = Array.from({ length: 36 }, (_, i) =>
          i % 4 === 3
            ? wager(wallet, {
                kind: 'WIN',
                money: { amount: '3.50', currency: 'BRL' },
              })
            : i % 4 === 2
              ? wager(wallet, {
                  kind: 'LOSS',
                  money: { amount: '0.00', currency: 'BRL' },
                })
              : wager(wallet, { money: { amount: '7.25', currency: 'BRL' } }),
        );
        const responses = await Promise.all(bodies.map((b, i) => submit(i, b)));
        expect(
          responses.every((r) => r.status === 200 || r.status === 422),
        ).toBe(true);
        expect(
          responses
            .filter((r) => r.status === 422)
            .every((r) => r.body.failureCode === 'INSUFFICIENT_FUNDS'),
        ).toBe(true);
        await expectWalletInvariants(wallet.id);
      },
      TEST_TIMEOUT_MS,
    );
  }

  it(
    'keeps money exact when a server is SIGKILLed mid-load and requests are resent elsewhere',
    async () => {
      const victim = WorkerProcess.spawnServer('victim');
      const victimUrl = await victim.waitFor('READY', READY_TIMEOUT_MS);
      const wallet = await createWallet('1000.00');
      const bodies = Array.from({ length: 40 }, () => wager(wallet));

      const inFlight = bodies.map((body) =>
        call(victimUrl, '/wagering/transactions', body, {
          'Idempotency-Key': `${body.providerId}:${body.externalTransactionId}`,
        }),
      );
      await Bun.sleep(25);
      victim.kill('SIGKILL');
      const exit = await victim.exit(EXIT_TIMEOUT_MS);
      expect(exit.signalCode).toBe('SIGKILL');
      const firstAttempt = await Promise.all(inFlight);
      expect(firstAttempt.some((r) => r.status === 0)).toBe(true);

      const resent = await Promise.all(
        bodies.map((body, i) => submit(i, body)),
      );
      expect(resent.every((r) => r.status === 200)).toBe(true);
      const processedBefore = firstAttempt.filter(
        (r) => r.status === 200,
      ).length;
      expect(
        resent.filter((r) => r.body.idempotentReplay === true).length,
      ).toBeGreaterThanOrEqual(processedBefore);
      expect(
        await scalar(
          `SELECT count(*)::int AS value FROM wallet_ledger_entries WHERE wallet_id = ? AND direction = 'DEBIT'`,
          [wallet.id],
        ),
      ).toBe('40');
      expect(
        await scalar(
          'SELECT balance::text AS value FROM wallets WHERE id = ?',
          [wallet.id],
        ),
      ).toBe('600.00');
      expect(
        await scalar(
          `SELECT count(*)::int AS value FROM pg_stat_activity
            WHERE datname = current_database() AND state = 'idle in transaction'`,
          [],
        ),
      ).toBe('0');
      await expectWalletInvariants(wallet.id);
    },
    TEST_TIMEOUT_MS,
  );
});
