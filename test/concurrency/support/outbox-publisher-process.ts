import type { SQSClient } from '@aws-sdk/client-sqs';
import { Test } from '@nestjs/testing';
import {
  EVENT_TRANSPORT,
  type EventTransport,
  type OutgoingEvent,
} from '../../../src/application/ports/outbox-publication.js';
import { SqsEventTransport } from '../../../src/infrastructure/messaging/sqs-event-transport.js';
import {
  EVENTS_QUEUE_URL,
  PUBLISHER_SQS_CLIENT,
} from '../../../src/infrastructure/outbox/outbox-publisher.module.js';
import { runPublisher } from '../../../src/infrastructure/outbox/run-publisher.js';
import { OutboxPublisherAppModule } from '../../../src/outbox-publisher.module.js';

const crashPoint = process.env.CRASH_POINT;

class CrashingTransport implements EventTransport {
  constructor(private readonly inner: EventTransport) {}

  async publish(
    event: OutgoingEvent,
  ): Promise<{ readonly transportMessageId: string }> {
    if (crashPoint === 'before-send') {
      process.stdout.write(`CRASHING before-send ${event.eventId}\n`);
      process.kill(process.pid, 'SIGKILL');
    }
    const result = await this.inner.publish(event);
    if (crashPoint === 'after-send') {
      process.stdout.write(`CRASHING after-send ${event.eventId}\n`);
      process.kill(process.pid, 'SIGKILL');
    }
    return result;
  }
}

const builder = Test.createTestingModule({
  imports: [OutboxPublisherAppModule.forRoot('test')],
});
if (crashPoint !== undefined) {
  builder.overrideProvider(EVENT_TRANSPORT).useFactory({
    inject: [PUBLISHER_SQS_CLIENT, EVENTS_QUEUE_URL],
    factory: (client: SQSClient, url: string) =>
      new CrashingTransport(new SqsEventTransport(client, url)),
  });
}
const moduleRef = await builder.compile();
moduleRef.useLogger(false);
await moduleRef.init();
process.stdout.write(`READY ${process.pid}\n`);
await runPublisher(moduleRef);
process.exit(0);
