import { NestFactory } from '@nestjs/core';
import { runWorker } from './infrastructure/messaging/run-worker.js';
import { WorkerModule } from './worker.module.js';

const app = await NestFactory.createApplicationContext(WorkerModule.forRoot(), {
  bufferLogs: false,
});
await runWorker(app);
