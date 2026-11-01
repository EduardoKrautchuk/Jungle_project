import type { StructuredLog } from '../observability/structured-log.js';
import type {
  ProcessingOutcome,
  WagerMessageProcessor,
} from './wager-message-processor.js';
import type { QueueMessage, WagerQueue } from './wager-queue.js';
import { settleWithin, sleep } from '../runtime/worker-loop.js';

export interface ConsumerOptions {
  readonly consumerName: string;
  readonly visibilityTimeoutSeconds: number;
  readonly maxReceiveCount: number;
  readonly retryBaseSeconds: number;
  readonly retryMaxSeconds: number;
  readonly shutdownGraceMs: number;
  readonly receiveFailureBackoffMs?: number;
  readonly receiveFailureBackoffMaxMs?: number;
}

export type ConsumerState = 'IDLE' | 'RUNNING' | 'STOPPING' | 'STOPPED';

const DEFAULT_RECEIVE_BACKOFF_MS = 1_000;
const DEFAULT_RECEIVE_BACKOFF_MAX_MS = 30_000;

export class SqsWagerConsumer {
  #state: ConsumerState = 'IDLE';
  #abort = new AbortController();
  #loop: Promise<void> | undefined;
  #inFlight = new Set<Promise<void>>();

  constructor(
    private readonly queue: WagerQueue,
    private readonly processor: WagerMessageProcessor,
    private readonly options: ConsumerOptions,
    private readonly log: StructuredLog,
  ) {}

  get state(): ConsumerState {
    return this.#state;
  }

  get inFlight(): number {
    return this.#inFlight.size;
  }

  start(): Promise<void> {
    if (this.#loop !== undefined) {
      return this.#loop;
    }
    this.#state = 'RUNNING';
    this.log.write('info', 'consumer.started', {
      consumerName: this.options.consumerName,
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
      this.log.write('info', 'consumer.stopping', {
        consumerName: this.options.consumerName,
        inFlight: this.#inFlight.size,
      });
      this.#abort.abort();
    }
    const finished = await settleWithin(
      this.#loop ?? Promise.resolve(),
      this.options.shutdownGraceMs,
    );
    this.#state = 'STOPPED';
    this.log.write(finished ? 'info' : 'warn', 'consumer.stopped', {
      consumerName: this.options.consumerName,
      graceful: finished,
      inFlight: this.#inFlight.size,
    });
  }

  async #run(): Promise<void> {
    let failures = 0;
    while (this.#state === 'RUNNING') {
      let messages: QueueMessage[];
      try {
        messages = await this.queue.receive(this.#abort.signal);
        failures = 0;
      } catch (error) {
        if (this.#state !== 'RUNNING') {
          break;
        }
        failures += 1;
        const backoffMs = this.#receiveBackoff(failures);
        this.log.write('error', 'consumer.receive_failed', {
          consumerName: this.options.consumerName,
          errorCode: errorCodeOf(error),
          consecutiveFailures: failures,
          backoffMs,
        });
        await sleep(backoffMs, this.#abort.signal);
        continue;
      }
      if (this.#state !== 'RUNNING') {
        await this.#releaseUnstarted(messages);
        break;
      }
      const batch = Promise.all(
        groupsOf(messages).map((group) => this.#processGroup(group)),
      ).then(() => undefined);
      this.#inFlight.add(batch);
      try {
        await batch;
      } finally {
        this.#inFlight.delete(batch);
      }
    }
  }

  async #processGroup(group: readonly QueueMessage[]): Promise<void> {
    for (const [index, message] of group.entries()) {
      if (this.#state !== 'RUNNING' && index > 0) {
        await this.#releaseUnstarted(group.slice(index));
        return;
      }
      const outcome = await this.#handle(message);
      if (outcome.action === 'RETRY') {
        await this.#releaseUnstarted(group.slice(index + 1));
        return;
      }
    }
  }

  async #handle(message: QueueMessage): Promise<ProcessingOutcome> {
    const startedAt = performance.now();
    const outcome = await this.#withHeartbeat(message, () =>
      this.processor.process(message),
    );
    const base = {
      consumerName: this.options.consumerName,
      sqsMessageId: message.sqsMessageId,
      messageId: outcome.context.messageId,
      correlationId: outcome.context.correlationId,
      kind: outcome.context.kind,
      providerId: outcome.context.providerId,
      walletId: outcome.context.walletId,
      receiveCount: message.receiveCount,
    };

    if (outcome.action === 'ACKNOWLEDGE') {
      const acknowledged = await this.#tryAcknowledge(message, base);
      this.log.write('info', 'message.processed', {
        ...base,
        result: outcome.result,
        transactionId: outcome.transactionId,
        failureCode: outcome.failureCode,
        acknowledged,
        durationMs: elapsed(startedAt),
      });
      return outcome;
    }

    if (
      outcome.action === 'DEAD_LETTER' ||
      message.receiveCount >= this.options.maxReceiveCount
    ) {
      const deadLettered = await this.#tryDeadLetter(message, outcome);
      this.log.write('error', 'message.dead_lettered', {
        ...base,
        result: deadLettered ? 'DEAD_LETTERED' : 'DEAD_LETTER_FAILED',
        errorCode: outcome.errorCode,
        errorName: outcome.errorName,
        attemptsExhausted: outcome.action === 'RETRY',
        durationMs: elapsed(startedAt),
      });
      return outcome;
    }

    const delaySeconds = this.#retryDelay(message.receiveCount);
    let rescheduled = true;
    try {
      await this.queue.retryLater(message, delaySeconds);
    } catch (error) {
      rescheduled = false;
      this.log.write('warn', 'message.retry_schedule_failed', {
        ...base,
        errorCode: errorCodeOf(error),
      });
    }
    this.log.write('warn', 'message.retry_scheduled', {
      ...base,
      result: 'RETRY',
      errorCode: outcome.errorCode,
      errorName: outcome.errorName,
      retryInSeconds: rescheduled ? delaySeconds : undefined,
      durationMs: elapsed(startedAt),
    });
    return outcome;
  }

