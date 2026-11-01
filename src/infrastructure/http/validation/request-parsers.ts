import type { CreateWalletCommand } from '../../../application/wallets/create-wallet.js';
import type { WagerRequestPayload } from '../../../application/wagering/wager-request.js';
import {
  CORRELATION_ID,
  IDENTIFIER,
  PROVIDER_ID,
  RequestReader,
  SUBMITTABLE_KIND,
} from '../../validation/request-reader.js';

export const DEFAULT_LEDGER_PAGE_SIZE = 50;
export const MAX_LEDGER_PAGE_SIZE = 200;

const WAGER_FIELDS = [
  'providerId',
  'externalTransactionId',
  'playerId',
  'walletId',
  'roundId',
  'gameId',
  'kind',
  'money',
  'referenceExternalTransactionId',
];

export function parseWagerRequest(
  body: unknown,
  idempotencyKey: unknown,
): WagerRequestPayload & { idempotencyKey: string } {
  const reader = new RequestReader();
  const input = reader.object(body, 'body', WAGER_FIELDS);
  const payload = {
    idempotencyKey: reader.string(
      idempotencyKey,
      'header.Idempotency-Key',
      IDENTIFIER,
    ),
    providerId: reader.string(input.providerId, 'providerId', PROVIDER_ID),
    externalTransactionId: reader.string(
      input.externalTransactionId,
      'externalTransactionId',
      IDENTIFIER,
    ),
    playerId: reader.string(input.playerId, 'playerId', IDENTIFIER),
    walletId: reader.uuid(input.walletId, 'walletId'),
    roundId: reader.string(input.roundId, 'roundId', IDENTIFIER),
    gameId: reader.string(input.gameId, 'gameId', IDENTIFIER),
    kind: reader.string(input.kind, 'kind', SUBMITTABLE_KIND),
    money: reader.money(input.money, 'money'),
    referenceExternalTransactionId: reader.optionalString(
      input.referenceExternalTransactionId,
      'referenceExternalTransactionId',
      IDENTIFIER,
    ),
  };
  return reader.finish(payload);
}

export function parseCreateWallet(
  body: unknown,
): Omit<CreateWalletCommand, 'correlationId'> {
  const reader = new RequestReader();
  const input = reader.object(body, 'body', ['playerId', 'initialBalance']);
  return reader.finish({
    playerId: reader.string(input.playerId, 'playerId', IDENTIFIER),
    initialBalance: reader.money(input.initialBalance, 'initialBalance'),
  });
}

export function parseLedgerQuery(query: unknown): {
  cursor: string | undefined;
  limit: number;
} {
  const reader = new RequestReader();
  const input = reader.object(query, 'query', ['cursor', 'limit']);
  let cursor: string | undefined;
  if (input.cursor !== undefined) {
    if (typeof input.cursor !== 'string' || input.cursor === '') {
      reader.issue('cursor', 'INVALID_CURSOR', 'must be a non-empty string');
    } else {
      cursor = input.cursor;
    }
  }
  let limit = DEFAULT_LEDGER_PAGE_SIZE;
  if (input.limit !== undefined) {
    const raw = typeof input.limit === 'string' ? input.limit : '';
    const parsed = /^[1-9]\d{0,3}$/.test(raw) ? Number(raw) : Number.NaN;
    if (Number.isNaN(parsed) || parsed > MAX_LEDGER_PAGE_SIZE) {
      reader.issue(
        'limit',
        'INVALID_LIMIT',
        `must be an integer between 1 and ${MAX_LEDGER_PAGE_SIZE}`,
      );
    } else {
      limit = parsed;
    }
  }
  return reader.finish({ cursor, limit });
}

export function parseCorrelationId(header: unknown): string | undefined {
  if (header === undefined) {
    return undefined;
  }
  const reader = new RequestReader();
  const value = reader.string(
    header,
    'header.X-Correlation-Id',
    CORRELATION_ID,
  );
  return reader.finish(value);
}

export function parseProviderPath(
  providerId: unknown,
  externalTransactionId: unknown,
): { providerId: string; externalTransactionId: string } {
  const reader = new RequestReader();
  return reader.finish({
    providerId: reader.string(providerId, 'providerId', PROVIDER_ID),
    externalTransactionId: reader.string(
      externalTransactionId,
      'externalTransactionId',
      IDENTIFIER,
    ),
  });
}
