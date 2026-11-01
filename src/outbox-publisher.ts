import { NestFactory } from '@nestjs/core';
import { runPublisher } from './infrastructure/outbox/run-publisher.js';
import { OutboxPublisherAppModule } from './outbox-publisher.module.js';

const app = await NestFactory.createApplicationContext(
  OutboxPublisherAppModule.forRoot(),
);
await runPublisher(app);
