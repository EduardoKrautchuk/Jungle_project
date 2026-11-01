import { createHash, randomUUID } from 'node:crypto';
import type {
  StoredWagerTransaction,
  TransactionalRepositories,
  UnitOfWork,
} from '../../../src/application/ports/persistence.js';
import { OutboxMessage } from '../../../src/domain/messaging/outbox-message.js';
import { Money } from '../../../src/domain/money/money.js';
import {
  WagerTransactionKind,
  WagerTransactionStatus,
} from '../../../src/domain/wagering/wager-transaction.enums.js';
import {
  WagerTransaction,
  type CreateWagerTransactionProps,
} from '../../../src/domain/wagering/wager-transaction.js';
import { InsufficientFundsError } from '../../../src/domain/wallet/wallet.errors.js';
import { Wallet } from '../../../src/domain/wallet/wallet.js';

export const NOW = new Date('2026-10-31T12:00:00.000Z');
export const LATER = new Date('2026-10-31T12:00:01.000Z');

export const brl = (amount: string): Money =>
  Money.from({ amount, currency: 'BRL' });

export const sha256 = (value: string): string =>
  createHash('sha256').update(value).digest('hex');

export function stored(
  transaction: WagerTransaction,
  resultBalance?: Money,
): StoredWagerTransaction {
  return {
    transaction,
    resultBalance,
    referenceAttempts: 0,
    nextReferenceAttemptAt: undefined,
  };
}

export async function persistOpenedWallet(
  uow: UnitOfWork,
  initialBalance = '100.00',
): Promise<Wallet> {
  const id = randomUUID();
  const playerId = `player-${randomUUID()}`;
  const money = brl(initialBalance);
  const openingId = randomUUID();
  const { wallet, openingEntry } = Wallet.open({
    id,
    playerId,
    initialBalance: money,
    at: NOW,
    opening: money.isPositive()
      ? { entryId: randomUUID(), transactionId: openingId }
      : undefined,
  });

  await uow.run(async (repositories) => {
    await repositories.wallets.insert(wallet);
    if (openingEntry !== undefined) {
      const opening = WagerTransaction.create({
        id: openingId,
        providerId: 'internal',
        externalTransactionId: `opening:${id}`,
        idempotencyKey: `internal:opening:${id}`,
        payloadHash: sha256(`opening:${id}`),
        walletId: id,
        playerId,
        roundId: 'opening',
        gameId: 'internal',
        kind: WagerTransactionKind.Opening,
        money,
        createdAt: NOW,
      });
      opening.markProcessed(undefined, NOW);
      await repositories.transactions.insert(stored(opening, money));
      await repositories.ledger.append(openingEntry);
    }
  });
  return wallet;
}

export function wagerTransaction(
  wallet: Wallet,
  overrides: Partial<CreateWagerTransactionProps> = {},
): WagerTransaction {
  const externalTransactionId = `ext-${randomUUID()}`;
  return WagerTransaction.create({
    id: randomUUID(),
    providerId: 'provider-a',
    externalTransactionId,
    idempotencyKey: `provider-a:${externalTransactionId}`,
    payloadHash: sha256(externalTransactionId),
    walletId: wallet.id,
    playerId: wallet.playerId,
    roundId: 'round-1',
    gameId: 'fortune-chimp',
    kind: WagerTransactionKind.Bet,
    money: brl('25.00'),
    createdAt: NOW,
    ...overrides,
  });
}

export function outboxEvent(aggregateId: string, eventType: string) {
  const eventId = randomUUID();
  return OutboxMessage.enqueue({
    eventId,
    aggregateId,
    eventType,
    occurredAt: LATER,
    toJSON: () => ({ eventId, eventType, aggregateId }),
  });
}

export type DebitOutcome =
  | { outcome: 'PROCESSED' | 'REJECTED'; balance: string }
  | { outcome: 'REPLAY'; status: string; balance: string | undefined }
  | { outcome: 'CONFLICT' };

function fromExisting(
  incoming: WagerTransaction,
  existing: StoredWagerTransaction,
): DebitOutcome {
  const sameRequest =
    existing.transaction.idempotencyKey === incoming.idempotencyKey &&
    existing.transaction.matchesPayload(incoming.payloadHash);
  return sameRequest
    ? {
        outcome: 'REPLAY',
        status: existing.transaction.status,
        balance: existing.resultBalance?.toJSON().amount,
      }
    : { outcome: 'CONFLICT' };
}

export async function applyDebit(
  uow: UnitOfWork,
  transaction: WagerTransaction,
  hooks: {
    afterLock?: (repositories: TransactionalRepositories) => Promise<void>;
    beforeCommit?: () => Promise<void>;
  } = {},
): Promise<DebitOutcome> {
  const known = await uow.run((repositories) =>
    repositories.transactions.findByIdempotencyKey(
      transaction.providerId,
      transaction.idempotencyKey,
    ),
  );
  if (known !== undefined) {
    return fromExisting(transaction, known);
  }

  return uow.runWithWalletLock(
    transaction.walletId,
    async ({ wallet, repositories }) => {
      if (wallet === undefined) {
        throw new Error(`wallet ${transaction.walletId} not found`);
      }
      const claim = await repositories.transactions.claim(stored(transaction));
      if (claim.outcome !== 'CREATED') {
        return fromExisting(transaction, claim.existing);
      }
      await hooks.afterLock?.(repositories);
      const expectedVersion = wallet.version;
      let outcome: DebitOutcome;
      try {
        const entry = wallet.debit(transaction.money, {
          entryId: randomUUID(),
          transactionId: transaction.id,
          at: LATER,
        });
        await repositories.wallets.update(wallet, expectedVersion);
        await repositories.ledger.append(entry);
        transaction.markProcessed(undefined, LATER);
        await repositories.transactions.update(
          stored(transaction, wallet.balance),
          WagerTransactionStatus.Pending,
        );
        await repositories.outbox.enqueue(
          outboxEvent(transaction.id, 'WagerTransactionProcessed'),
        );
        outcome = {
          outcome: 'PROCESSED',
          balance: wallet.balance.toJSON().amount,
        };
      } catch (error) {
        if (!(error instanceof InsufficientFundsError)) {
          throw error;
        }
        transaction.reject(transaction.insufficientFundsFailureCode());
        await repositories.transactions.update(
          stored(transaction, wallet.balance),
          WagerTransactionStatus.Pending,
        );
        await repositories.outbox.enqueue(
          outboxEvent(transaction.id, 'WagerTransactionRejected'),
        );
        outcome = {
          outcome: 'REJECTED',
          balance: wallet.balance.toJSON().amount,
        };
      }
      await hooks.beforeCommit?.();
      return outcome;
    },
  );
}

export function deferred<T = void>() {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

export const sleep = (ms: number) =>
  new Promise<void>((done) => setTimeout(done, ms));
