import type { INestApplicationContext } from '@nestjs/common';
import type { StructuredLog } from '../observability/structured-log.js';
import { DatabaseHealthIndicator } from '../persistence/database-health.indicator.js';
import { CONSUMER_LOG } from './messaging.module.js';
import { SqsWagerConsumer } from './sqs-wager-consumer.js';

const SIGNALS = ['SIGTERM', 'SIGINT'] as const;

export async function runWorker(app: INestApplicationContext): Promise<void> {
  const consumer = app.get(SqsWagerConsumer);
  const log = app.get<StructuredLog>(CONSUMER_LOG);
  let shuttingDown: Promise<void> | undefined;

  const shutdown = (signal: string): Promise<void> => {
    shuttingDown ??= (async () => {
      log.write('info', 'worker.signal_received', { signal });
      await consumer.stop();
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
  log.write('info', 'worker.ready', { pid: process.pid });
  await consumer.start();
  await shutdown('consumer-finished');
}
