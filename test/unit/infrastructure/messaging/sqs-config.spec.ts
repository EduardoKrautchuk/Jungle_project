import { describe, expect, it } from 'bun:test';
import { InvalidConfigurationError } from '../../../../src/infrastructure/config/database.config.js';
import { readFileSync } from 'node:fs';
import { loadDatabaseConfig } from '../../../../src/infrastructure/config/database.config.js';
import { loadOutboxPublisherConfig } from '../../../../src/infrastructure/config/outbox.config.js';
import { loadPendingReferenceConfig } from '../../../../src/infrastructure/config/pending-reference.config.js';
import { loadSqsConfig } from '../../../../src/infrastructure/config/sqs.config.js';
import { loadMetricsPort } from '../../../../src/infrastructure/observability/metrics-server.js';

function envExample(): Record<string, string> {
  const env: Record<string, string> = {};
  const file = new URL('../../../../.env.example', import.meta.url);
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const separator = line.indexOf('=');
    if (separator > 0 && !line.startsWith('#')) {
      env[line.slice(0, separator).trim()] = line.slice(separator + 1).trim();
    }
  }
  return env;
}

describe('configuration defaults', () => {
  it.each([
    ['the built-in defaults', {}],
    ['.env.example', envExample()],
  ])('starts every process with %s', (_, env: Record<string, string>) => {
    const sqs = loadSqsConfig(env);
    expect(() =>
      loadOutboxPublisherConfig(env, sqs.requestTimeoutMs),
    ).not.toThrow();
    expect(() => loadPendingReferenceConfig(env)).not.toThrow();
    expect(() => loadMetricsPort(env)).not.toThrow();
  });

  it('starts the database configuration from .env.example', () => {
    expect(() => loadDatabaseConfig(envExample(), 'test')).not.toThrow();
  });
});

describe('loadSqsConfig', () => {
  it('defaults to the challenge queue names and AWS credential chain', () => {
    const config = loadSqsConfig({});
    expect(config).toMatchObject({
      region: 'us-east-1',
      endpoint: undefined,
      credentials: undefined,
      queueName: 'wager-transactions.fifo',
      deadLetterQueueName: 'wager-transactions-dlq.fifo',
      waitTimeSeconds: 20,
      maxMessages: 10,
      visibilityTimeoutSeconds: 30,
      maxReceiveCount: 5,
      consumerName: 'wager-transactions-consumer',
    });
  });

  it('uses dummy credentials only for a local endpoint', () => {
    expect(
      loadSqsConfig({ SQS_ENDPOINT: 'http://127.0.0.1:54566' }).credentials,
    ).toEqual({ accessKeyId: 'test', secretAccessKey: 'test' });
  });

  it.each([
    [{ SQS_WAGER_QUEUE_NAME: 'standard-queue' }],
    [{ SQS_WAIT_TIME_SECONDS: '21' }],
    [{ SQS_MAX_MESSAGES: '11' }],
    [{ SQS_REQUEST_TIMEOUT_MS: '5000', SQS_WAIT_TIME_SECONDS: '20' }],
    [{ SQS_ENDPOINT: 'not a url' }],
    [{ AWS_ACCESS_KEY_ID: 'only-one' }],
    [{ SQS_RETRY_BASE_SECONDS: '10', SQS_RETRY_MAX_SECONDS: '5' }],
  ])('rejects %p', (env) => {
    expect(() => loadSqsConfig(env)).toThrow(InvalidConfigurationError);
  });
});

describe('event queue and publisher configuration', () => {
  it('defaults the outgoing event queues to distinct FIFO names', () => {
    expect(loadSqsConfig({})).toMatchObject({
      eventsQueueName: 'wager-events.fifo',
      eventsDeadLetterQueueName: 'wager-events-dlq.fifo',
    });
    expect(() =>
      loadSqsConfig({ SQS_EVENTS_QUEUE_NAME: 'wager-transactions.fifo' }),
    ).toThrow(InvalidConfigurationError);
  });

  it('requires a lease longer than two send timeouts', () => {
    expect(loadOutboxPublisherConfig({}, 5_000)).toMatchObject({
      leaseMs: 60_000,
      maxGroups: 10,
      maxPerGroup: 10,
    });
    expect(() =>
      loadOutboxPublisherConfig({ OUTBOX_LEASE_MS: '9000' }, 5_000),
    ).toThrow(InvalidConfigurationError);
    expect(() =>
      loadOutboxPublisherConfig({ OUTBOX_PUBLISHER_ID: 'has space' }, 5_000),
    ).toThrow(InvalidConfigurationError);
  });
});
