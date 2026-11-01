import type { EntityManager } from '@mikro-orm/postgresql';
import type { SqsConfig } from '../config/sqs.config.js';
import type { SqsHealthIndicator } from '../messaging/sqs-health.indicator.js';
import { SqlOutboxPublicationStore } from '../persistence/outbox-publication.store.js';
import { DEFAULT_HEALTH_TIMEOUT_MS } from './dependency-health.js';
import type { GaugeFamily, MetricDefinition } from './metrics.js';
import { withTimeout } from './with-timeout.js';

const GAUGE = {
  transactions: {
    name: 'wagering_transactions',
    help: 'Wager transactions stored in PostgreSQL by status (system-wide)',
    type: 'gauge',
  },
  outboxPending: {
    name: 'wagering_outbox_pending_events',
    help: 'Outbox events not yet published or dead-lettered (system-wide)',
    type: 'gauge',
  },
  outboxLag: {
    name: 'wagering_outbox_lag_seconds',
    help: 'Age of the oldest unpublished outbox event, 0 when empty (system-wide)',
    type: 'gauge',
  },
  outboxDeadLettered: {
    name: 'wagering_outbox_dead_lettered_events',
    help: 'Outbox events the publisher dead-lettered (system-wide)',
    type: 'gauge',
  },
  queueMessages: {
    name: 'wagering_sqs_queue_messages',
    help: 'ApproximateNumberOfMessages reported by SQS for each queue (system-wide)',
    type: 'gauge',
  },
  sourceUp: {
    name: 'wagering_metrics_source_up',
    help: 'Whether the system-wide gauges of a source could be collected',
    type: 'gauge',
  },
} as const satisfies Record<string, MetricDefinition>;

const STATUS_SQL = `SELECT status, count(*)::int AS total
  FROM wager_transactions
 GROUP BY status
 ORDER BY status`;

export class SystemGauges {
  constructor(
    private readonly em: EntityManager,
    private readonly sqs: SqsHealthIndicator,
    private readonly config: SqsConfig,
    private readonly timeoutMs = DEFAULT_HEALTH_TIMEOUT_MS,
  ) {}

  async collect(): Promise<GaugeFamily[]> {
    const [database, queues] = await Promise.all([
      this.#database().catch(() => undefined),
      this.#queues().catch(() => undefined),
    ]);
    return [
      ...(database ?? []),
      ...(queues ?? []),
      {
        definition: GAUGE.sourceUp,
        samples: [
          { labels: { source: 'postgres' }, value: database ? 1 : 0 },
          { labels: { source: 'sqs' }, value: queues ? 1 : 0 },
        ],
      },
    ];
  }

  async #database(): Promise<GaugeFamily[]> {
    const em = this.em.fork();
    const [rows, backlog] = await withTimeout(
      () =>
        Promise.all([
          em
            .getConnection()
            .execute<{ status: string; total: number }[]>(STATUS_SQL),
          new SqlOutboxPublicationStore(em).backlog(),
        ]),
      this.timeoutMs,
    );
    return [
      {
        definition: GAUGE.transactions,
        samples: rows.map((row) => ({
          labels: { status: row.status },
          value: Number(row.total),
        })),
      },
      {
        definition: GAUGE.outboxPending,
        samples: [{ labels: {}, value: backlog.pending }],
      },
      {
        definition: GAUGE.outboxLag,
        samples: [
          { labels: {}, value: (backlog.oldestPendingAgeMs ?? 0) / 1_000 },
        ],
      },
      {
        definition: GAUGE.outboxDeadLettered,
        samples: [{ labels: {}, value: backlog.deadLettered }],
      },
    ];
  }

  async #queues(): Promise<GaugeFamily[]> {
    const names = [
      this.config.queueName,
      this.config.deadLetterQueueName,
      this.config.eventsQueueName,
      this.config.eventsDeadLetterQueueName,
    ];
    const depths = await Promise.all(
      names.map((name) => this.sqs.approximateMessages(name)),
    );
    return [
      {
        definition: GAUGE.queueMessages,
        samples: names.map((queue, index) => ({
          labels: { queue },
          value: depths[index] ?? 0,
        })),
      },
    ];
  }
}
