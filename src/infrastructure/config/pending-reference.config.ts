import { hostname } from 'node:os';
import { InvalidConfigurationError } from './database.config.js';

export interface PendingReferenceWorkerConfig {
  readonly workerId: string;
  readonly maxAttempts: number;
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
  readonly batchSize: number;
  readonly idlePollMs: number;
  readonly errorBackoffMaxMs: number;
  readonly shutdownGraceMs: number;
}

type Env = Readonly<Record<string, string | undefined>>;

const INTEGER_PATTERN = /^\d+$/;
const WORKER_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

export function loadPendingReferenceConfig(
  env: Env,
): PendingReferenceWorkerConfig {
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

  const workerId =
    env.PENDING_WORKER_ID?.trim() ||
    `${hostname()
      .replace(/[^A-Za-z0-9._-]/g, '-')
      .slice(0, 64)}:${process.pid}`;
  if (!WORKER_ID_PATTERN.test(workerId)) {
    problems.push(
      'PENDING_WORKER_ID must be 1 to 128 letters, digits, ".", "_", ":" or "-"',
    );
  }
  const baseDelayMs = integer(
    'PENDING_REFERENCE_BASE_DELAY_MS',
    1_000,
    10,
    3_600_000,
  );
  const maxDelayMs = integer(
    'PENDING_REFERENCE_MAX_DELAY_MS',
    300_000,
    10,
    86_400_000,
  );
  if (baseDelayMs > maxDelayMs) {
    problems.push(
      'PENDING_REFERENCE_BASE_DELAY_MS must not exceed PENDING_REFERENCE_MAX_DELAY_MS',
    );
  }
  const config: PendingReferenceWorkerConfig = {
    workerId,
    maxAttempts: integer('PENDING_REFERENCE_MAX_ATTEMPTS', 12, 1, 1_000),
    baseDelayMs,
    maxDelayMs,
    batchSize: integer('PENDING_WORKER_BATCH_SIZE', 20, 1, 500),
    idlePollMs: integer('PENDING_WORKER_IDLE_POLL_MS', 1_000, 20, 60_000),
    errorBackoffMaxMs: integer(
      'PENDING_WORKER_ERROR_BACKOFF_MAX_MS',
      30_000,
      50,
      300_000,
    ),
    shutdownGraceMs: integer(
      'PENDING_WORKER_SHUTDOWN_GRACE_MS',
      20_000,
      0,
      600_000,
    ),
  };
  if (problems.length > 0) {
    throw new InvalidConfigurationError(problems, 'pending reference worker');
  }
  return config;
}
