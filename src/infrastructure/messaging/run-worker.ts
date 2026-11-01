import type { INestApplicationContext } from '@nestjs/common';
import type { Metrics } from '../observability/metrics.js';
import {
  loadMetricsPort,
  serveMetrics,
  type MetricsServer,
} from '../observability/metrics-server.js';
import { METRICS } from '../observability/observability.module.js';
import type { StructuredLog } from '../observability/structured-log.js';
import { DatabaseHealthIndicator } from '../persistence/database-health.indicator.js';
import { CONSUMER_LOG } from './messaging.module.js';
import { SqsWagerConsumer } from './sqs-wager-consumer.js';

const SIGNALS = ['SIGTERM', 'SIGINT'] as const;

export async function runWorker(app: INestApplicationContext): Promise<void> {
  const consumer = app.get(SqsWagerConsumer);
  const log = app.get<StructuredLog>(CONSUMER_LOG);
  let shuttingDown: Promise<void> | undefined;
  let metricsServer: MetricsServer | undefined;

  const shutdown = (signal: string): Promise<void> => {
    shuttingDown ??= (async () => {
      log.write('info', 'worker.signal_received', { signal });
      await consumer.stop();
      await metricsServer?.stop();
      await app.close();
      log.write('info', 'worker.exited', { signal });
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
    log.write('error', 'worker.database_unavailable', {});
    await app.close();
    throw new Error('PostgreSQL is not reachable');
  }
  const metricsPort = loadMetricsPort(process.env);
  if (metricsPort !== undefined) {
    metricsServer = serveMetrics(app.get<Metrics>(METRICS), metricsPort);
  }
  log.write('info', 'worker.ready', {
    pid: process.pid,
    metricsPort: metricsServer?.port,
  });
  await consumer.start();
  await shutdown('consumer-finished');
}