  async #withHeartbeat<T>(
    message: QueueMessage,
    work: () => Promise<T>,
  ): Promise<T> {
    const seconds = this.options.visibilityTimeoutSeconds;
    const timer = setInterval(
      () => {
        this.queue
          .extendVisibility(message, seconds)
          .catch((error: unknown) => {
            this.log.write('warn', 'message.visibility_extension_failed', {
              consumerName: this.options.consumerName,
              sqsMessageId: message.sqsMessageId,
              errorCode: errorCodeOf(error),
            });
          });
      },
      Math.max(500, (seconds * 1_000) / 2),
    );
    try {
      return await work();
    } finally {
      clearInterval(timer);
    }
  }

  async #tryAcknowledge(
    message: QueueMessage,
    fields: Readonly<Record<string, string | number | undefined>>,
  ): Promise<boolean> {
    try {
      await this.queue.acknowledge(message);
      return true;
    } catch (error) {
      this.log.write('warn', 'message.acknowledge_failed', {
        ...fields,
        errorCode: errorCodeOf(error),
      });
      return false;
    }
  }

  async #tryDeadLetter(
    message: QueueMessage,
    outcome: Extract<ProcessingOutcome, { errorCode: string }>,
  ): Promise<boolean> {
    try {
      await this.queue.deadLetter(message, {
        errorCode: outcome.errorCode,
        consumerName: this.options.consumerName,
        logicalMessageId: outcome.context.messageId,
      });
      return true;
    } catch {
      return false;
    }
  }

  async #releaseUnstarted(messages: readonly QueueMessage[]): Promise<void> {
    if (messages.length === 0) {
      return;
    }
    try {
      await this.queue.release(messages);
      this.log.write('info', 'message.released', {
        consumerName: this.options.consumerName,
        count: messages.length,
      });
    } catch (error) {
      this.log.write('warn', 'message.release_failed', {
        consumerName: this.options.consumerName,
        count: messages.length,
        errorCode: errorCodeOf(error),
      });
    }
  }

  #retryDelay(receiveCount: number): number {
    const exponent = Math.max(0, receiveCount - 1);
    return Math.min(
      this.options.retryMaxSeconds,
      this.options.retryBaseSeconds * 2 ** exponent,
    );
  }

  #receiveBackoff(failures: number): number {
    const base =
      this.options.receiveFailureBackoffMs ?? DEFAULT_RECEIVE_BACKOFF_MS;
    const max =
      this.options.receiveFailureBackoffMaxMs ?? DEFAULT_RECEIVE_BACKOFF_MAX_MS;
    return Math.min(max, base * 2 ** Math.max(0, failures - 1));
  }
}

function groupsOf(messages: readonly QueueMessage[]): QueueMessage[][] {
  const groups = new Map<string, QueueMessage[]>();
  for (const message of messages) {
    const key = message.groupId ?? message.sqsMessageId;
    const group = groups.get(key);
    if (group === undefined) {
      groups.set(key, [message]);
    } else {
      group.push(message);
    }
  }
  return [...groups.values()];
}

function errorCodeOf(error: unknown): string {
  if (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof error.code === 'string'
  ) {
    return error.code;
  }
  return error instanceof Error ? error.name : 'UNKNOWN';
}

function elapsed(startedAt: number): number {
  return Math.round(performance.now() - startedAt);
}
