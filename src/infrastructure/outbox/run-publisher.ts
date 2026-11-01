import type { INestApplicationContext } from '@nestjs/common';
import {
  OUTBOX_PUBLICATION_STORE,
  type OutboxPublicationStore,
} from '../../application/ports/outbox-publication.js';
import type { Metrics } from '../observability/metrics.js';
import {
  loadMetricsPort,
  serveMetrics,
  type MetricsServer,
} from '../observability/metrics-server.js';
import { METRICS } from '../observability/observability.module.js';
import type { StructuredLog } from '../observability/structured-log.js';
import { DatabaseHealthIndicator } from '../persistence/database-health.indicator.js';
import { PUBLISHER_LOG } from './outbox-publisher.module.js';
import { OutboxPublisherWorker } from './outbox-publisher-worker.js';

const SIGNALS = ['SIGTERM', 'SIGINT'] as const;

export async function runPublisher(
  app: INestApplicationContext,
): Promise<void> {
  const worker = app.get(OutboxPublisherWorker);
  const log = app.get<StructuredLog>(PUBLISHER_LOG);
  let shuttingDown: Promise<void> | undefined;
  let metricsServer: MetricsServer | undefined;

  const shutdown = (signal: string): Promise<void> => {
    shuttingDown ??= (async () => {
      log.write('info', 'publisher.signal_received', { signal });
      await worker.stop();
      await metricsServer?.stop();
      await app.close();
      log.write('info', 'publisher.exited', { signal });
    })();
    return shuttingDown;
  };

  for (const signal of SIGNALS) {
    process.once(signal, () => {
      void shutdown(signal).then(() => process.exit(0));
    });
  }

  const database = await app.get(DatabaseHealthIndicator).check();
  if (database.status === 'down') {
    log.write('error', 'publisher.database_unavailable', {});
    await app.close();
    throw new Error('PostgreSQL is not reachable');
  }
  const backlog = await app
    .get<OutboxPublicationStore>(OUTBOX_PUBLICATION_STORE)
    .backlog();
  const metricsPort = loadMetricsPort(process.env);
  if (metricsPort !== undefined) {
    metricsServer = serveMetrics(app.get<Metrics>(METRICS), metricsPort);
  }
  log.write('info', 'publisher.ready', {
    pid: process.pid,
    metricsPort: metricsServer?.port,
    pending: backlog.pending,
    deadLettered: backlog.deadLettered,
  });
  await worker.start();
  await shutdown('publisher-finished');
}
