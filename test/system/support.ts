import { randomUUID } from 'node:crypto';
import type { SQSClient } from '@aws-sdk/client-sqs';
import { expect } from 'bun:test';
import type { Db } from '../integration/persistence/support.js';
import { WorkerProcess } from '../concurrency/support/process-harness.js';
import {
  createTestQueues,
  queueDepth,
  type TestQueues,
} from '../messaging/support.js';
import {
  createEventQueues,
  drainEvents,
  type EventQueues,
  type ReceivedEvent,
} from '../outbox/support.js';

export interface Stack {
  readonly apis: string[];
  readonly apiProcesses: WorkerProcess[];
  readonly consumers: WorkerProcess[];
  readonly publishers: WorkerProcess[];
  readonly pendingWorkers: WorkerProcess[];
  readonly commands: TestQueues;
  readonly events: EventQueues;
}

export interface StackSize {
  readonly apis?: number;
  readonly consumers?: number;
  readonly publishers?: number;
  readonly pendingWorkers?: number;
}

let processSequence = 0;

export function consumerEnv(commands: TestQueues): Record<string, string> {
  return {
    SQS_WAGER_QUEUE_URL: commands.queueUrl,
    SQS_WAGER_DLQ_URL: commands.deadLetterQueueUrl,
    SQS_WAIT_TIME_SECONDS: '1',
    SQS_REQUEST_TIMEOUT_MS: '5000',
    SQS_VISIBILITY_TIMEOUT_SECONDS: '4',
    SQS_MAX_RECEIVE_COUNT: '5',
    SQS_RETRY_BASE_SECONDS: '1',
    SQS_RETRY_MAX_SECONDS: '2',
  };
}

export function publisherEnv(
  events: EventQueues,
  name: string,
): Record<string, string> {
  return {
    OUTBOX_PUBLISHER_ID: name,
    SQS_EVENTS_QUEUE_URL: events.queueUrl,
    SQS_WAIT_TIME_SECONDS: '1',
    SQS_REQUEST_TIMEOUT_MS: '1500',
    OUTBOX_LEASE_MS: '4000',
    OUTBOX_IDLE_POLL_MS: '100',
    OUTBOX_MAX_GROUPS: '5',
    OUTBOX_MAX_PER_GROUP: '5',
  };
}

export function pendingEnv(name: string): Record<string, string> {
  return {
    PENDING_WORKER_ID: name,
    PENDING_REFERENCE_BASE_DELAY_MS: '100',
    PENDING_REFERENCE_MAX_DELAY_MS: '400',
    PENDING_REFERENCE_MAX_ATTEMPTS: '500',
    PENDING_WORKER_IDLE_POLL_MS: '50',
  };
}

export async function spawnApis(amount: number): Promise<{
  urls: string[];
  processes: WorkerProcess[];
}> {
  const processes = Array.from({ length: amount }, () =>
    WorkerProcess.spawnServer(`api-${++processSequence}`),
  );
  const urls = await Promise.all(
    processes.map((p) => p.waitFor('READY', 30_000)),
  );
  return { urls, processes };
}

export async function spawnConsumers(
  amount: number,
  commands: TestQueues,
): Promise<WorkerProcess[]> {
  const processes = Array.from({ length: amount }, () =>
    WorkerProcess.spawnSqsWorker(
      `consumer-${++processSequence}`,
      consumerEnv(commands),
    ),
  );
  await Promise.all(processes.map((p) => p.waitFor('READY', 30_000)));
  return processes;
}

export async function spawnPublishers(
  amount: number,
  events: EventQueues,
): Promise<WorkerProcess[]> {
  const processes = Array.from({ length: amount }, () => {
    const name = `publisher-${++processSequence}`;
    return WorkerProcess.spawnOutboxPublisher(name, publisherEnv(events, name));
  });
  await Promise.all(processes.map((p) => p.waitFor('READY', 30_000)));
  return processes;
}

export async function spawnPendingWorkers(
  amount: number,
): Promise<WorkerProcess[]> {
  const processes = Array.from({ length: amount }, () => {
    const name = `pending-${++processSequence}`;
    return WorkerProcess.spawnPendingWorker(name, pendingEnv(name));
  });
  await Promise.all(processes.map((p) => p.waitFor('READY', 30_000)));
  return processes;
}

