import type {
  ClaimedOutboxMessage,
  OutgoingEvent,
} from '../ports/outbox-publication.js';

export const MAX_EVENT_BODY_BYTES = 262_144;
const GROUP_KEY_PATTERN = /^[\x21-\x7E]{1,128}$/;
const DECIMAL_AMOUNT_PATTERN = /^-?(0|[1-9]\d*)\.\d{2}$/;

export class InvalidOutboxEventError extends Error {
  constructor(readonly code: string) {
    super(`outbox event cannot be published: ${code}`);
    this.name = 'InvalidOutboxEventError';
  }
}

type JsonRecord = Readonly<Record<string, unknown>>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireString(payload: JsonRecord, key: string, code: string): string {
  const value = payload[key];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new InvalidOutboxEventError(code);
  }
  return value;
}

function assertDecimalAmounts(value: unknown): void {
  if (Array.isArray(value)) {
    value.forEach(assertDecimalAmounts);
    return;
  }
  if (!isRecord(value)) {
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    if (
      key === 'amount' &&
      (typeof child !== 'string' || !DECIMAL_AMOUNT_PATTERN.test(child))
    ) {
      throw new InvalidOutboxEventError('EVENT_AMOUNT_NOT_DECIMAL_STRING');
    }
    assertDecimalAmounts(child);
  }
}

export function toOutgoingEvent(claimed: ClaimedOutboxMessage): OutgoingEvent {
  const { message, groupKey } = claimed;
  const payload = message.payload;
  if (requireString(payload, 'eventId', 'EVENT_ID_MISSING') !== message.id) {
    throw new InvalidOutboxEventError('EVENT_ID_MISMATCH');
  }
  if (
    requireString(payload, 'eventType', 'EVENT_TYPE_MISSING') !==
    message.eventType
  ) {
    throw new InvalidOutboxEventError('EVENT_TYPE_MISMATCH');
  }
  if (
    requireString(payload, 'aggregateId', 'AGGREGATE_ID_MISSING') !==
    message.aggregateId
  ) {
    throw new InvalidOutboxEventError('AGGREGATE_ID_MISMATCH');
  }
  const correlationId = requireString(
    payload,
    'correlationId',
    'CORRELATION_ID_MISSING',
  );
  if (
    payload.causationId !== undefined &&
    typeof payload.causationId !== 'string'
  ) {
    throw new InvalidOutboxEventError('CAUSATION_ID_INVALID');
  }
  const occurredAt = requireString(
    payload,
    'occurredAt',
    'OCCURRED_AT_MISSING',
  );
  if (
    Number.isNaN(Date.parse(occurredAt)) ||
    new Date(occurredAt).getTime() !== message.occurredAt.getTime()
  ) {
    throw new InvalidOutboxEventError('OCCURRED_AT_MISMATCH');
  }
  const version = payload.version;
  if (
    typeof version !== 'number' ||
    !Number.isSafeInteger(version) ||
    version < 1
  ) {
    throw new InvalidOutboxEventError('EVENT_VERSION_INVALID');
  }
  if (!isRecord(payload.data)) {
    throw new InvalidOutboxEventError('EVENT_DATA_INVALID');
  }
  assertDecimalAmounts(payload.data);
  if (!GROUP_KEY_PATTERN.test(groupKey)) {
    throw new InvalidOutboxEventError('GROUP_KEY_INVALID');
  }
  const body = JSON.stringify(payload);
  if (new TextEncoder().encode(body).byteLength > MAX_EVENT_BODY_BYTES) {
    throw new InvalidOutboxEventError('EVENT_BODY_TOO_LARGE');
  }
  return {
    eventId: message.id,
    eventType: message.eventType,
    version,
    correlationId,
    groupKey,
    body,
  };
}
