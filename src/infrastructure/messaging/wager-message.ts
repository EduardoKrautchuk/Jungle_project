import type { InboxDelivery } from '../../application/messaging/inbox-delivery.js';
import {
  canonicalJson,
  sha256Hex,
} from '../../application/idempotency/canonical-json.js';
import type { SubmitWagerTransactionCommand } from '../../application/wagering/submit-wager-transaction.js';
import {
  CORRELATION_ID,
  IDENTIFIER,
  PROVIDER_ID,
  RequestReader,
  SUBMITTABLE_KIND,
  type StringRule,
} from '../validation/request-reader.js';

export const WAGER_TRANSACTION_REQUESTED = 'WagerTransactionRequested';

export class MalformedMessageError extends Error {
  readonly code = 'MALFORMED_MESSAGE';

  constructor() {
    super('The message body is not valid JSON');
    this.name = 'MalformedMessageError';
  }
}

export interface WagerTransactionRequested {
  readonly messageId: string;
  readonly type: typeof WAGER_TRANSACTION_REQUESTED;
  readonly occurredAt: Date;
  readonly correlationId: string;
  readonly payloadHash: string;
  readonly command: SubmitWagerTransactionCommand;
}

const ENVELOPE_FIELDS = [
  'messageId',
  'type',
  'occurredAt',
  'correlationId',
  'data',
];

const DATA_FIELDS = [
  'providerId',
  'externalTransactionId',
  'idempotencyKey',
  'playerId',
  'walletId',
  'roundId',
  'gameId',
  'kind',
  'money',
  'referenceExternalTransactionId',
];

const MESSAGE_TYPE: StringRule = {
  pattern: /^WagerTransactionRequested$/,
  code: 'UNSUPPORTED_MESSAGE_TYPE',
  message: `must be ${WAGER_TRANSACTION_REQUESTED}`,
};

const ISO_TIMESTAMP: StringRule = {
  pattern: /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/,
  code: 'INVALID_TIMESTAMP',
  message: 'must be an ISO-8601 UTC timestamp',
};

export function decodeMessageBody(body: string | undefined): unknown {
  try {
    const value: unknown = JSON.parse(body ?? '');
    return value;
  } catch {
    throw new MalformedMessageError();
  }
}

export function parseWagerMessage(
  body: string | undefined,
): WagerTransactionRequested {
  const raw = decodeMessageBody(body);
  const reader = new RequestReader();
  const envelope = reader.object(raw, 'body', ENVELOPE_FIELDS);
  const messageId = reader.string(envelope.messageId, 'messageId', IDENTIFIER);
  reader.string(envelope.type, 'type', MESSAGE_TYPE);
  const occurredAtText = reader.string(
    envelope.occurredAt,
    'occurredAt',
    ISO_TIMESTAMP,
  );
  const occurredAt = new Date(occurredAtText);
  if (occurredAtText !== '' && Number.isNaN(occurredAt.getTime())) {
    reader.issue('occurredAt', ISO_TIMESTAMP.code, ISO_TIMESTAMP.message);
  }
  const correlationId = reader.optionalString(
    envelope.correlationId,
    'correlationId',
    CORRELATION_ID,
  );
  const data = reader.object(envelope.data, 'data', DATA_FIELDS);
  const payload = {
    providerId: reader.string(data.providerId, 'data.providerId', PROVIDER_ID),
    externalTransactionId: reader.string(
      data.externalTransactionId,
      'data.externalTransactionId',
      IDENTIFIER,
    ),
    idempotencyKey: reader.string(
      data.idempotencyKey,
      'data.idempotencyKey',
      IDENTIFIER,
    ),
    playerId: reader.string(data.playerId, 'data.playerId', IDENTIFIER),
    walletId: reader.uuid(data.walletId, 'data.walletId'),
    roundId: reader.string(data.roundId, 'data.roundId', IDENTIFIER),
    gameId: reader.string(data.gameId, 'data.gameId', IDENTIFIER),
    kind: reader.string(data.kind, 'data.kind', SUBMITTABLE_KIND),
    money: reader.money(data.money, 'data.money'),
    referenceExternalTransactionId: reader.optionalString(
      data.referenceExternalTransactionId,
      'data.referenceExternalTransactionId',
      IDENTIFIER,
    ),
  };
  reader.finish(payload);

  const resolvedCorrelationId = correlationId ?? messageId;
  return {
    messageId,
    type: WAGER_TRANSACTION_REQUESTED,
    occurredAt,
    correlationId: resolvedCorrelationId,
    payloadHash: sha256Hex(
      canonicalJson({
        type: WAGER_TRANSACTION_REQUESTED,
        data: {
          ...payload,
          money: {
            amount: payload.money.amount,
            currency: payload.money.currency,
          },
        },
      }),
    ),
    command: {
      ...payload,
      correlationId: resolvedCorrelationId,
      causationId: messageId,
    },
  };
}

export function inboxDeliveryOf(
  message: WagerTransactionRequested,
  consumerName: string,
): InboxDelivery {
  return {
    consumerName,
    messageId: message.messageId,
    payloadHash: message.payloadHash,
  };
}
