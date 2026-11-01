import { describe, expect, it } from 'bun:test';
import {
  MeteredLog,
  recordEvent,
  WAGER_SUBMISSION_OPERATION,
} from '../../../../src/infrastructure/observability/metered-log.js';
import {
  loadMetricsPort,
  serveMetrics,
} from '../../../../src/infrastructure/observability/metrics-server.js';
import {
  METRIC,
  Metrics,
} from '../../../../src/infrastructure/observability/metrics.js';
import {
  TimeoutError,
  withTimeout,
} from '../../../../src/infrastructure/observability/with-timeout.js';
import { MemoryLog } from '../../../messaging/support.js';

describe('Metrics', () => {
  it('renders counters in the Prometheus text format with sorted, escaped labels', () => {
    const metrics = new Metrics();
    metrics.increment(METRIC.operations, {
      source: 'http',
      result: 'PROCESSED',
    });
    metrics.increment(METRIC.operations, {
      result: 'PROCESSED',
      source: 'http',
    });
    metrics.increment(METRIC.retries, { component: 'sqs', reason: 'a"b\\c' });

    const text = metrics.render();

    expect(text).toContain('# TYPE wagering_operations_total counter');
    expect(text).toContain(
      'wagering_operations_total{result="PROCESSED",source="http"} 2',
    );
    expect(text).toContain(
      'wagering_retries_total{component="sqs",reason="a\\"b\\\\c"} 1',
    );
    expect(
      metrics.counterValue(METRIC.operations, {
        source: 'http',
        result: 'PROCESSED',
      }),
    ).toBe(2);
  });

  it('renders cumulative histogram buckets, sum and count', () => {
    const metrics = new Metrics();
    metrics.observe(METRIC.duration, 0.02, { source: 'sqs' });
    metrics.observe(METRIC.duration, 3, { source: 'sqs' });

    const text = metrics.render();

    expect(text).toContain(
      'wagering_operation_duration_seconds_bucket{le="0.01",source="sqs"} 0',
    );
    expect(text).toContain(
      'wagering_operation_duration_seconds_bucket{le="0.025",source="sqs"} 1',
    );
    expect(text).toContain(
      'wagering_operation_duration_seconds_bucket{le="5",source="sqs"} 2',
    );
    expect(text).toContain(
      'wagering_operation_duration_seconds_bucket{le="+Inf",source="sqs"} 2',
    );
    expect(text).toContain(
      'wagering_operation_duration_seconds_sum{source="sqs"} 3.02',
    );
    expect(text).toContain(
      'wagering_operation_duration_seconds_count{source="sqs"} 2',
    );
  });

  it('appends gauge families supplied at render time', () => {
    const text = new Metrics().render([
      {
        definition: { name: 'some_gauge', help: 'help', type: 'gauge' },
        samples: [{ labels: { status: 'PROCESSED' }, value: 4 }],
      },
    ]);
    expect(text).toContain('# TYPE some_gauge gauge');
    expect(text).toContain('some_gauge{status="PROCESSED"} 4');
  });
});