export async function startStack(
  client: SQSClient,
  size: StackSize = {},
): Promise<Stack> {
  const commands = await createTestQueues(client, 5);
  const events = await createEventQueues(client);
  const [api, consumers, publishers, pendingWorkers] = await Promise.all([
    spawnApis(size.apis ?? 3),
    spawnConsumers(size.consumers ?? 3, commands),
    spawnPublishers(size.publishers ?? 3, events),
    spawnPendingWorkers(size.pendingWorkers ?? 3),
  ]);
  const pids = [
    ...api.processes,
    ...consumers,
    ...publishers,
    ...pendingWorkers,
  ].map((p) => p.pid);
  expect(new Set(pids).size).toBe(pids.length);
  return {
    apis: api.urls,
    apiProcesses: api.processes,
    consumers,
    publishers,
    pendingWorkers,
    commands,
    events,
  };
}

export interface HttpOutcome {
  readonly status: number;
  readonly body: Readonly<Record<string, unknown>>;
}

export async function http(
  url: string,
  method: 'POST',
  path: string,
  body?: object,
  headers: Record<string, string> = {},
): Promise<HttpOutcome> {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    let response: Response;
    try {
      response = await fetch(`${url}${path}`, {
        method,
        headers: { 'content-type': 'application/json', ...headers },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (error) {
      if (headers['x-test-crash-after-commit'] !== undefined) {
        throw error;
      }
      await Bun.sleep(100);
      continue;
    }
    const parsed: unknown = await response.json().catch(() => ({}));
    const record: Record<string, unknown> =
      typeof parsed === 'object' && parsed !== null ? { ...parsed } : {};
    if (response.status !== 503) {
      return { status: response.status, body: record };
    }
    await Bun.sleep(100);
  }
  throw new Error(`${method} ${path} stayed unavailable`);
}

export interface WagerBody {
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

export interface WalletRef {
  readonly id: string;
  readonly playerId: string;
}

let idSequence = 0;

export const uniqueId = (prefix: string): string =>
  `${prefix}-${Date.now().toString(36)}-${++idSequence}`;

export async function createWalletHttp(
  url: string,
  amount = '100.00',
): Promise<WalletRef> {
  const playerId = `player-${randomUUID()}`;
  const response = await http(url, 'POST', '/wallets', {
    playerId,
    initialBalance: { amount, currency: 'BRL' },
  });
  expect(response.status).toBe(201);
  return { id: String(response.body.id), playerId };
}

export function wager(
  wallet: WalletRef,
  overrides: Partial<WagerBody> = {},
): WagerBody {
  return {
    providerId: 'provider-a',
    externalTransactionId: uniqueId('ext'),
    playerId: wallet.playerId,
    walletId: wallet.id,
    roundId: 'round-1',
    gameId: 'fortune-chimp',
    kind: 'BET',
    money: { amount: '10.00', currency: 'BRL' },
    ...overrides,
  };
}

export const keyOf = (body: WagerBody): string =>
  `${body.providerId}:${body.externalTransactionId}`;

export function submitHttp(
  url: string,
  body: WagerBody,
  headers: Record<string, string> = {},
): Promise<HttpOutcome> {
  return http(url, 'POST', '/wagering/transactions', body, {
    'idempotency-key': keyOf(body),
    ...headers,
  });
}

export async function submitAny(
  urls: readonly string[],
  start: number,
  body: WagerBody,
): Promise<HttpOutcome> {
  let lastError: unknown;
  for (let offset = 0; offset < urls.length * 3; offset += 1) {
    const url = urls[(start + offset) % urls.length] ?? '';
    try {
      return await http(url, 'POST', '/wagering/transactions', body, {
        'idempotency-key': keyOf(body),
        'x-test-crash-after-commit': '0',
      });
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error('no API answered');
}

export function commandEnvelope(body: WagerBody, messageId = uniqueId('msg')) {
  return {
    messageId,
    type: 'WagerTransactionRequested',
    occurredAt: new Date().toISOString(),
    data: { ...body, idempotencyKey: keyOf(body) },
  };
}

export async function waitUntil(
  condition: () => Promise<boolean> | boolean,
  timeoutMs = 60_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) {
      return;
    }
    await Bun.sleep(100);
  }
  throw new Error(`condition not met within ${timeoutMs}ms`);
}

export async function count(
  db: Db,
  sql: string,
  params: unknown[] = [],
): Promise<number> {
  const [row] = await db.query(`SELECT count(*)::int AS n FROM ${sql}`, params);
  return Number(row?.n);
}

export async function deadlocks(db: Db): Promise<number> {
  const [row] = await db.query(
    'SELECT deadlocks::int AS n FROM pg_stat_database WHERE datname = current_database()',
  );
  return Number(row?.n);
}

export async function settled(db: Db, walletIds: readonly string[]) {
  if (walletIds.length === 0) {
    return true;
  }
  const marks = walletIds.map(() => '?').join(', ');
  return (
    (await count(
      db,
      `wager_transactions WHERE wallet_id IN (${marks}) AND status IN ('PENDING', 'PENDING_REFERENCE')`,
      [...walletIds],
    )) === 0
  );
}

export async function outboxDrained(db: Db): Promise<boolean> {
  return (
    (await count(
      db,
      'outbox_messages WHERE published_at IS NULL AND dead_lettered_at IS NULL',
    )) === 0
  );
}

export async function commandQueueEmpty(
  client: SQSClient,
  commands: TestQueues,
): Promise<boolean> {
  const depth = await queueDepth(client, commands.queueUrl);
  return depth.visible + depth.inFlight + depth.delayed === 0;
}

export interface WalletFacts {
  readonly balance: string;
  readonly version: number;
  readonly ledgerEntries: number;
  readonly events: number;
}

export async function walletFacts(
  db: Db,
  walletId: string,
): Promise<WalletFacts> {
  const [row] = await db.query(
    `SELECT w.balance::text AS balance, w.version,
            (SELECT count(*)::int FROM wallet_ledger_entries l WHERE l.wallet_id = w.id) AS entries,
            (SELECT count(*)::int FROM outbox_messages o
              WHERE o.group_key = w.id::text) AS events
       FROM wallets w WHERE w.id = ?`,
    [walletId],
  );
  return {
    balance: String(row?.balance),
    version: Number(row?.version),
    ledgerEntries: Number(row?.entries),
    events: Number(row?.events),
  };
}

export async function assertFinancialInvariants(
  db: Db,
  walletIds: readonly string[],
): Promise<void> {
  const marks = walletIds.map(() => '?').join(', ');
  const ids = [...walletIds];
  const drift = await db.query(
    `SELECT w.id FROM wallets w
      WHERE w.id IN (${marks})
        AND w.balance <> coalesce((
          SELECT sum(CASE direction WHEN 'CREDIT' THEN amount ELSE -amount END)
            FROM wallet_ledger_entries l WHERE l.wallet_id = w.id), 0)`,
    ids,
  );
  expect(drift).toEqual([]);
  const [chain] = await db.query(
    `SELECT count(*)::int AS breaks FROM (
       SELECT balance_before,
              lag(balance_after) OVER (PARTITION BY wallet_id ORDER BY created_at, id) AS previous
         FROM wallet_ledger_entries WHERE wallet_id IN (${marks})) entries
      WHERE previous IS NOT NULL AND previous <> balance_before`,
    ids,
  );
  expect(chain?.breaks).toBe(0);
  expect(
    await count(db, `wallets WHERE id IN (${marks}) AND balance < 0`, ids),
  ).toBe(0);
  expect(
    await db.query(
      `SELECT w.id FROM wallets w
        WHERE w.id IN (${marks})
          AND w.version <> greatest(1, (SELECT count(*) FROM wallet_ledger_entries l WHERE l.wallet_id = w.id))`,
      ids,
    ),
  ).toEqual([]);
  expect(
    await db.query(
      `SELECT transaction_id FROM wallet_ledger_entries
        WHERE wallet_id IN (${marks})
        GROUP BY transaction_id HAVING count(*) > 1`,
      ids,
    ),
  ).toEqual([]);
  expect(
    await db.query(
      `SELECT reference_transaction_id FROM wager_transactions
        WHERE wallet_id IN (${marks}) AND status = 'PROCESSED' AND kind IN ('REFUND', 'ROLLBACK')
        GROUP BY reference_transaction_id HAVING count(*) > 1`,
      ids,
    ),
  ).toEqual([]);
  expect(
    await db.query(
      `SELECT t.id FROM wager_transactions t
        WHERE t.wallet_id IN (${marks})
          AND t.status IN ('PROCESSED', 'REJECTED')
          AND (SELECT count(*) FROM outbox_messages o
                WHERE o.aggregate_id = t.id::text
                  AND o.event_type IN ('WagerTransactionProcessed', 'WagerTransactionRejected')) <> 1`,
      ids,
    ),
  ).toEqual([]);
  expect(
    await db.query(
      `SELECT w.id FROM wallets w
        WHERE w.id IN (${marks})
          AND (SELECT count(*) FROM outbox_messages o
                WHERE o.aggregate_id = w.id::text AND o.event_type = 'WalletBalanceChanged')
              <> (SELECT count(*) FROM wallet_ledger_entries l WHERE l.wallet_id = w.id)`,
      ids,
    ),
  ).toEqual([]);
  expect(
    await count(
      db,
      `wager_transactions t WHERE t.wallet_id IN (${marks})
         AND t.status = 'PROCESSED' AND t.kind NOT IN ('LOSS')
         AND NOT EXISTS (SELECT 1 FROM wallet_ledger_entries l WHERE l.transaction_id = t.id)`,
      ids,
    ),
  ).toBe(0);
}

export async function reconcileAll(
  url: string,
  walletIds: readonly string[],
): Promise<void> {
  for (const walletId of walletIds) {
    const response = await http(
      url,
      'POST',
      `/wallets/${walletId}/reconciliation`,
    );
    expect(response.status).toBe(200);
    expect(response.body.consistent).toBe(true);
    expect(response.body.difference).toEqual({
      amount: '0.00',
      currency: 'BRL',
    });
  }
}

export async function readPublishedEvents(
  client: SQSClient,
  events: EventQueues,
  expected: number,
): Promise<ReceivedEvent[]> {
  return drainEvents(client, events.queueUrl, {
    expected,
    timeoutMs: 60_000,
    quietMs: 2_000,
  });
}

export async function assertPublishedEvents(
  db: Db,
  received: readonly ReceivedEvent[],
): Promise<void> {
  const rows = await db.query(
    'SELECT id, group_key, payload::text AS payload FROM outbox_messages ORDER BY publish_sequence',
  );
  const unique = new Map<string, ReceivedEvent>();
  for (const event of received) {
    const existing = unique.get(event.eventId);
    if (existing !== undefined) {
      expect(event.body).toBe(existing.body);
    }
    unique.set(event.eventId, event);
  }
  expect([...unique.keys()].sort()).toEqual(
    rows.map((row) => String(row.id)).sort(),
  );
  for (const row of rows) {
    const event = unique.get(String(row.id));
    const stored: unknown = JSON.parse(String(row.payload));
    expect(event?.payload).toEqual(
      typeof stored === 'object' && stored !== null ? { ...stored } : {},
    );
    expect(event?.groupId).toBe(String(row.group_key));
  }
  const expectedOrder = new Map<string, string[]>();
  for (const row of rows) {
    const key = String(row.group_key);
    expectedOrder.set(key, [...(expectedOrder.get(key) ?? []), String(row.id)]);
  }
  const receivedOrder = new Map<string, string[]>();
  for (const event of received) {
    const key = event.groupId ?? '';
    const list = receivedOrder.get(key) ?? [];
    if (!list.includes(event.eventId)) {
      list.push(event.eventId);
    }
    receivedOrder.set(key, list);
  }
  expect(receivedOrder).toEqual(expectedOrder);
}

export interface ScenarioReport {
  readonly scenario: string;
  readonly processes: Readonly<Record<string, number>>;
  readonly messages: number;
  readonly injectedFailures: readonly string[];
  readonly expected: string;
  readonly observed: string;
  readonly finalBalances: Readonly<Record<string, string>>;
  readonly ledgerEntries: number;
  readonly events: number;
  readonly redeliveries: number;
  readonly retries: number;
  readonly newDeadlocks: number;
  readonly durationMs: number;
}

export function report(entry: ScenarioReport): void {
  process.stdout.write(`SYSTEM_REPORT ${JSON.stringify(entry)}\n`);
}

export function countLines(
  processes: readonly WorkerProcess[],
  fragment: string,
): number {
  return processes.reduce(
    (sum, process) => sum + process.output(fragment).length,
    0,
  );
}

export function stackSize(stack: Stack): Record<string, number> {
  return {
    api: stack.apiProcesses.length,
    consumer: stack.consumers.length,
    publisher: stack.publishers.length,
    pendingWorker: stack.pendingWorkers.length,
  };
}
