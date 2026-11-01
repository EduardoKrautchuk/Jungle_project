import { SQSClient } from '@aws-sdk/client-sqs';
import { Test } from '@nestjs/testing';
import type { SqsConfig } from '../../../src/infrastructure/config/sqs.config.js';
import {
  SQS_CONFIG,
  WAGER_QUEUE,
} from '../../../src/infrastructure/messaging/messaging.module.js';
import { runWorker } from '../../../src/infrastructure/messaging/run-worker.js';
import { resolveWagerQueueUrls } from '../../../src/infrastructure/messaging/sqs-client.js';
import { SqsWagerQueue } from '../../../src/infrastructure/messaging/sqs-wager-queue.js';
import type {
  DeadLetterDiagnostics,
  QueueMessage,
  WagerQueue,
} from '../../../src/infrastructure/messaging/wager-queue.js';
import { WorkerModule } from '../../../src/worker.module.js';

class CrashBeforeDeleteQueue implements WagerQueue {
  constructor(private readonly inner: WagerQueue) {}

  receive(signal: AbortSignal): Promise<QueueMessage[]> {
    return this.inner.receive(signal);
  }

  acknowledge(): Promise<void> {
    process.stdout.write('COMMITTED\n');
    process.kill(process.pid, 'SIGKILL');
    return new Promise<void>(() => undefined);
  }

  retryLater(message: QueueMessage, delaySeconds: number): Promise<void> {
    return this.inner.retryLater(message, delaySeconds);
  }

  extendVisibility(message: QueueMessage, seconds: number): Promise<void> {
    return this.inner.extendVisibility(message, seconds);
  }

  release(messages: readonly QueueMessage[]): Promise<void> {
    return this.inner.release(messages);
  }

  deadLetter(
    message: QueueMessage,
    diagnostics: DeadLetterDiagnostics,
  ): Promise<void> {
    return this.inner.deadLetter(message, diagnostics);
  }
}

const builder = Test.createTestingModule({
  imports: [WorkerModule.forRoot('test')],
});
if (process.env.CRASH_BEFORE_DELETE === '1') {
  builder.overrideProvider(WAGER_QUEUE).useFactory({
    inject: [SQSClient, SQS_CONFIG],
    factory: async (client: SQSClient, config: SqsConfig) =>
      new CrashBeforeDeleteQueue(
        new SqsWagerQueue(client, await resolveWagerQueueUrls(client, config), {
          waitTimeSeconds: config.waitTimeSeconds,
          maxMessages: config.maxMessages,
          visibilityTimeoutSeconds: config.visibilityTimeoutSeconds,
        }),
      ),
  });
}
const moduleRef = await builder.compile();
moduleRef.useLogger(false);
await moduleRef.init();
process.stdout.write(`READY ${process.pid}\n`);
await runWorker(moduleRef);
process.exit(0);
