import { hostname } from 'node:os';
import { InvalidConfigurationError } from './database.config.js';

export interface OutboxPublisherConfig {
  readonly publisherId: string;
  readonly leaseMs: number;
  readonly maxGroups: number;
  readonly maxPerGroup: number;
  readonly idlePollMs: number;
  readonly errorBackoffMaxMs: number;
  readonly shutdownGraceMs: number;
}

type Env = Readonly<Record<string, string | undefined>>;

const INTEGER_PATTERN = /^\d+$/;
const PUBLISHER_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

export function loadOutboxPublisherConfig(
  env: Env,
  sendTimeoutMs: number,
): OutboxPublisherConfig {
  const problems: string[] = [];
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

  const publisherId =
    env.OUTBOX_PUBLISHER_ID?.trim() ||
    `${hostname()
      .replace(/[^A-Za-z0-9._-]/g, '-')
      .slice(0, 64)}:${process.pid}`;
  if (!PUBLISHER_ID_PATTERN.test(publisherId)) {
    problems.push(
      'OUTBOX_PUBLISHER_ID must be 1 to 128 letters, digits, ".", "_", ":" or "-"',
    );
  }
  const leaseMs = integer('OUTBOX_LEASE_MS', 30_000, 1_000, 600_000);
  if (leaseMs <= sendTimeoutMs * 2) {
    problems.push(
      'OUTBOX_LEASE_MS must be greater than twice SQS_REQUEST_TIMEOUT_MS',
    );
  }

  const config: OutboxPublisherConfig = {
    publisherId,
    leaseMs,
    maxGroups: integer('OUTBOX_MAX_GROUPS', 10, 1, 100),
    maxPerGroup: integer('OUTBOX_MAX_PER_GROUP', 10, 1, 100),
    idlePollMs: integer('OUTBOX_IDLE_POLL_MS', 1_000, 50, 60_000),
    errorBackoffMaxMs: integer(
      'OUTBOX_ERROR_BACKOFF_MAX_MS',
      30_000,
      100,
      300_000,
    ),
    shutdownGraceMs: integer('OUTBOX_SHUTDOWN_GRACE_MS', 20_000, 0, 600_000),
  };
  if (problems.length > 0) {
    throw new InvalidConfigurationError(problems, 'outbox publisher');
  }
  return config;
}
