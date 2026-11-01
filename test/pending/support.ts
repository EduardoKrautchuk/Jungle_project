import { randomUUID } from 'node:crypto';
import type { MikroORM } from '@mikro-orm/postgresql';
import type { Clock } from '../../src/application/ports/runtime.js';
import {
  ResolvePendingReference,
  type PendingReferencePolicy,
} from '../../src/application/wagering/resolve-pending-reference.js';
import {
  SubmitWagerTransaction,
  type SubmitWagerTransactionCommand,
} from '../../src/application/wagering/submit-wager-transaction.js';
import { WagerSettlement } from '../../src/application/wagering/wager-settlement.js';
import { CreateWallet } from '../../src/application/wallets/create-wallet.js';
import { MikroOrmUnitOfWork } from '../../src/infrastructure/persistence/mikro-orm-unit-of-work.js';
import { UuidV7Generator } from '../../src/infrastructure/runtime/system-runtime.js';
import type { Db } from '../integration/persistence/support.js';

export class MutableClock implements Clock {
  #offsetMs = 0;

  now(): Date {
    return new Date(Date.now() + this.#offsetMs);
  }

  advance(ms: number): void {
    this.#offsetMs += ms;
  }
}

export const POLICY: PendingReferencePolicy = {
  maxAttempts: 4,
  baseDelayMs: 1_000,
  maxDelayMs: 5_000,
};

export interface Stack {
  readonly clock: MutableClock;
  readonly submit: SubmitWagerTransaction;
  readonly create: CreateWallet;
  readonly resolver: ResolvePendingReference;
}

export function stack(
  orm: MikroORM,
  clock = new MutableClock(),
  options: { lockTimeoutMs?: number; policy?: PendingReferencePolicy } = {},
): Stack {
  const ids = new UuidV7Generator();
  const uow = new MikroOrmUnitOfWork(orm.em, {
    lockTimeoutMs: options.lockTimeoutMs,
  });
  const settlement = new WagerSettlement(ids);
  return {
    clock,
    submit: new SubmitWagerTransaction(uow, settlement, clock, ids),
    create: new CreateWallet(uow, clock, ids),
    resolver: new ResolvePendingReference(
      uow,
      settlement,
      clock,
      ids,
      options.policy ?? POLICY,
    ),
  };
}

export interface WalletRef {
  readonly id: string;
  readonly playerId: string;
}

export async function openWallet(
  s: Stack,
  amount = '100.00',
  currency = 'BRL',
): Promise<WalletRef> {
  const wallet = await s.create.execute({
    playerId: `player-${randomUUID()}`,
    initialBalance: { amount, currency },
    correlationId: 'corr-open',
  });
  return { id: wallet.id, playerId: wallet.playerId };
}

let sequence = 0;

export function command(
  wallet: WalletRef,
  overrides: Partial<SubmitWagerTransactionCommand> = {},
): SubmitWagerTransactionCommand {
  const externalTransactionId =
    overrides.externalTransactionId ??
    `ext-${Date.now().toString(36)}-${++sequence}`;
  const providerId = overrides.providerId ?? 'provider-a';
  return {
    providerId,
    externalTransactionId,
    idempotencyKey: `${providerId}:${externalTransactionId}`,
    correlationId: `corr-${externalTransactionId}`,
    playerId: wallet.playerId,
    walletId: wallet.id,
    roundId: 'round-1',
    gameId: 'fortune-chimp',
    kind: 'BET',
    money: { amount: '25.00', currency: 'BRL' },
    ...overrides,
  };
}

export const uniqueRef = (prefix: string): string =>
  `${prefix}-${Date.now().toString(36)}-${++sequence}`;

export async function drain(s: Stack, rounds = 10): Promise<string[]> {
  const results: string[] = [];
  for (let round = 0; round < rounds; round += 1) {
    const due = await s.resolver.listDue(50, 'test');
    if (due.length === 0) {
      break;
    }
    for (const candidate of due) {
      results.push((await s.resolver.resolve(candidate)).result);
    }
  }
  return results;
}

export async function transactionRow(db: Db, id: string) {
  const [row] = await db.query(
    `SELECT id, kind, status, failure_code, idempotency_key, payload_hash,
            external_transaction_id, reference_transaction_id,
            result_balance::text AS result_balance, reference_attempts,
            (next_reference_attempt_at IS NOT NULL)::text AS scheduled
       FROM wager_transactions WHERE id = ?`,
    [id],
  );
  return row;
}

export async function balance(db: Db, walletId: string): Promise<string> {
  const [row] = await db.query(
    'SELECT balance::text AS balance FROM wallets WHERE id = ?',
    [walletId],
  );
  return String(row?.balance);
}

export async function ledgerDirections(
  db: Db,
  walletId: string,
): Promise<string[]> {
  const rows = await db.query(
    'SELECT direction FROM wallet_ledger_entries WHERE wallet_id = ? ORDER BY created_at, id',
    [walletId],
  );
  return rows.map((row) => String(row.direction));
}

export async function eventsOf(db: Db, aggregateId: string): Promise<string[]> {
  const rows = await db.query(
    'SELECT event_type FROM outbox_messages WHERE aggregate_id = ? ORDER BY publish_sequence',
    [aggregateId],
  );
  return rows.map((row) => String(row.event_type));
}

export async function ledgerChainBreaks(db: Db): Promise<number> {
  const [row] = await db.query(`
    SELECT count(*)::int AS breaks FROM (
      SELECT balance_before,
             lag(balance_after) OVER (PARTITION BY wallet_id ORDER BY created_at, id) AS previous
        FROM wallet_ledger_entries) entries
     WHERE previous IS NOT NULL AND previous <> balance_before`);
  return Number(row?.breaks);
}
