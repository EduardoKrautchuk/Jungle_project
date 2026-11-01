import type {
  ClaimedOutboxMessage,
  EventTransport,
  OutboxPublicationStore,
} from '../ports/outbox-publication.js';
import { EventTransportError } from '../ports/outbox-publication.js';
import type { Clock, IdGenerator } from '../ports/runtime.js';
import { InvalidOutboxEventError, toOutgoingEvent } from './outgoing-event.js';

export type PublicationResult =
  | 'PUBLISHED'
  | 'RETRY_SCHEDULED'
  | 'DEAD_LETTERED'
  | 'LEASE_LOST'
  | 'CONFIRMATION_FAILED'
  | 'STATE_NOT_RECORDED'
  | 'DEFERRED';

export interface PublicationOutcome {
  readonly eventId: string;
  readonly eventType: string;
  readonly aggregateId: string;
  readonly groupKey: string;
  readonly correlationId: string | undefined;
  readonly attempt: number;
  readonly result: PublicationResult;
  readonly errorCode: string | undefined;
  readonly failureKind: string | undefined;
  readonly transportMessageId: string | undefined;
  readonly retryInMs: number | undefined;
  readonly recoveredFrom: string | undefined;
  readonly durationMs: number;
}

export interface BatchReport {
  readonly token: string;
  readonly claimed: number;
  readonly groups: number;
  readonly outcomes: readonly PublicationOutcome[];
}

export interface PublishOutboxBatchOptions {
  readonly owner: string;
  readonly leaseMs: number;
  readonly maxGroups: number;
  readonly maxPerGroup: number;
  readonly sendBudgetMs: number;
}

const TERMINAL_FOR_GROUP: ReadonlySet<PublicationResult> = new Set([
  'PUBLISHED',
  'DEAD_LETTERED',
]);

export class PublishOutboxBatch {
  constructor(
    private readonly store: OutboxPublicationStore,
    private readonly transport: EventTransport,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
    private readonly options: PublishOutboxBatchOptions,
    private readonly random: () => number = Math.random,
  ) {}

  async run(): Promise<BatchReport> {
    const token = this.ids.next();
    const claim = await this.store.claim({
      owner: this.options.owner,
      token,
      leaseMs: this.options.leaseMs,
      maxGroups: this.options.maxGroups,
      maxPerGroup: this.options.maxPerGroup,
    });
    const leaseDeadline =
      performance.now() + this.options.leaseMs - this.options.sendBudgetMs;
    const perGroup = await Promise.all(
      claim.groups.map((group) =>
        this.#publishGroup(group, token, leaseDeadline),
      ),
    );
    return {
      token,
      claimed: claim.groups.reduce((sum, group) => sum + group.length, 0),
      groups: claim.groups.length,
      outcomes: perGroup.flat(),
    };
  }

