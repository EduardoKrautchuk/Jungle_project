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
import { createSqsClient } from '../../src/infrastructure/messaging/sqs-client.js';
import { startTestApp, type TestApp } from '../e2e/support.js';
import {
  buildConsumer,
  consumeUntil,
  createTestQueues,
  deleteTestQueues,
  envelope,
  send,
  sqsClient,
  wagerData,
  waitUntil,
  type TestQueues,
} from '../messaging/support.js';
import { TcpProxy } from '../messaging/tcp-proxy.js';
import { command, stack, uniqueRef } from '../pending/support.js';
import { sqsConfig } from '../outbox/support.js';
import {
  assertFinancialInvariants,
  count,
  deadlocks,
  report,
  type WalletRef,
} from './support.js';

setDefaultTimeout(120_000);

let t: TestApp;
let client: SQSClient;
let queues: TestQueues;
let deadlocksBefore = 0;

const FAULTS = {
  claim_insert: 'BEFORE INSERT ON wager_transactions FOR EACH ROW',
  wallet_update: 'AFTER UPDATE ON wallets FOR EACH ROW',
  ledger_insert: 'AFTER INSERT ON wallet_ledger_entries FOR EACH ROW',
  transaction_update: 'AFTER UPDATE ON wager_transactions FOR EACH ROW',
  outbox_insert: 'AFTER INSERT ON outbox_messages FOR EACH ROW',
  inbox_insert: 'BEFORE INSERT ON inbox_messages FOR EACH ROW',
  inbox_processed: 'AFTER UPDATE ON inbox_messages FOR EACH ROW',
} as const;

type FaultPoint = keyof typeof FAULTS | 'commit';

beforeAll(async () => {
  t = await startTestApp();
  client = sqsClient();
  await t.db.query('CREATE SEQUENCE IF NOT EXISTS system_fault_seq');
  await t.db.query(
    'CREATE TABLE IF NOT EXISTS system_fault_config (point text PRIMARY KEY, failures integer NOT NULL)',
  );
  await t.db.query(`
    CREATE OR REPLACE FUNCTION system_raise_fault() RETURNS trigger AS $$
    DECLARE
      configured integer;
    BEGIN
      SELECT failures INTO configured FROM system_fault_config WHERE point = TG_ARGV[0];
      IF configured IS NOT NULL AND nextval('system_fault_seq') <= configured THEN
        RAISE EXCEPTION 'injected fault at %', TG_ARGV[0];
      END IF;
      RETURN NEW;
    END
    $$ LANGUAGE plpgsql`);
  for (const [point, timing] of Object.entries(FAULTS)) {
    await t.db.query(
      `CREATE OR REPLACE TRIGGER system_fault_${point} ${timing}
         EXECUTE FUNCTION system_raise_fault('${point}')`,
    );
  }
  await t.db.query(`
    CREATE CONSTRAINT TRIGGER system_fault_commit
      AFTER UPDATE ON wallets
      DEFERRABLE INITIALLY DEFERRED
      FOR EACH ROW EXECUTE FUNCTION system_raise_fault('commit')`);
});

afterAll(async () => {
  await t.db.query('DROP TRIGGER IF EXISTS system_fault_commit ON wallets');
  for (const [point, timing] of Object.entries(FAULTS)) {
    const table = timing.split(' ON ')[1]?.split(' ')[0] ?? '';
    await t.db.query(
      `DROP TRIGGER IF EXISTS system_fault_${point} ON ${table}`,
    );
  }
  await t.db.query('DROP FUNCTION IF EXISTS system_raise_fault()');
  await t.db.query('DROP TABLE IF EXISTS system_fault_config');
  await t.db.query('DROP SEQUENCE IF EXISTS system_fault_seq');
  client.destroy();
  await t.close();
});

beforeEach(async () => {
  await t.db.query('DELETE FROM system_fault_config');
  await t.db.query(
    `UPDATE wager_transactions SET next_reference_attempt_at = '2100-01-01T00:00:00Z'
      WHERE status = 'PENDING_REFERENCE'`,
  );
  queues = await createTestQueues(client);
  deadlocksBefore = await deadlocks(t.db);
});

afterEach(async () => {
  await t.db.query('DELETE FROM system_fault_config');
  await deleteTestQueues(client, queues);
  await Bun.sleep(300);
  expect(await deadlocks(t.db)).toBe(deadlocksBefore);
});

async function arm(point: FaultPoint): Promise<void> {
  await t.db.query('DELETE FROM system_fault_config');
  await t.db.query("SELECT setval('system_fault_seq', 1, false)");
  await t.db.query(
    'INSERT INTO system_fault_config (point, failures) VALUES (?, 1)',
    [point],
  );
}