describe('MeteredLog', () => {
  it('forwards every entry and counts HTTP wager submissions only', () => {
    const inner = new MemoryLog();
    const metrics = new Metrics();
    const log = new MeteredLog(inner, metrics);

    log.write('info', 'http.request', {
      operation: WAGER_SUBMISSION_OPERATION,
      result: 'PROCESSED',
      idempotentReplay: false,
      durationMs: 12,
    });
    log.write('info', 'http.request', {
      operation: WAGER_SUBMISSION_OPERATION,
      result: 'PROCESSED',
      idempotentReplay: true,
      durationMs: 3,
    });
    log.write('warn', 'http.request', {
      operation: WAGER_SUBMISSION_OPERATION,
      result: 'CONCURRENCY_CONFLICT',
      errorCode: 'CONCURRENCY_CONFLICT',
      durationMs: 1_000,
    });
    log.write('info', 'http.request', {
      operation: 'WalletsController.get',
      durationMs: 2,
    });

    expect(inner.entries).toHaveLength(4);
    expect(
      metrics.counterValue(METRIC.operations, {
        source: 'http',
        result: 'PROCESSED',
      }),
    ).toBe(2);
    expect(
      metrics.counterValue(METRIC.duplicates, {
        source: 'http',
        kind: 'idempotent_replay',
      }),
    ).toBe(1);
    expect(metrics.counterValue(METRIC.lockConflicts, { source: 'http' })).toBe(
      1,
    );
    expect(metrics.render()).toContain(
      'wagering_operation_duration_seconds_count{source="http"} 3',
    );
  });

  it('maps worker events to retries, dead letters and lock conflicts', () => {
    const metrics = new Metrics();
    recordEvent(metrics, 'outbox.published', {
      result: 'PUBLISHED',
      durationMs: 5,
    });
    recordEvent(metrics, 'outbox.retry_scheduled', {
      result: 'RETRY_SCHEDULED',
      errorCode: 'TimeoutError',
    });
    recordEvent(metrics, 'outbox.dead_lettered', {
      result: 'DEAD_LETTERED',
      errorCode: 'INVALID_EVENT',
    });
    recordEvent(metrics, 'outbox.claimed', { claimed: 3 });
    recordEvent(metrics, 'outbox.lease_recovered', { previousOwner: 'p0' });
    recordEvent(metrics, 'pending.resolution', { result: 'RESCHEDULED' });
    recordEvent(metrics, 'pending.resolution_failed', {
      result: 'TRANSIENT_FAILURE',
      errorCode: 'PERSISTENCE_CONCURRENCY_CONFLICT',
    });
    recordEvent(metrics, 'message.dead_lettered', {
      result: 'DEAD_LETTERED',
      errorCode: 'MALFORMED_MESSAGE',
    });

    expect(
      metrics.counterValue(METRIC.operations, {
        source: 'outbox_publisher',
        result: 'PUBLISHED',
      }),
    ).toBe(1);
    expect(
      metrics.counterValue(METRIC.retries, {
        component: 'outbox_publisher',
        reason: 'TimeoutError',
      }),
    ).toBe(1);
    expect(
      metrics.counterValue(METRIC.deadLetters, {
        component: 'outbox_publisher',
        reason: 'INVALID_EVENT',
      }),
    ).toBe(1);
    expect(
      metrics.counterValue(METRIC.retries, {
        component: 'pending_worker',
        reason: 'REFERENCE_NOT_AVAILABLE',
      }),
    ).toBe(1);
    expect(
      metrics.counterValue(METRIC.lockConflicts, { source: 'pending_worker' }),
    ).toBe(1);
    expect(
      metrics.counterValue(METRIC.deadLetters, {
        component: 'sqs',
        reason: 'MALFORMED_MESSAGE',
      }),
    ).toBe(1);
    expect(metrics.render()).not.toContain('CLAIMED');
    expect(metrics.render()).not.toContain('LEASE_RECOVERED');
  });

  it('counts reconciliations by result', () => {
    const metrics = new Metrics();
    recordEvent(metrics, 'wallet.reconciliation', { consistent: true });
    recordEvent(metrics, 'wallet.reconciliation', { consistent: false });
    recordEvent(metrics, 'wallet.reconciliation', { consistent: false });
    expect(
      metrics.counterValue(METRIC.reconciliations, { result: 'consistent' }),
    ).toBe(1);
    expect(
      metrics.counterValue(METRIC.reconciliations, { result: 'divergent' }),
    ).toBe(2);
  });
});

describe('worker metrics endpoint', () => {
  it('reads METRICS_PORT and rejects invalid values', () => {
    expect(loadMetricsPort({})).toBeUndefined();
    expect(loadMetricsPort({ METRICS_PORT: ' ' })).toBeUndefined();
    expect(loadMetricsPort({ METRICS_PORT: '9101' })).toBe(9101);
    expect(() => loadMetricsPort({ METRICS_PORT: '70000' })).toThrow(
      'METRICS_PORT',
    );
    expect(() => loadMetricsPort({ METRICS_PORT: 'abc' })).toThrow(
      'METRICS_PORT',
    );
  });

  it('serves the process registry on /metrics only', async () => {
    const metrics = new Metrics();
    metrics.increment(METRIC.operations, {
      source: 'sqs',
      result: 'PROCESSED',
    });
    const server = serveMetrics(metrics, 0);
    try {
      const response = await fetch(`http://127.0.0.1:${server.port}/metrics`);
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toContain('text/plain');
      expect(await response.text()).toContain(
        'wagering_operations_total{result="PROCESSED",source="sqs"} 1',
      );
      const other = await fetch(`http://127.0.0.1:${server.port}/other`);
      expect(other.status).toBe(404);
    } finally {
      await server.stop();
    }
  });
});

describe('withTimeout', () => {
  it('returns the result of work that finishes in time', async () => {
    expect(await withTimeout(() => Promise.resolve(7), 100)).toBe(7);
  });

  it('aborts the signal and rejects with TimeoutError when work hangs', async () => {
    let aborted = false;
    const hanging = withTimeout(
      (signal) =>
        new Promise<never>(() => {
          signal.addEventListener('abort', () => {
            aborted = true;
          });
        }),
      30,
    );
    let caught: unknown;
    try {
      await hanging;
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(TimeoutError);
    expect(aborted).toBe(true);
  });
});