  async #publishGroup(
    group: readonly ClaimedOutboxMessage[],
    token: string,
    leaseDeadline: number,
  ): Promise<PublicationOutcome[]> {
    const outcomes: PublicationOutcome[] = [];
    for (const [index, claimed] of group.entries()) {
      if (performance.now() >= leaseDeadline) {
        await this.#releaseQuietly(group.slice(index), token);
        outcomes.push(
          outcome(claimed, 'DEFERRED', performance.now(), {
            errorCode: 'LEASE_BUDGET_EXHAUSTED',
          }),
        );
        break;
      }
      const result = await this.#publishOne(claimed, token);
      outcomes.push(result);
      if (!TERMINAL_FOR_GROUP.has(result.result)) {
        await this.#releaseQuietly(group.slice(index + 1), token);
        break;
      }
    }
    return outcomes;
  }

  async #publishOne(
    claimed: ClaimedOutboxMessage,
    token: string,
  ): Promise<PublicationOutcome> {
    const startedAt = performance.now();
    const { message } = claimed;
    let event;
    try {
      event = toOutgoingEvent(claimed);
    } catch (error) {
      if (error instanceof InvalidOutboxEventError) {
        return this.#deadLetter(
          claimed,
          token,
          error.code,
          'INVALID_EVENT',
          startedAt,
        );
      }
      throw error;
    }

    let transportMessageId: string;
    try {
      ({ transportMessageId } = await this.transport.publish(event));
    } catch (error) {
      const failure =
        error instanceof EventTransportError
          ? error
          : new EventTransportError('TRANSIENT', errorName(error), {
              cause: error,
            });
      if (failure.kind === 'REJECTED') {
        return this.#deadLetter(
          claimed,
          token,
          failure.code,
          failure.kind,
          startedAt,
        );
      }
      return this.#reschedule(claimed, token, failure, startedAt);
    }

    try {
      const confirmed = await this.store.confirm(
        message.id,
        token,
        transportMessageId,
      );
      return outcome(
        claimed,
        confirmed ? 'PUBLISHED' : 'LEASE_LOST',
        startedAt,
        { transportMessageId },
      );
    } catch (error) {
      return outcome(claimed, 'CONFIRMATION_FAILED', startedAt, {
        errorCode: errorName(error),
        transportMessageId,
      });
    }
  }

  async #reschedule(
    claimed: ClaimedOutboxMessage,
    token: string,
    failure: EventTransportError,
    startedAt: number,
  ): Promise<PublicationOutcome> {
    const now = this.clock.now();
    const { message } = claimed;
    message.scheduleRetry(now, this.random());
    const retryInMs = Math.max(
      0,
      (message.nextAttemptAt?.getTime() ?? now.getTime()) - now.getTime(),
    );
    try {
      const recorded = await this.store.reschedule(
        message,
        token,
        retryInMs,
        failure.code,
      );
      return outcome(
        claimed,
        recorded ? 'RETRY_SCHEDULED' : 'LEASE_LOST',
        startedAt,
        {
          errorCode: failure.code,
          failureKind: failure.kind,
          retryInMs,
        },
      );
    } catch (error) {
      return outcome(claimed, 'STATE_NOT_RECORDED', startedAt, {
        errorCode: `${failure.code}+${errorName(error)}`,
        failureKind: failure.kind,
      });
    }
  }

  async #deadLetter(
    claimed: ClaimedOutboxMessage,
    token: string,
    code: string,
    kind: string,
    startedAt: number,
  ): Promise<PublicationOutcome> {
    try {
      const recorded = await this.store.deadLetter(
        claimed.message.id,
        token,
        code,
      );
      return outcome(
        claimed,
        recorded ? 'DEAD_LETTERED' : 'LEASE_LOST',
        startedAt,
        {
          errorCode: code,
          failureKind: kind,
        },
      );
    } catch (error) {
      return outcome(claimed, 'STATE_NOT_RECORDED', startedAt, {
        errorCode: `${code}+${errorName(error)}`,
        failureKind: kind,
      });
    }
  }

  async #releaseQuietly(
    rest: readonly ClaimedOutboxMessage[],
    token: string,
  ): Promise<void> {
    if (rest.length === 0) {
      return;
    }
    try {
      await this.store.release(
        rest.map((claimed) => claimed.message.id),
        token,
      );
    } catch {
      return;
    }
  }
}

function errorName(error: unknown): string {
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

function outcome(
  claimed: ClaimedOutboxMessage,
  result: PublicationResult,
  startedAt: number,
  extra: {
    errorCode?: string;
    failureKind?: string;
    transportMessageId?: string;
    retryInMs?: number;
  } = {},
): PublicationOutcome {
  const { message } = claimed;
  const correlationId = message.payload.correlationId;
  return {
    eventId: message.id,
    eventType: message.eventType,
    aggregateId: message.aggregateId,
    groupKey: claimed.groupKey,
    correlationId:
      typeof correlationId === 'string' ? correlationId : undefined,
    attempt: message.attempts + (result === 'RETRY_SCHEDULED' ? 0 : 1),
    result,
    errorCode: extra.errorCode,
    failureKind: extra.failureKind,
    transportMessageId: extra.transportMessageId,
    retryInMs: extra.retryInMs,
    recoveredFrom: claimed.previousOwner,
    durationMs: Math.round(performance.now() - startedAt),
  };
}
