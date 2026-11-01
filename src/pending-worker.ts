import { NestFactory } from '@nestjs/core';
import { runPendingWorker } from './infrastructure/pending/run-pending-worker.js';
import { PendingWorkerAppModule } from './pending-worker.module.js';

const app = await NestFactory.createApplicationContext(
  PendingWorkerAppModule.forRoot(),
);
await runPendingWorker(app);
