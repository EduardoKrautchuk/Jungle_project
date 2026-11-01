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
import {
  killAll,
  WorkerProcess,
} from '../concurrency/support/process-harness.js';
import {
  Db,
  migrateFresh,
  openTestOrm,
} from '../integration/persistence/support.js';
import { deleteTestQueues, sendRaw, sqsClient } from '../messaging/support.js';
import { deleteEventQueues } from '../outbox/support.js';
import {
  assertFinancialInvariants,
  assertPublishedEvents,
  commandEnvelope,
  commandQueueEmpty,
  count,
  countLines,
  createWalletHttp,
  deadlocks,
  outboxDrained,
  readPublishedEvents,
  reconcileAll,
  report,
  settled,
  spawnConsumers,
  spawnPendingWorkers,
  spawnPublishers,
  stackSize,
  startStack,
  submitAny,
  submitHttp,
  waitUntil,
  wager,
  walletFacts,
  type Stack,
  type WagerBody,
  type WalletRef,
} from './support.js';

setDefaultTimeout(240_000);

let orm: MikroORM;
let db: Db;
let client: SQSClient;
let stack: Stack | undefined;
let deadlocksBefore = 0;

beforeAll(async () => {
  orm = await openTestOrm();
  await migrateFresh(orm);
  db = new Db(orm);
  client = sqsClient();
});

afterAll(async () => {
  await killAll();
  client.destroy();
  await orm.close(true);
});

beforeEach(async () => {
  await db.query('DELETE FROM outbox_messages');
  await db.query(
    `UPDATE wager_transactions SET next_reference_attempt_at = '2100-01-01T00:00:00Z'
      WHERE status = 'PENDING_REFERENCE'`,
  );
  deadlocksBefore = await deadlocks(db);
});

afterEach(async () => {
  await killAll();
  if (stack !== undefined) {
    await deleteTestQueues(client, stack.commands);
    await deleteEventQueues(client, stack.events);
    stack = undefined;
  }
  await Bun.sleep(600);
  expect(await deadlocks(db)).toBe(deadlocksBefore);
});

function sendCommand(
  target: Stack,
  body: WagerBody,
  options: { messageId?: string; groupId?: string } = {},
): Promise<string> {
  const message = commandEnvelope(body, options.messageId);
  return sendRaw(client, target.commands, JSON.stringify(message), {
    groupId: options.groupId ?? body.walletId,
  }).then(() => message.messageId);
}

async function statusOf(walletId: string, externalTransactionId: string) {
  const [row] = await db.query(
    'SELECT status, failure_code FROM wager_transactions WHERE wallet_id = ? AND external_transaction_id = ?',
    [walletId, externalTransactionId],
  );
  return row === undefined
    ? 'MISSING'
    : `${String(row.status)}${row.failure_code === null ? '' : `:${String(row.failure_code)}`}`;
}

async function quiesce(target: Stack, walletIds: readonly string[]) {
  await waitUntil(
    async () =>
      (await settled(db, walletIds)) &&
      (await commandQueueEmpty(client, target.commands)) &&
      (await outboxDrained(db)),
    90_000,
  );
}

async function replayEverything(
  target: Stack,
  bodies: readonly WagerBody[],
): Promise<void> {
  for (const [index, body] of bodies.entries()) {
    const response = await submitHttp(
      target.apis[index % target.apis.length] ?? '',
      body,
    );
    expect([200, 422]).toContain(response.status);
    expect(response.body.idempotentReplay).toBe(true);
    await sendCommand(target, body);
  }
  await quiesce(
    target,
    bodies.map((b) => b.walletId),
  );
}

