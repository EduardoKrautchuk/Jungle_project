import { InvalidConfigurationError } from './database.config.js';

export interface SqsCredentials {
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
}

export interface SqsConfig {
  readonly region: string;
  readonly endpoint: string | undefined;
  readonly credentials: SqsCredentials | undefined;
  readonly queueName: string;
  readonly deadLetterQueueName: string;
  readonly queueUrl: string | undefined;
  readonly deadLetterQueueUrl: string | undefined;
  readonly requestTimeoutMs: number;
  readonly waitTimeSeconds: number;
  readonly maxMessages: number;
  readonly visibilityTimeoutSeconds: number;
  readonly maxReceiveCount: number;
  readonly retryBaseSeconds: number;
  readonly retryMaxSeconds: number;
  readonly shutdownGraceMs: number;
  readonly consumerName: string;
}

type Env = Readonly<Record<string, string | undefined>>;

const LOCAL_CREDENTIALS: SqsCredentials = {
  accessKeyId: 'test',
  secretAccessKey: 'test',
};
const FIFO_QUEUE_NAME = /^[A-Za-z0-9_-]{1,75}\.fifo$/;
const INTEGER_PATTERN = /^\d+$/;
const MAX_VISIBILITY_TIMEOUT_SECONDS = 43_200;

export function loadSqsConfig(env: Env): SqsConfig {
  const problems: string[] = [];

  const text = (key: string, fallback: string): string =>
    env[key]?.trim() || fallback;

  const optional = (key: string): string | undefined =>
    env[key]?.trim() || undefined;

  const integer = (
    key: string,
    fallback: number,
    min: number,
    max: number,
  ): number => {
    const raw = env[key]?.trim();
    if (!raw) {
      return fallback;
    }
    const value = INTEGER_PATTERN.test(raw) ? Number(raw) : Number.NaN;
    if (!Number.isSafeInteger(value) || value < min || value > max) {
      problems.push(`${key} must be an integer between ${min} and ${max}`);
      return fallback;
    }
    return value;
  };

  const endpoint = optional('SQS_ENDPOINT');
  if (endpoint !== undefined && !URL.canParse(endpoint)) {
    problems.push('SQS_ENDPOINT must be a valid URL');
  }
  const accessKeyId = optional('AWS_ACCESS_KEY_ID');
  const secretAccessKey = optional('AWS_SECRET_ACCESS_KEY');
  if ((accessKeyId === undefined) !== (secretAccessKey === undefined)) {
    problems.push(
      'AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY must be set together',
    );
  }
  const explicitCredentials =
    accessKeyId !== undefined && secretAccessKey !== undefined
      ? { accessKeyId, secretAccessKey }
      : undefined;

  const queueName = text('SQS_WAGER_QUEUE_NAME', 'wager-transactions.fifo');
  const deadLetterQueueName = text(
    'SQS_WAGER_DLQ_NAME',
    'wager-transactions-dlq.fifo',
  );
  for (const [key, name] of [
    ['SQS_WAGER_QUEUE_NAME', queueName],
    ['SQS_WAGER_DLQ_NAME', deadLetterQueueName],
  ] as const) {
    if (!FIFO_QUEUE_NAME.test(name)) {
      problems.push(`${key} must be a FIFO queue name ending in ".fifo"`);
    }
  }

  const waitTimeSeconds = integer('SQS_WAIT_TIME_SECONDS', 20, 1, 20);
  const requestTimeoutMs = integer(
    'SQS_REQUEST_TIMEOUT_MS',
    25_000,
    1_000,
    120_000,
  );
  if (requestTimeoutMs <= waitTimeSeconds * 1_000) {
    problems.push(
      'SQS_REQUEST_TIMEOUT_MS must be greater than SQS_WAIT_TIME_SECONDS',
    );
  }
  const retryBaseSeconds = integer('SQS_RETRY_BASE_SECONDS', 2, 0, 900);
  const retryMaxSeconds = integer(
    'SQS_RETRY_MAX_SECONDS',
    300,
    0,
    MAX_VISIBILITY_TIMEOUT_SECONDS,
  );
  if (retryBaseSeconds > retryMaxSeconds) {
    problems.push(
      'SQS_RETRY_BASE_SECONDS must not exceed SQS_RETRY_MAX_SECONDS',
    );
  }

  const config: SqsConfig = {
    region: text('AWS_REGION', 'us-east-1'),
    endpoint,
    credentials:
      explicitCredentials ??
      (endpoint === undefined ? undefined : LOCAL_CREDENTIALS),
    queueName,
    deadLetterQueueName,
    queueUrl: optional('SQS_WAGER_QUEUE_URL'),
    deadLetterQueueUrl: optional('SQS_WAGER_DLQ_URL'),
    requestTimeoutMs,
    waitTimeSeconds,
    maxMessages: integer('SQS_MAX_MESSAGES', 10, 1, 10),
    visibilityTimeoutSeconds: integer(
      'SQS_VISIBILITY_TIMEOUT_SECONDS',
      30,
      1,
      MAX_VISIBILITY_TIMEOUT_SECONDS,
    ),
    maxReceiveCount: integer('SQS_MAX_RECEIVE_COUNT', 5, 1, 1_000),
    retryBaseSeconds,
    retryMaxSeconds,
    shutdownGraceMs: integer('SQS_SHUTDOWN_GRACE_MS', 25_000, 0, 600_000),
    consumerName: text('WAGER_CONSUMER_NAME', 'wager-transactions-consumer'),
  };

  if (problems.length > 0) {
    throw new InvalidConfigurationError(problems, 'SQS');
  }
  return config;
}
