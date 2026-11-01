import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  spyOn,
  type Mock,
} from 'bun:test';
import {
  json,
  keyOf,
  startTestApp,
  text,
  uniqueId,
  wagerBody,
  type TestApp,
  type WalletRef,
} from './support.js';

let t: TestApp;
let stdout: Mock<typeof process.stdout.write>;

beforeAll(async () => {
  t = await startTestApp();
});

afterAll(async () => {
  await t.close();
});

beforeEach(() => {
  stdout = spyOn(process.stdout, 'write');
});

afterEach(() => {
  stdout.mockRestore();
});

type LogLine = Record<string, unknown>;

function logLines(): LogLine[] {
  const lines: LogLine[] = [];
  for (const [chunk] of stdout.mock.calls) {
    const raw =
      typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk);
    for (const line of raw.split('\n')) {
      if (line.startsWith('{')) {
        lines.push(json(JSON.parse(line)));
      }
    }
  }
  return lines;
}

async function eventsWhere(
  event: string,
  predicate: (line: LogLine) => boolean,
  expected = 1,
): Promise<LogLine[]> {
  const deadline = Date.now() + 2_000;
  for (;;) {
    const found = logLines().filter(
      (line) => line.event === event && predicate(line),
    );
    if (found.length >= expected || Date.now() > deadline) {
      return found;
    }
    await Bun.sleep(20);
  }
}

async function createWallet(): Promise<WalletRef> {
  const playerId = uniqueId('player');
  const response = await t
    .http()
    .post('/wallets')
    .send({ playerId, initialBalance: { amount: '100.00', currency: 'BRL' } });
  expect(response.status).toBe(201);
  return { id: text(json(response.body).id), playerId };
}

function metricValue(metrics: string, series: string): number {
  const line = metrics.split('\n').find((l) => l.startsWith(`${series} `));
  return line === undefined ? 0 : Number(line.slice(series.length + 1));
}

describe('HTTP observability', () => {
  it('logs one structured line per wager submission without financial payloads', async () => {
    const wallet = await createWallet();
    const body = wagerBody(wallet);
    const correlationId = uniqueId('corr');
    const response = await t
      .http()
      .post('/wagering/transactions')
      .set('Idempotency-Key', keyOf(body))
      .set('X-Correlation-Id', correlationId)
      .send(body);
    expect(response.status).toBe(200);
    const transactionId = text(json(response.body).transactionId);

    const [line] = await eventsWhere(
      'http.request',
      (l) => l.correlationId === correlationId,
    );
    expect(line).toMatchObject({
      level: 'info',
      component: 'http-api',
      operation: 'WageringController.submit',
      method: 'POST',
      statusCode: 200,
      correlationId,
      transactionId,
      walletId: wallet.id,
      providerId: 'provider-a',
      kind: 'BET',
      result: 'PROCESSED',
      idempotentReplay: false,
    });
    expect(typeof line?.durationMs).toBe('number');
    const serialized = JSON.stringify(line);
    expect(serialized).not.toContain('25.00');
    expect(serialized).not.toContain('75.00');
    expect(serialized).not.toContain(wallet.playerId);
    expect(serialized).not.toContain(keyOf(body));
  });

  it('logs replays and conflicts with their outcome and status', async () => {
    const wallet = await createWallet();
    const body = wagerBody(wallet);
    const replayCorrelation = uniqueId('corr');
    const conflictCorrelation = uniqueId('corr');
    await t
      .http()
      .post('/wagering/transactions')
      .set('Idempotency-Key', keyOf(body))
      .send(body);
    await t
      .http()
      .post('/wagering/transactions')
      .set('Idempotency-Key', keyOf(body))
      .set('X-Correlation-Id', replayCorrelation)
      .send(body);
    const conflict = await t
      .http()
      .post('/wagering/transactions')
      .set('Idempotency-Key', keyOf(body))
      .set('X-Correlation-Id', conflictCorrelation)
      .send({ ...body, money: { amount: '30.00', currency: 'BRL' } });
    expect(conflict.status).toBe(409);

    const [replay] = await eventsWhere(
      'http.request',
      (l) => l.correlationId === replayCorrelation,
    );
    expect(replay).toMatchObject({
      statusCode: 200,
      result: 'PROCESSED',
      idempotentReplay: true,
    });
    const [rejected] = await eventsWhere(
      'http.request',
      (l) => l.correlationId === conflictCorrelation,
    );
    expect(rejected).toMatchObject({
      level: 'warn',
      statusCode: 409,
      errorCode: 'IDEMPOTENCY_CONFLICT',
      result: 'IDEMPOTENCY_CONFLICT',
      walletId: wallet.id,
      providerId: 'provider-a',
    });
  });

  it('logs every reconciliation with its result', async () => {
    const wallet = await createWallet();
    const response = await t
      .http()
      .post(`/wallets/${wallet.id}/reconciliation`);
    expect(response.status).toBe(200);
    const [line] = await eventsWhere(
      'wallet.reconciliation',
      (l) => l.walletId === wallet.id,
    );
    expect(line).toMatchObject({
      level: 'info',
      consistent: true,
      checkedEntries: 1,
    });
  });
});

describe('GET /metrics', () => {
  it('counts this process operations and reports system-wide gauges', async () => {
    const before = (await t.http().get('/metrics')).text;
    const wallet = await createWallet();
    const body = wagerBody(wallet);
    for (let i = 0; i < 2; i += 1) {
      await t
        .http()
        .post('/wagering/transactions')
        .set('Idempotency-Key', keyOf(body))
        .send(body);
    }
    const conflict = await t
      .http()
      .post('/wagering/transactions')
      .set('Idempotency-Key', keyOf(body))
      .send({ ...body, roundId: 'other-round' });
    expect(conflict.status).toBe(409);
    await t.http().post(`/wallets/${wallet.id}/reconciliation`);
    await eventsWhere('http.request', (l) => l.walletId === wallet.id, 4);

    const response = await t.http().get('/metrics');
    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toContain('text/plain');
    const after = response.text;
    const delta = (series: string) =>
      metricValue(after, series) - metricValue(before, series);

    expect(
      delta('wagering_operations_total{result="PROCESSED",source="http"}'),
    ).toBe(2);
    expect(
      delta(
        'wagering_operations_total{result="IDEMPOTENCY_CONFLICT",source="http"}',
      ),
    ).toBe(1);
    expect(
      delta(
        'wagering_duplicates_total{kind="idempotent_replay",source="http"}',
      ),
    ).toBe(1);
    expect(delta('wagering_reconciliations_total{result="consistent"}')).toBe(
      1,
    );
    expect(
      delta('wagering_operation_duration_seconds_count{source="http"}'),
    ).toBe(3);

    const [row] = await t.db.query(
      "SELECT count(*)::int AS total FROM wager_transactions WHERE status = 'PROCESSED'",
    );
    expect(
      metricValue(after, 'wagering_transactions{status="PROCESSED"}'),
    ).toBe(Number(row?.total));
    expect(after).toContain('wagering_metrics_source_up{source="postgres"} 1');
    expect(after).toContain('wagering_metrics_source_up{source="sqs"} 1');
    expect(after).toContain('wagering_outbox_lag_seconds ');
  });
});