describe('full stack: 3 APIs, 3 SQS consumers, 3 publishers, 3 pending workers', () => {
  it.each(['REFUND of BET', 'ROLLBACK of WIN'])(
    'resolves a %s delivered before its reference, publishes ordered events and survives replays',
    async (variant) => {
      const startedAt = Date.now();
      stack = await startStack(client);
      const target = stack;
      const wallet = await createWalletHttp(target.apis[0] ?? '');
      const isWin = variant === 'ROLLBACK of WIN';
      const reference = wager(wallet, {
        kind: isWin ? 'WIN' : 'BET',
        money: { amount: isWin ? '40.00' : '25.00', currency: 'BRL' },
      });
      const reversal = wager(wallet, {
        kind: isWin ? 'ROLLBACK' : 'REFUND',
        money: reference.money,
        referenceExternalTransactionId: reference.externalTransactionId,
      });

      await sendCommand(target, reversal);
      await waitUntil(
        async () =>
          (await statusOf(wallet.id, reversal.externalTransactionId)) ===
          'PENDING_REFERENCE',
      );
      await sendCommand(target, reference);
      await quiesce(target, [wallet.id]);

      expect(await statusOf(wallet.id, reversal.externalTransactionId)).toBe(
        'PROCESSED',
      );
      expect(await statusOf(wallet.id, reference.externalTransactionId)).toBe(
        'PROCESSED',
      );
      const before = await walletFacts(db, wallet.id);
      expect(before).toMatchObject({ balance: '100.00', ledgerEntries: 3 });
      const events = await readPublishedEvents(
        client,
        target.events,
        before.events,
      );
      await assertPublishedEvents(db, events);
      const reversalEvents = events.filter((e) =>
        e.body.includes(
          `"externalTransactionId":"${reversal.externalTransactionId}"`,
        ),
      );
      expect(reversalEvents.map((e) => e.payload.eventType)).toEqual([
        'WagerTransactionPendingReference',
        'WagerTransactionProcessed',
      ]);

      await replayEverything(target, [reversal, reference]);
      const after = await walletFacts(db, wallet.id);
      expect(after).toEqual(before);
      await assertFinancialInvariants(db, [wallet.id]);
      await reconcileAll(target.apis[1] ?? '', [wallet.id]);
      report({
        scenario: `full-stack ${variant} before reference`,
        processes: stackSize(target),
        messages: 6,
        injectedFailures: [],
        expected:
          'reversal PENDING_REFERENCE then PROCESSED once; replays change nothing',
        observed: `${await statusOf(wallet.id, reversal.externalTransactionId)}; balance ${after.balance}`,
        finalBalances: { [wallet.id]: after.balance },
        ledgerEntries: after.ledgerEntries,
        events: after.events,
        redeliveries: countLines(target.consumers, '"result":"REPLAYED"'),
        retries: countLines(
          target.consumers,
          '"event":"message.retry_scheduled"',
        ),
        newDeadlocks: (await deadlocks(db)) - deadlocksBefore,
        durationMs: Date.now() - startedAt,
      });
    },
  );

  it('processes several wallets in parallel and keeps each wallet ordered', async () => {
    const startedAt = Date.now();
    stack = await startStack(client);
    const target = stack;
    const wallets: WalletRef[] = [];
    for (let index = 0; index < 5; index += 1) {
      wallets.push(
        await createWalletHttp(target.apis[index % 3] ?? '', '200.00'),
      );
    }
    const bodies: WagerBody[] = [];
    for (const wallet of wallets) {
      const bets = [wager(wallet), wager(wallet), wager(wallet)];
      const refund = wager(wallet, {
        kind: 'REFUND',
        referenceExternalTransactionId: bets[0]?.externalTransactionId,
      });
      const win = wager(wallet, {
        kind: 'WIN',
        money: { amount: '30.00', currency: 'BRL' },
      });
      const rollback = wager(wallet, {
        kind: 'ROLLBACK',
        money: win.money,
        referenceExternalTransactionId: win.externalTransactionId,
      });
      bodies.push(refund, ...bets, rollback, win);
    }
    await Promise.all(
      bodies.map((body, index) =>
        index % 2 === 0
          ? sendCommand(target, body)
          : submitAny(target.apis, index, body),
      ),
    );
    const walletIds = wallets.map((w) => w.id);
    await quiesce(target, walletIds);

    for (const wallet of wallets) {
      expect((await walletFacts(db, wallet.id)).balance).toBe('180.00');
    }
    const total = await count(db, 'outbox_messages');
    const events = await readPublishedEvents(client, target.events, total);
    await assertPublishedEvents(db, events);
    await replayEverything(target, bodies);
    for (const wallet of wallets) {
      expect((await walletFacts(db, wallet.id)).balance).toBe('180.00');
    }
    expect(await count(db, 'outbox_messages')).toBe(total);
    await assertFinancialInvariants(db, walletIds);
    await reconcileAll(target.apis[2] ?? '', walletIds);
    report({
      scenario: 'full-stack multi-wallet mixed operations',
      processes: stackSize(target),
      messages: bodies.length * 2,
      injectedFailures: [],
      expected:
        '5 wallets end at 180.00, events complete and ordered per wallet',
      observed: 'all wallets 180.00; events matched outbox order',
      finalBalances: Object.fromEntries(wallets.map((w) => [w.id, '180.00'])),
      ledgerEntries: await count(
        db,
        `wallet_ledger_entries WHERE wallet_id IN (${walletIds.map(() => '?').join(', ')})`,
        walletIds,
      ),
      events: total,
      redeliveries: countLines(target.consumers, '"result":"REPLAYED"'),
      retries: countLines(
        target.consumers,
        '"event":"message.retry_scheduled"',
      ),
      newDeadlocks: (await deadlocks(db)) - deadlocksBefore,
      durationMs: Date.now() - startedAt,
    });
  });

  it.each([1, 2, 3])(
    'applies one BET sent 50 times through APIs and SQS consumers exactly once (run %i)',
    async () => {
      const startedAt = Date.now();
      stack = await startStack(client);
      const target = stack;
      const wallet = await createWalletHttp(target.apis[0] ?? '');
      const bet = wager(wallet, {
        money: { amount: '25.00', currency: 'BRL' },
      });
      const outcomes = await Promise.all(
        Array.from({ length: 50 }, (_, index) =>
          index % 2 === 0
            ? submitAny(target.apis, index, bet)
            : sendCommand(target, bet, { groupId: `dup-${index}` }).then(
                () => undefined,
              ),
        ),
      );
      await quiesce(target, [wallet.id]);
      const http = outcomes.filter((o) => o !== undefined);
      expect(http.every((o) => o?.status === 200)).toBe(true);
      expect(new Set(http.map((o) => String(o?.body.transactionId))).size).toBe(
        1,
      );
      expect(
        http.filter((o) => o?.body.idempotentReplay === false).length,
      ).toBeLessThanOrEqual(1);
      const facts = await walletFacts(db, wallet.id);
      expect(facts).toMatchObject({
        balance: '75.00',
        version: 2,
        ledgerEntries: 2,
      });
      expect(
        await count(
          db,
          "wager_transactions WHERE wallet_id = ? AND kind = 'BET'",
          [wallet.id],
        ),
      ).toBe(1);
      const events = await readPublishedEvents(
        client,
        target.events,
        facts.events,
      );
      await assertPublishedEvents(db, events);
      expect(
        new Set(
          events
            .filter((e) => e.payload.eventType === 'WagerTransactionProcessed')
            .map((e) => e.eventId),
        ).size,
      ).toBe(2);
      await assertFinancialInvariants(db, [wallet.id]);
      await reconcileAll(target.apis[0] ?? '', [wallet.id]);
      report({
        scenario: '50 identical BETs over HTTP and SQS',
        processes: stackSize(target),
        messages: 50,
        injectedFailures: [],
        expected:
          'one transaction, one debit, one Processed event, balance 75.00',
        observed: `balance ${facts.balance}, ledger ${facts.ledgerEntries}, version ${facts.version}`,
        finalBalances: { [wallet.id]: facts.balance },
        ledgerEntries: facts.ledgerEntries,
        events: facts.events,
        redeliveries: countLines(target.consumers, '"result":"REPLAYED"'),
        retries: countLines(
          target.consumers,
          '"event":"message.retry_scheduled"',
        ),
        newDeadlocks: (await deadlocks(db)) - deadlocksBefore,
        durationMs: Date.now() - startedAt,
      });
    },
  );

  it('keeps every wallet exact while one process of each component is SIGKILLed mid-load', async () => {
    const startedAt = Date.now();
    stack = await startStack(client);
    const target = stack;
    const wallets: WalletRef[] = [];
    for (let index = 0; index < 6; index += 1) {
      wallets.push(
        await createWalletHttp(target.apis[index % 3] ?? '', '200.00'),
      );
    }
    const bodies: WagerBody[] = [];
    for (const wallet of wallets) {
      const bets = Array.from({ length: 4 }, () => wager(wallet));
      const refunds = bets.slice(0, 2).map((bet) =>
        wager(wallet, {
          kind: 'REFUND',
          referenceExternalTransactionId: bet.externalTransactionId,
        }),
      );
      const win = wager(wallet, {
        kind: 'WIN',
        money: { amount: '30.00', currency: 'BRL' },
      });
      const rollback = wager(wallet, {
        kind: 'ROLLBACK',
        money: win.money,
        referenceExternalTransactionId: win.externalTransactionId,
      });
      bodies.push(...refunds, ...bets, rollback, win);
    }
    const sending = Promise.all(
      bodies.map((body, index) =>
        index % 2 === 0
          ? sendCommand(target, body)
          : submitAny(target.apis, index, body),
      ),
    );
    await Bun.sleep(400);
    const victims: WorkerProcess[] = [
      target.apiProcesses[0],
      target.consumers[0],
      target.publishers[0],
      target.pendingWorkers[0],
    ].filter((p): p is WorkerProcess => p !== undefined);
    for (const victim of victims) {
      victim.kill('SIGKILL');
    }
    await sending;
    const replacements = [
      ...(await spawnConsumers(1, target.commands)),
      ...(await spawnPublishers(1, target.events)),
      ...(await spawnPendingWorkers(1)),
    ];
    const walletIds = wallets.map((w) => w.id);
    await quiesce(target, walletIds);

    for (const wallet of wallets) {
      expect((await walletFacts(db, wallet.id)).balance).toBe('180.00');
    }
    const total = await count(db, 'outbox_messages');
    const events = await readPublishedEvents(client, target.events, total);
    await assertPublishedEvents(db, events);
    expect(
      await count(db, 'outbox_messages WHERE lease_token IS NOT NULL'),
    ).toBe(0);
    expect(await count(db, 'inbox_messages WHERE processed_at IS NULL')).toBe(
      0,
    );
    await assertFinancialInvariants(db, walletIds);
    await reconcileAll(target.apis[1] ?? '', walletIds);
    const allConsumers = [...target.consumers, ...replacements];
    report({
      scenario:
        'mixed load with SIGKILL of one API, consumer, publisher and pending worker',
      processes: { ...stackSize(target), replacements: replacements.length },
      messages: bodies.length,
      injectedFailures: [
        'SIGKILL api',
        'SIGKILL consumer',
        'SIGKILL publisher',
        'SIGKILL pending worker',
      ],
      expected:
        'every wallet 180.00, events complete and ordered, no stuck leases or inbox rows',
      observed:
        'all wallets 180.00; no stuck leases; reconciliation consistent',
      finalBalances: Object.fromEntries(wallets.map((w) => [w.id, '180.00'])),
      ledgerEntries: await count(
        db,
        `wallet_ledger_entries WHERE wallet_id IN (${walletIds.map(() => '?').join(', ')})`,
        walletIds,
      ),
      events: total,
      redeliveries: countLines(allConsumers, '"receiveCount":2'),
      retries: countLines(allConsumers, '"event":"message.retry_scheduled"'),
      newDeadlocks: (await deadlocks(db)) - deadlocksBefore,
      durationMs: Date.now() - startedAt,
    });
  });

  it('answers a replay after an API process died between commit and response', async () => {
    stack = await startStack(client, {
      consumers: 1,
      publishers: 1,
      pendingWorkers: 1,
    });
    const target = stack;
    const wallet = await createWalletHttp(target.apis[1] ?? '');
    const bet = wager(wallet, { money: { amount: '30.00', currency: 'BRL' } });
    let failure: unknown;
    try {
      await submitHttp(target.apis[0] ?? '', bet, {
        'x-test-crash-after-commit': '1',
      });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(Error);
    const exit = await target.apiProcesses[0]?.exit(10_000);
    expect(exit?.signalCode).toBe('SIGKILL');
    expect(await statusOf(wallet.id, bet.externalTransactionId)).toBe(
      'PROCESSED',
    );

    const retried = await submitHttp(target.apis[2] ?? '', bet);
    expect(retried.status).toBe(200);
    expect(retried.body).toMatchObject({
      status: 'PROCESSED',
      idempotentReplay: true,
      balance: { amount: '70.00', currency: 'BRL' },
    });
    await quiesce(target, [wallet.id]);
    expect(await walletFacts(db, wallet.id)).toMatchObject({
      balance: '70.00',
      ledgerEntries: 2,
    });
    await assertFinancialInvariants(db, [wallet.id]);
    await reconcileAll(target.apis[1] ?? '', [wallet.id]);
  });
});

describe('concurrent competition on balance and reversals', () => {
  it.each([0, 1, 2, 3, 4, 5])(
    'lets exactly one of two 80.00 BETs win a 100.00 balance and replays both (run %i)',
    async (run) => {
      stack = await startStack(client, {
        consumers: 1,
        publishers: 1,
        pendingWorkers: 1,
      });
      const target = stack;
      const wallet = await createWalletHttp(target.apis[0] ?? '');
      const first = wager(wallet, {
        money: { amount: '80.00', currency: 'BRL' },
      });
      const second = wager(wallet, {
        money: { amount: '80.00', currency: 'BRL' },
      });
      const [a, b] = run % 2 === 0 ? [first, second] : [second, first];
      const results = await Promise.all([
        submitHttp(target.apis[run % 3] ?? '', a),
        Bun.sleep(run % 3).then(() =>
          submitHttp(target.apis[(run + 1) % 3] ?? '', b),
        ),
      ]);
      const statuses = results
        .map((r) => `${r.status}:${String(r.body.status)}`)
        .sort();
      expect(statuses).toEqual(['200:PROCESSED', '422:REJECTED']);
      const rejected = results.find((r) => r.status === 422);
      expect(rejected?.body).toMatchObject({
        failureCode: 'INSUFFICIENT_FUNDS',
        balance: { amount: '20.00', currency: 'BRL' },
      });
      const replays = await Promise.all([
        submitHttp(target.apis[2] ?? '', a),
        submitHttp(target.apis[0] ?? '', b),
      ]);
      const byNumber = (x: number, y: number) => x - y;
      expect(replays.map((r) => r.status).sort(byNumber)).toEqual(
        results.map((r) => r.status).sort(byNumber),
      );
      for (const [index, replay] of replays.entries()) {
        expect(replay.body).toEqual({
          ...results[index]?.body,
          idempotentReplay: true,
        });
      }
      await quiesce(target, [wallet.id]);
      expect(await walletFacts(db, wallet.id)).toMatchObject({
        balance: '20.00',
        ledgerEntries: 2,
        version: 2,
      });
      expect(
        await count(
          db,
          "wallet_ledger_entries WHERE wallet_id = ? AND direction = 'DEBIT'",
          [wallet.id],
        ),
      ).toBe(1);
      await assertFinancialInvariants(db, [wallet.id]);
      await reconcileAll(target.apis[1] ?? '', [wallet.id]);
    },
  );

  it.each([1, 2, 3])(
    'keeps every reversal combination to at most one effect per reference (run %i)',
    async () => {
      const startedAt = Date.now();
      stack = await startStack(client, { consumers: 1, publishers: 1 });
      const target = stack;
      const apis = target.apis;
      const cases: {
        name: string;
        wallet: WalletRef;
        expected: Record<string, string>;
      }[] = [];
      const fresh = async (name: string) => {
        const wallet = await createWalletHttp(apis[cases.length % 3] ?? '');
        return { name, wallet };
      };

      const concurrent = async (bodies: WagerBody[]) =>
        Promise.all(bodies.map((body, index) => submitAny(apis, index, body)));

      {
        const { name, wallet } = await fresh('BET with concurrent REFUND');
        const bet = wager(wallet);
        const refund = wager(wallet, {
          kind: 'REFUND',
          referenceExternalTransactionId: bet.externalTransactionId,
        });
        await concurrent([refund, bet]);
        cases.push({
          name,
          wallet,
          expected: {
            [bet.externalTransactionId]: 'PROCESSED',
            [refund.externalTransactionId]: 'PROCESSED',
          },
        });
      }
      {
        const { name, wallet } = await fresh('BET with concurrent ROLLBACK');
        const bet = wager(wallet);
        const rollback = wager(wallet, {
          kind: 'ROLLBACK',
          referenceExternalTransactionId: bet.externalTransactionId,
        });
        await concurrent([rollback, bet]);
        cases.push({
          name,
          wallet,
          expected: {
            [bet.externalTransactionId]: 'PROCESSED',
            [rollback.externalTransactionId]: 'PROCESSED',
          },
        });
      }
      {
        const { name, wallet } = await fresh('WIN with concurrent ROLLBACK');
        const win = wager(wallet, {
          kind: 'WIN',
          money: { amount: '15.00', currency: 'BRL' },
        });
        const rollback = wager(wallet, {
          kind: 'ROLLBACK',
          money: win.money,
          referenceExternalTransactionId: win.externalTransactionId,
        });
        await concurrent([rollback, win]);
        cases.push({
          name,
          wallet,
          expected: {
            [win.externalTransactionId]: 'PROCESSED',
            [rollback.externalTransactionId]: 'PROCESSED',
          },
        });
      }
      for (const [label, kinds] of [
        ['REFUND and ROLLBACK at once', ['REFUND', 'ROLLBACK']],
        ['duplicate REFUND', ['REFUND', 'REFUND']],
        ['duplicate ROLLBACK', ['ROLLBACK', 'ROLLBACK']],
      ] as const) {
        const { name, wallet } = await fresh(label);
        const bet = wager(wallet);
        await submitAny(apis, 0, bet);
        const reversals = kinds.map((kind) =>
          wager(wallet, {
            kind,
            referenceExternalTransactionId: bet.externalTransactionId,
          }),
        );
        const outcomes = await concurrent(reversals);
        expect(outcomes.map((o) => o.status).sort((x, y) => x - y)).toEqual([
          200, 422,
        ]);
        expect(outcomes.find((o) => o.status === 422)?.body.failureCode).toBe(
          'ALREADY_REVERSED',
        );
        cases.push({
          name,
          wallet,
          expected: { [bet.externalTransactionId]: 'PROCESSED' },
        });
      }
      {
        const { name, wallet } = await fresh('reference definitively rejected');
        const bet = wager(wallet, {
          money: { amount: '500.00', currency: 'BRL' },
        });
        const refund = wager(wallet, {
          kind: 'REFUND',
          money: bet.money,
          referenceExternalTransactionId: bet.externalTransactionId,
        });
        await concurrent([refund, bet]);
        cases.push({
          name,
          wallet,
          expected: {
            [bet.externalTransactionId]: 'REJECTED:INSUFFICIENT_FUNDS',
            [refund.externalTransactionId]: 'REJECTED:REFERENCE_NOT_PROCESSED',
          },
        });
      }
      {
        const { name, wallet } = await fresh('already reversed reference');
        const bet = wager(wallet);
        const rollback = wager(wallet, {
          kind: 'ROLLBACK',
          referenceExternalTransactionId: bet.externalTransactionId,
        });
        const refund = wager(wallet, {
          kind: 'REFUND',
          referenceExternalTransactionId: bet.externalTransactionId,
        });
        await submitAny(apis, 0, bet);
        await submitAny(apis, 1, rollback);
        await submitAny(apis, 2, refund);
        cases.push({
          name,
          wallet,
          expected: {
            [rollback.externalTransactionId]: 'PROCESSED',
            [refund.externalTransactionId]: 'REJECTED:ALREADY_REVERSED',
          },
        });
      }

      const walletIds = cases.map((c) => c.wallet.id);
      await quiesce(target, walletIds);
      for (const testCase of cases) {
        for (const [externalId, expected] of Object.entries(
          testCase.expected,
        )) {
          expect(
            `${testCase.name}: ${await statusOf(testCase.wallet.id, externalId)}`,
          ).toBe(`${testCase.name}: ${expected}`);
        }
        expect(
          `${testCase.name}: ${(await walletFacts(db, testCase.wallet.id)).balance}`,
        ).toBe(`${testCase.name}: 100.00`);
      }
      await assertFinancialInvariants(db, walletIds);
      await reconcileAll(apis[0] ?? '', walletIds);
      report({
        scenario: 'reversal combinations',
        processes: stackSize(target),
        messages: 22,
        injectedFailures: [],
        expected:
          'at most one reversal per reference; every wallet back to 100.00',
        observed: 'all cases matched expected statuses; all wallets 100.00',
        finalBalances: Object.fromEntries(cases.map((c) => [c.name, '100.00'])),
        ledgerEntries: await count(
          db,
          `wallet_ledger_entries WHERE wallet_id IN (${walletIds.map(() => '?').join(', ')})`,
          walletIds,
        ),
        events: await count(db, 'outbox_messages'),
        redeliveries: 0,
        retries: 0,
        newDeadlocks: (await deadlocks(db)) - deadlocksBefore,
        durationMs: Date.now() - startedAt,
      });
    },
  );
});
