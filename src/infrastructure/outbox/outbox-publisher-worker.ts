import type {
  BatchReport,
  PublicationOutcome,
  PublishOutboxBatch,
} from '../../application/outbox/publish-outbox-batch.js';
import type {
  LogLevel,
  StructuredLog,
} from '../observability/structured-log.js';

export interface PublisherWorkerOptions {
  readonly publisherId: string;
  readonly idlePollMs: number;
  readonly errorBackoffMaxMs: number;
  readonly shutdownGraceMs: number;
}

export type PublisherState = 'IDLE' | 'RUNNING' | 'STOPPING' | 'STOPPED';

const EVENT_BY_RESULT: Readonly<
  Record<PublicationOutcome['result'], [LogLevel, string]>
> = {
  PUBLISHED: ['info', 'outbox.published'],
  RETRY_SCHEDULED: ['warn', 'outbox.retry_scheduled'],
  DEAD_LETTERED: ['error', 'outbox.dead_lettered'],
  LEASE_LOST: ['warn', 'outbox.lease_lost'],
  CONFIRMATION_FAILED: ['error', 'outbox.confirmation_failed'],
  STATE_NOT_RECORDED: ['error', 'outbox.state_not_recorded'],
  DEFERRED: ['warn', 'outbox.deferred'],
};

export class OutboxPublisherWorker {
  #state: PublisherState = 'IDLE';
  #abort = new AbortController();
  #loop: Promise<void> | undefined;
  #cycles = 0;

  constructor(
    private readonly batch: PublishOutboxBatch,
    private readonly options: PublisherWorkerOptions,
    private readonly log: StructuredLog,
  ) {}

  get state(): PublisherState {
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
    this.log.write('info', 'publisher.started', {
      publisherId: this.options.publisherId,
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
      this.log.write('info', 'publisher.stopping', {
        publisherId: this.options.publisherId,
      });
      this.#abort.abort();
    }
    const graceful = await settleWithin(
      this.#loop ?? Promise.resolve(),
      this.options.shutdownGraceMs,
    );
    this.#state = 'STOPPED';
    this.log.write(graceful ? 'info' : 'warn', 'publisher.stopped', {
      publisherId: this.options.publisherId,
      graceful,
    });
  }

  async #run(): Promise<void> {
    let failures = 0;
    while (this.#state === 'RUNNING') {
      let report: BatchReport;
      try {
        report = await this.batch.run();
        failures = 0;
      } catch (error) {
        failures += 1;
        const backoffMs = Math.min(
          this.options.errorBackoffMaxMs,
          this.options.idlePollMs * 2 ** Math.min(failures - 1, 16),
        );
        this.log.write('error', 'publisher.cycle_failed', {
          publisherId: this.options.publisherId,
          errorCode: codeOf(error),
          consecutiveFailures: failures,
          backoffMs,
        });
        await sleep(backoffMs, this.#abort.signal);
        continue;
      }
      this.#cycles += 1;
      this.#report(report);
      if (report.claimed === 0) {
        await sleep(this.options.idlePollMs, this.#abort.signal);
      }
    }
  }

  #report(report: BatchReport): void {
    if (report.claimed === 0) {
      return;
    }
    this.log.write('info', 'outbox.claimed', {
      publisherId: this.options.publisherId,
      claimToken: report.token,
      claimed: report.claimed,
      groups: report.groups,
    });
    for (const outcome of report.outcomes) {
      if (outcome.recoveredFrom !== undefined) {
        this.log.write('warn', 'outbox.lease_recovered', {
          publisherId: this.options.publisherId,
          eventId: outcome.eventId,
          previousOwner: outcome.recoveredFrom,
        });
      }
      const [level, event] = EVENT_BY_RESULT[outcome.result];
      this.log.write(level, event, {
        publisherId: this.options.publisherId,
        eventId: outcome.eventId,
        eventType: outcome.eventType,
        aggregateId: outcome.aggregateId,
        groupKey: outcome.groupKey,
        correlationId: outcome.correlationId,
        attempt: outcome.attempt,
        result: outcome.result,
        errorCode: outcome.errorCode,
        failureKind: outcome.failureKind,
        transportMessageId: outcome.transportMessageId,
        retryInMs: outcome.retryInMs,
        durationMs: outcome.durationMs,
      });
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
