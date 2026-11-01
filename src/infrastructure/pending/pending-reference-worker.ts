import type {
  ResolutionOutcome,
  ResolvePendingReference,
} from '../../application/wagering/resolve-pending-reference.js';
import type { PendingReferenceCandidate } from '../../application/ports/persistence.js';
import {
  ConcurrencyConflictError,
  PersistenceUnavailableError,
} from '../../application/ports/persistence.errors.js';
import type {
  LogLevel,
  StructuredLog,
} from '../observability/structured-log.js';

export interface PendingWorkerOptions {
  readonly workerId: string;
  readonly batchSize: number;
  readonly idlePollMs: number;
  readonly errorBackoffMaxMs: number;
  readonly shutdownGraceMs: number;
}

export type PendingWorkerState = 'IDLE' | 'RUNNING' | 'STOPPING' | 'STOPPED';

const LEVEL_BY_RESULT: Readonly<Record<ResolutionOutcome['result'], LogLevel>> =
  {
    PROCESSED: 'info',
    REJECTED: 'warn',
    RESCHEDULED: 'info',
    EXPIRED: 'warn',
    SKIPPED: 'info',
  };

export class PendingReferenceWorker {
  #state: PendingWorkerState = 'IDLE';
  #abort = new AbortController();
  #loop: Promise<void> | undefined;
  #cycles = 0;

  constructor(
    private readonly resolver: ResolvePendingReference,
    private readonly options: PendingWorkerOptions,
    private readonly log: StructuredLog,
  ) {}

  get state(): PendingWorkerState {
    return this.#state;
  }

  get cycles(): number {
    return this.#cycles;
  }

  start(): Promise<void> {
    if (this.#loop !== undefined) {
      return this.#loop;
    }
    this.#state = 'RUNNING';
    this.log.write('info', 'pending_worker.started', {
      workerId: this.options.workerId,
    });
    this.#loop = this.#run();
    return this.#loop;
  }

  async stop(): Promise<void> {
    if (this.#state === 'IDLE') {
      this.#state = 'STOPPED';
      return;
    }
    if (this.#state === 'RUNNING') {
      this.#state = 'STOPPING';
      this.log.write('info', 'pending_worker.stopping', {
        workerId: this.options.workerId,
      });
      this.#abort.abort();
    }
    const graceful = await settleWithin(
      this.#loop ?? Promise.resolve(),
      this.options.shutdownGraceMs,
    );
    this.#state = 'STOPPED';
    this.log.write(graceful ? 'info' : 'warn', 'pending_worker.stopped', {
      workerId: this.options.workerId,
      graceful,
    });
  }

  async #run(): Promise<void> {
    let failures = 0;
    while (this.#state === 'RUNNING') {
      let candidates: PendingReferenceCandidate[];
      try {
        candidates = await this.resolver.listDue(
          this.options.batchSize,
          this.options.workerId,
        );
        failures = 0;
      } catch (error) {
        failures += 1;
        const backoffMs = Math.min(
          this.options.errorBackoffMaxMs,
          this.options.idlePollMs * 2 ** Math.min(failures - 1, 16),
        );
        this.log.write('error', 'pending_worker.cycle_failed', {
          workerId: this.options.workerId,
          errorCode: codeOf(error),
          consecutiveFailures: failures,
          backoffMs,
        });
        await sleep(backoffMs, this.#abort.signal);
        continue;
      }
      this.#cycles += 1;
      let progressed = false;
      for (const candidate of candidates) {
        if (this.#state !== 'RUNNING') {
          break;
        }
        if (await this.#resolve(candidate)) {
          progressed = true;
        }
      }
      if (!progressed) {
        await sleep(this.options.idlePollMs, this.#abort.signal);
      }
    }
  }

  async #resolve(candidate: PendingReferenceCandidate): Promise<boolean> {
    const startedAt = performance.now();
    try {
      const outcome = await this.resolver.resolve(candidate);
      this.log.write(LEVEL_BY_RESULT[outcome.result], 'pending.resolution', {
        workerId: this.options.workerId,
        transactionId: outcome.transactionId,
        walletId: outcome.walletId,
        providerId: outcome.providerId,
        referenceTransactionId: outcome.referenceTransactionId,
        attempt: outcome.attempt,
        nextAttemptAt: outcome.nextAttemptAt?.toISOString(),
        result: outcome.result,
        failureCode: outcome.failureCode,
        skipReason: outcome.skipReason,
        durationMs: Math.round(performance.now() - startedAt),
      });
      return outcome.result !== 'SKIPPED';
    } catch (error) {
      const transient =
        error instanceof ConcurrencyConflictError ||
        error instanceof PersistenceUnavailableError;
      this.log.write(
        transient ? 'warn' : 'error',
        'pending.resolution_failed',
        {
          workerId: this.options.workerId,
          transactionId: candidate.transactionId,
          walletId: candidate.walletId,
          attempt: candidate.referenceAttempts,
          result: transient ? 'TRANSIENT_FAILURE' : 'UNEXPECTED_FAILURE',
          errorCode: codeOf(error),
          durationMs: Math.round(performance.now() - startedAt),
        },
      );
      return false;
    }
  }
}

function codeOf(error: unknown): string {
  if (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof error.code === 'string'
  ) {
    return error.code;
  }
  return error instanceof Error ? error.name : 'UNKNOWN_ERROR';
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(done, ms);
    function done(): void {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    }
    signal.addEventListener('abort', done, { once: true });
  });
}

async function settleWithin(
  work: Promise<void>,
  timeoutMs: number,
): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), timeoutMs);
  });
  const result = await Promise.race([
    work.then(
      () => true,
      () => true,
    ),
    timeout,
  ]);
  clearTimeout(timer);
  return result;
}
