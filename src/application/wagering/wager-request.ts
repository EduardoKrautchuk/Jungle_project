import type { MoneyProps } from '../../domain/money/money.js';
import { canonicalJson, sha256Hex } from '../idempotency/canonical-json.js';

export interface WagerRequestPayload {
  readonly providerId: string;
  readonly externalTransactionId: string;
  readonly playerId: string;
  readonly walletId: string;
  readonly roundId: string;
  readonly gameId: string;
  readonly kind: string;
  readonly money: MoneyProps;
  readonly referenceExternalTransactionId?: string;
}

export function wagerPayloadHash(payload: WagerRequestPayload): string {
  return sha256Hex(
    canonicalJson({
      providerId: payload.providerId,
      externalTransactionId: payload.externalTransactionId,
      playerId: payload.playerId,
      walletId: payload.walletId,
      roundId: payload.roundId,
      gameId: payload.gameId,
      kind: payload.kind,
      money: { amount: payload.money.amount, currency: payload.money.currency },
      referenceExternalTransactionId: payload.referenceExternalTransactionId,
    }),
  );
}