async function createWallet(): Promise<WalletRef> {
  const response = await t
    .http()
    .post('/wallets')
    .send({
      playerId: uniqueRef('player'),
      initialBalance: { amount: '100.00', currency: 'BRL' },
    });
  expect(response.status).toBe(201);
  const body: unknown = response.body;
  if (typeof body !== 'object' || body === null || !('id' in body)) {
    throw new Error('wallet creation returned no id');
  }
  const walletBody: { id: unknown; playerId?: unknown } = body;
  return {
    id: String(walletBody.id),
    playerId: String(walletBody.playerId),
  };
}

async function snapshot(walletId: string) {
  const [row] = await t.db.query(
    `SELECT w.balance::text AS balance, w.version,
            (SELECT count(*)::int FROM wallet_ledger_entries WHERE wallet_id = w.id) AS ledger,
            (SELECT count(*)::int FROM wager_transactions WHERE wallet_id = w.id) AS transactions,
            (SELECT count(*)::int FROM outbox_messages WHERE group_key = w.id::text) AS outbox,
            (SELECT count(*)::int FROM inbox_messages) AS inbox
       FROM wallets w WHERE w.id = ?`,
    [walletId],
  );
  return row;
}

const HTTP_POINTS: FaultPoint[] = [
  'claim_insert',
  'wallet_update',
  'ledger_insert',
  'transaction_update',
  'outbox_insert',
  'commit',
];

const SQS_POINTS: FaultPoint[] = [
  'inbox_insert',
  'claim_insert',
  'wallet_update',
  'ledger_insert',
  'transaction_update',
  'outbox_insert',
  'inbox_processed',
  'commit',
];

describe('failures before the commit through the HTTP API', () => {
  it.each(HTTP_POINTS)(
    'rolls back everything when the transaction fails at %s and applies the retry once',
    async (point) => {
      const startedAt = Date.now();
      const wallet = await createWallet();
      const body = {
        providerId: 'provider-a',
        externalTransactionId: uniqueRef('bet'),
        playerId: wallet.playerId,
        walletId: wallet.id,
        roundId: 'round-1',
        gameId: 'fortune-chimp',
        kind: 'BET',
        money: { amount: '25.00', currency: 'BRL' },
      };
      const key = `provider-a:${body.externalTransactionId}`;
      const before = await snapshot(wallet.id);
      await arm(point);

      const failed = await t
        .http()
        .post('/wagering/transactions')
        .set('Idempotency-Key', key)
        .send(body);
      expect(failed.status).toBe(500);
      expect(await snapshot(wallet.id)).toEqual(before);

      const retried = await t
        .http()
        .post('/wagering/transactions')
        .set('Idempotency-Key', key)
        .send(body);
      expect(retried.status).toBe(200);
      expect(retried.body).toMatchObject({
        status: 'PROCESSED',
        idempotentReplay: false,
        balance: { amount: '75.00', currency: 'BRL' },
      });
      const after = await snapshot(wallet.id);
      expect(after).toEqual({
        ...before,
        balance: '75.00',
        version: Number(before?.version) + 1,
        ledger: Number(before?.ledger) + 1,
        transactions: Number(before?.transactions) + 1,
        outbox: Number(before?.outbox) + 2,
      });
      await assertFinancialInvariants(t.db, [wallet.id]);
      report({
        scenario: `HTTP failure before commit at ${point}`,
        processes: { api: 1 },
        messages: 2,
        injectedFailures: [point],
        expected: '500 with full rollback, retry processed once',
        observed: `retry ${retried.status}, balance ${String(after?.balance)}`,
        finalBalances: { [wallet.id]: String(after?.balance) },
        ledgerEntries: Number(after?.ledger),
        events: Number(after?.outbox),
        redeliveries: 0,
        retries: 1,
        newDeadlocks: (await deadlocks(t.db)) - deadlocksBefore,
        durationMs: Date.now() - startedAt,
      });
    },
  );
});

