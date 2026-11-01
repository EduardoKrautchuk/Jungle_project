import { GetQueueAttributesCommand } from '@aws-sdk/client-sqs';
import { loadSqsConfig } from '../config/sqs.config.js';
import {
  createSqsClient,
  resolveEventsQueueUrl,
  resolveWagerQueueUrls,
} from './sqs-client.js';
import {
  ensureEventQueues,
  ensureWagerQueues,
} from './sqs-queue-provisioner.js';

const COMMANDS = ['init', 'check'] as const;
type Command = (typeof COMMANDS)[number];

function isCommand(value: string | undefined): value is Command {
  return COMMANDS.some((command) => command === value);
}

const [command] = process.argv.slice(2);
if (!isCommand(command)) {
  console.error(
    'Usage: bun src/infrastructure/messaging/sqs-admin.ts <init|check>',
  );
  process.exit(1);
}

const config = loadSqsConfig(process.env);
const client = createSqsClient(config);

try {
  const urls =
    command === 'init'
      ? await ensureWagerQueues(client, config)
      : await resolveWagerQueueUrls(client, config);
  const eventsUrls =
    command === 'init'
      ? await ensureEventQueues(client, {
          ...config,
          queueName: config.eventsQueueName,
          deadLetterQueueName: config.eventsDeadLetterQueueName,
        })
      : {
          queueUrl: await resolveEventsQueueUrl(client, config),
          deadLetterQueueUrl: (
            await resolveWagerQueueUrls(client, {
              ...config,
              queueUrl: undefined,
              deadLetterQueueUrl: undefined,
              queueName: config.eventsQueueName,
              deadLetterQueueName: config.eventsDeadLetterQueueName,
            })
          ).deadLetterQueueUrl,
        };
  for (const [label, url] of [
    ['queue', urls.queueUrl],
    ['dead-letter queue', urls.deadLetterQueueUrl],
    ['events queue', eventsUrls.queueUrl],
    ['events dead-letter queue', eventsUrls.deadLetterQueueUrl],
  ] as const) {
    const { Attributes } = await client.send(
      new GetQueueAttributesCommand({
        QueueUrl: url,
        AttributeNames: [
          'ApproximateNumberOfMessages',
          'ApproximateNumberOfMessagesNotVisible',
          'RedrivePolicy',
        ],
      }),
    );
    console.log(
      JSON.stringify({
        queue: label,
        url,
        visible: Attributes?.ApproximateNumberOfMessages,
        inFlight: Attributes?.ApproximateNumberOfMessagesNotVisible,
        redrivePolicy: Attributes?.RedrivePolicy,
      }),
    );
  }
} catch (error) {
  console.error(
    `SQS ${command} failed: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = 1;
} finally {
  client.destroy();
}
