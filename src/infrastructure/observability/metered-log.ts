import { METRIC, type Metrics } from './metrics.js';
import type { LogFields, LogLevel, StructuredLog } from './structured-log.js';

export const WAGER_SUBMISSION_OPERATION = 'WageringController.submit';

const LOCK_CONFLICT_CODES: ReadonlySet<string> = new Set([
  'CONCURRENCY_CONFLICT',
  'PERSISTENCE_CONCURRENCY_CONFLICT',
]);

export class MeteredLog implements StructuredLog {
  constructor(
    private readonly inner: StructuredLog,
    private readonly metrics: Metrics,
  ) {}

  write(level: LogLevel, event: string, fields: LogFields = {}): void {
    this.inner.write(level, event, fields);
    recordEvent(this.metrics, event, fields);
  }
}

export function recordEvent(
  metrics: Metrics,
  event: string,
  fields: LogFields,
): void {
  const source = sourceOf(event, fields);
  if (source === undefined) {
    if (event === 'wallet.reconciliation') {
      metrics.increment(METRIC.reconciliations, {
        result: fields.consistent === true ? 'consistent' : 'divergent',
      });
    }
    return;
  }

  const result = textOf(fields.result) ?? resultOf(event);
  const errorCode = textOf(fields.errorCode);
  metrics.increment(METRIC.operations, { source, result });
  if (typeof fields.durationMs === 'number') {
    metrics.observe(METRIC.duration, fields.durationMs / 1_000, { source });
  }
  if (errorCode !== undefined && LOCK_CONFLICT_CODES.has(errorCode)) {
    metrics.increment(METRIC.lockConflicts, { source });
  }

  if (fields.idempotentReplay === true || result === 'REPLAYED') {
    metrics.increment(METRIC.duplicates, { source, kind: 'idempotent_replay' });
  }
  if (result === 'DUPLICATE_MESSAGE') {
    metrics.increment(METRIC.duplicates, { source, kind: 'inbox_duplicate' });
  }
  if (result === 'RETRY' || result === 'RETRY_SCHEDULED') {
    metrics.increment(METRIC.retries, {
      component: source,
      reason: errorCode ?? 'UNKNOWN',
    });
  }
  if (result === 'RESCHEDULED') {
    metrics.increment(METRIC.retries, {
      component: source,
      reason: 'REFERENCE_NOT_AVAILABLE',
    });
  }
  if (result === 'DEAD_LETTERED') {
    metrics.increment(METRIC.deadLetters, {
      component: source,
      reason: errorCode ?? 'UNKNOWN',
    });
  }
}

function sourceOf(event: string, fields: LogFields): string | undefined {
  if (event === 'http.request') {
    return fields.operation === WAGER_SUBMISSION_OPERATION ? 'http' : undefined;
  }
  if (
    event === 'message.processed' ||
    event === 'message.retry_scheduled' ||
    event === 'message.dead_lettered'
  ) {
    return 'sqs';
  }
  if (event === 'pending.resolution' || event === 'pending.resolution_failed') {
    return 'pending_worker';
  }
  if (
    event.startsWith('outbox.') &&
    event !== 'outbox.claimed' &&
    event !== 'outbox.lease_recovered'
  ) {
    return 'outbox_publisher';
  }
  return undefined;
}

function resultOf(event: string): string {
  return event.slice(event.indexOf('.') + 1).toUpperCase();
}

function textOf(value: LogFields[string]): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}