describe('failures before the commit through the SQS consumer', () => {
  it.each(SQS_POINTS)(
    'leaves no inbox, ledger or outbox trace when the transaction fails at %s and redelivers once',
    async (point) => {
      const wallet = await createWallet();
      const message = envelope(
        wagerData(wallet, { money: { amount: '25.00', currency: 'BRL' } }),
      );
      const before = await snapshot(wallet.id);
      await arm(point);
      await send(client, queues, message);

      const failing = buildConsumer(t.orm, client, queues);
      await consumeUntil(
        failing,
        () => failing.log.events('message.retry_scheduled').length === 1,
      );
      expect(
        failing.log.events('message.retry_scheduled')[0]?.fields.errorCode,
      ).toBe('UNEXPECTED_ERROR');
      expect(await snapshot(wallet.id)).toEqual(before);
      expect(
        await count(t.db, 'inbox_messages WHERE message_id = ?', [
          message.messageId,
        ]),
      ).toBe(0);

      const recovering = buildConsumer(t.orm, client, queues);
      await consumeUntil(
        recovering,
        async () =>
          (await count(
            t.db,
            'inbox_messages WHERE message_id = ? AND processed_at IS NOT NULL',
            [message.messageId],
          )) === 1,
      );
      expect(
        recovering.log.events('message.processed')[0]?.fields,
      ).toMatchObject({ result: 'PROCESSED', receiveCount: 2 });
      expect(await snapshot(wallet.id)).toMatchObject({
        balance: '75.00',
        ledger: Number(before?.ledger) + 1,
        transactions: Number(before?.transactions) + 1,
        outbox: Number(before?.outbox) + 2,
      });
      await assertFinancialInvariants(t.db, [wallet.id]);
    },
  );
});

describe('failures before the commit in the pending reference worker', () => {
  it.each(['ledger_insert', 'outbox_insert', 'commit'] as const)(
    'keeps the pending intact when resolution fails at %s',
    async (point) => {
      const s = stack(t.orm);
      const wallet = await createWallet();
      const betId = uniqueRef('bet');
      const refund = await s.submit.execute(
        command(wallet, {
          kind: 'REFUND',
          referenceExternalTransactionId: betId,
        }),
      );
      await s.submit.execute(command(wallet, { externalTransactionId: betId }));
      s.clock.advance(1_000);
      const [candidate] = await s.resolver.listDue(10, 'fault');
      if (candidate === undefined) {
        throw new Error('expected a pending candidate');
      }
      const before = await snapshot(wallet.id);
      await arm(point);
      let failure: unknown;
      try {
        await s.resolver.resolve(candidate);
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(Error);
      expect(await snapshot(wallet.id)).toEqual(before);
      const [row] = await t.db.query(
        'SELECT status, reference_attempts FROM wager_transactions WHERE id = ?',
        [refund.transactionId],
      );
      expect(row).toMatchObject({
        status: 'PENDING_REFERENCE',
        reference_attempts: 0,
      });
      expect((await s.resolver.resolve(candidate)).result).toBe('PROCESSED');
      expect(await snapshot(wallet.id)).toMatchObject({ balance: '100.00' });
      await assertFinancialInvariants(t.db, [wallet.id]);
    },
  );
});

describe('SQS unavailable for the consumer', () => {
  it('backs off while SQS is unreachable and consumes the backlog once it returns', async () => {
    const wallet = await createWallet();
    const endpoint = new URL(sqsConfig().endpoint ?? 'http://127.0.0.1:54566');
    const proxy = await TcpProxy.start(
      endpoint.hostname,
      Number(endpoint.port),
    );
    const proxiedClient = createSqsClient(
      sqsConfig({
        endpoint: `http://127.0.0.1:${proxy.port}`,
        requestTimeoutMs: 2_000,
      }),
      { maxAttempts: 1 },
    );
    const message = envelope(
      wagerData(wallet, { money: { amount: '25.00', currency: 'BRL' } }),
    );
    try {
      await proxy.pause();
      const consumer = buildConsumer(t.orm, proxiedClient, queues);
      const running = consumer.consumer.start();
      await waitUntil(
        () => consumer.log.events('consumer.receive_failed').length >= 2,
      );
      const failures = consumer.log.events('consumer.receive_failed');
      expect(failures[1]?.fields.backoffMs).toBeGreaterThan(
        Number(failures[0]?.fields.backoffMs),
      );
      await send(client, queues, message);
      await proxy.resume();
      await waitUntil(
        async () =>
          (await count(
            t.db,
            'inbox_messages WHERE message_id = ? AND processed_at IS NOT NULL',
            [message.messageId],
          )) === 1,
        30_000,
      );
      await consumer.consumer.stop();
      await running;
      expect(
        consumer.log.events('message.processed').map((e) => e.fields.result),
      ).toEqual(['PROCESSED']);
    } finally {
      await proxy.pause();
      proxiedClient.destroy();
    }
    expect(await snapshot(wallet.id)).toMatchObject({ balance: '75.00' });
    await assertFinancialInvariants(t.db, [wallet.id]);
  });
});
