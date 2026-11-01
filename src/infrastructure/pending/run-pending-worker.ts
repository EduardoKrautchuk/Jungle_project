import type { INestApplicationContext } from '@nestjs/common';
import type { StructuredLog } from '../observability/structured-log.js';
import { DatabaseHealthIndicator } from '../persistence/database-health.indicator.js';
import { PENDING_WORKER_LOG } from './pending-reference.module.js';
import { PendingReferenceWorker } from './pending-reference-worker.js';

const SIGNALS = ['SIGTERM', 'SIGINT'] as const;

export async function runPendingWorker(
  app: INestApplicationContext,
): Promise<void> {
  const worker = app.get(PendingReferenceWorker);
  const log = app.get<StructuredLog>(PENDING_WORKER_LOG);
  let shuttingDown: Promise<void> | undefined;

  const shutdown = (signal: string): Promise<void> => {
    shuttingDown ??= (async () => {
      log.write('info', 'pending_worker.signal_received', { signal });
      await worker.stop();
      await app.close();
      log.write('info', 'pending_worker.exited', { signal });
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
    log.write('error', 'pending_worker.database_unavailable', {});
    await app.close();
    throw new Error('PostgreSQL is not reachable');
  }
  log.write('info', 'pending_worker.ready', { pid: process.pid });
  await worker.start();
  await shutdown('worker-finished');
}
