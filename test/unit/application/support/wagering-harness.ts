import type { Wallet } from '../../../../src/domain/wallet/wallet.js';
import {
  SubmitWagerTransaction,
  type SubmitWagerTransactionCommand,
} from '../../../../src/application/wagering/submit-wager-transaction.js';
import { WagerSettlement } from '../../../../src/application/wagering/wager-settlement.js';
import { CreateWallet } from '../../../../src/application/wallets/create-wallet.js';
import { WalletQueries } from '../../../../src/application/wallets/wallet-queries.js';
import {
  InMemoryUnitOfWork,
  SequentialIds,
  TestClock,
} from './in-memory-unit-of-work.js';

export function createHarness() {
  const uow = new InMemoryUnitOfWork();
  const clock = new TestClock();
  const ids = new SequentialIds();
  const settlement = new WagerSettlement(ids);
  return {
    uow,
    clock,
    ids,
    settlement,
    submit: new SubmitWagerTransaction(uow, settlement, clock, ids),
    createWallet: new CreateWallet(uow, clock, ids),
    queries: new WalletQueries(uow),
  };
}

export type Harness = ReturnType<typeof createHarness>;

let sequence = 0;

export async function openWallet(
  harness: Harness,
  amount = '100.00',
  playerId = `player-${++sequence}`,
): Promise<Wallet> {
  return harness.createWallet.execute({
    playerId,
    initialBalance: { amount, currency: 'BRL' },
    correlationId: 'corr-open',
  });
}

export function wager(
  wallet: Wallet,
  overrides: Partial<SubmitWagerTransactionCommand> = {},
): SubmitWagerTransactionCommand {
  const externalTransactionId =
    overrides.externalTransactionId ?? `tx-${++sequence}`;
  return {
    providerId: 'provider-a',
    externalTransactionId,
    idempotencyKey: `provider-a:${externalTransactionId}`,
    correlationId: 'corr-1',
    playerId: wallet.playerId,
    walletId: wallet.id,
    roundId: 'round-1',
    gameId: 'fortune-chimp',
    kind: 'BET',
    money: { amount: '25.00', currency: 'BRL' },
    ...overrides,
  };
}

export function balanceOf(harness: Harness, walletId: string): string {
  return (
    harness.uow.tables.wallets.find((w) => w.id === walletId)?.balance ?? ''
  );
}

export function versionOf(harness: Harness, walletId: string): number {
  return (
    harness.uow.tables.wallets.find((w) => w.id === walletId)?.version ?? 0
  );
}

export function ledgerOf(harness: Harness, walletId: string) {
  return harness.uow.tables.ledger.filter((e) => e.walletId === walletId);
}

export function eventsFor(harness: Harness, aggregateId: string): string[] {
  return harness.uow.tables.outbox
    .filter((m) => m.aggregateId === aggregateId)
    .map((m) => m.eventType);
}

export function transactionRecord(harness: Harness, id: string) {
  return harness.uow.tables.transactions.find((t) => t.id === id);
}
