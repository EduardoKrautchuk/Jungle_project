import { randomUUID } from 'node:crypto';
import { expect } from 'bun:test';
import { MikroORM } from '@mikro-orm/postgresql';
import { loadDatabaseConfig } from '../../../src/infrastructure/config/database.config.js';
import { createMikroOrmConfig } from '../../../src/infrastructure/persistence/mikro-orm.config.js';

export type Row = Record<string, string | number | null>;

export const T0 = '2026-10-31T12:00:00.000Z';
export const T1 = '2026-10-31T12:00:01.000Z';
export const HASH = 'a'.repeat(64);

export const SQLSTATE = {
  restrictViolation: '23001',
  notNullViolation: '23502',
  foreignKeyViolation: '23503',
  uniqueViolation: '23505',
  checkViolation: '23514',
} as const;

export async function openTestOrm(): Promise<MikroORM> {
  const database = loadDatabaseConfig(process.env, 'test');
  return MikroORM.init(createMikroOrmConfig(database));
}

export async function migrateFresh(orm: MikroORM): Promise<void> {
  const dbName = orm.config.get('dbName');
  if (!dbName?.endsWith('_test')) {
    throw new Error(`Refusing to reset non-test database "${dbName}"`);
  }
  await orm.migrator.down({ to: 0 });
  await orm.migrator.up();
}

export class Db {
  constructor(private readonly orm: MikroORM) {}

  async query(sql: string, params: unknown[] = []): Promise<Row[]> {
    const rows: unknown = await this.orm.em
      .getConnection()
      .execute(sql, params);
    return Array.isArray(rows) ? rows.filter(isRow) : [];
  }

  async insert(table: string, row: Row): Promise<void> {
    const columns = Object.keys(row);
    const placeholders = columns.map(() => '?').join(', ');
    await this.query(
      `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${placeholders})`,
      Object.values(row),
    );
  }

  async insertWallet(overrides: Row = {}): Promise<Row> {
    const row = walletRow(overrides);
    await this.insert('wallets', row);
    return row;
  }

  async insertTransaction(wallet: Row, overrides: Row = {}): Promise<Row> {
    const row = transactionRow(wallet, overrides);
    await this.insert('wager_transactions', row);
    return row;
  }

  async insertLedger(
    wallet: Row,
    transaction: Row,
    overrides: Row = {},
  ): Promise<Row> {
    const row = ledgerRow(wallet, transaction, overrides);
    await this.insert('wallet_ledger_entries', row);
    return row;
  }
}

function isRow(value: unknown): value is Row {
  return typeof value === 'object' && value !== null;
}

export function walletRow(overrides: Row = {}): Row {
  return {
    id: randomUUID(),
    player_id: `player-${randomUUID()}`,
    currency: 'BRL',
    balance: '100.00',
    version: 1,
    created_at: T0,
    updated_at: T0,
    ...overrides,
  };
}

export function transactionRow(wallet: Row, overrides: Row = {}): Row {
  const external = `ext-${randomUUID()}`;
  return {
    id: randomUUID(),
    provider_id: 'provider-a',
    external_transaction_id: external,
    idempotency_key: `provider-a:${external}`,
    payload_hash: HASH,
    wallet_id: wallet.id ?? null,
    player_id: wallet.player_id ?? null,
    round_id: 'round-1',
    game_id: 'fortune-chimp',
    kind: 'BET',
    status: 'PENDING',
    amount: '25.00',
    currency: wallet.currency ?? null,
    created_at: T0,
    ...overrides,
  };
}

export function processed(resultBalance = '75.00'): Row {
  return {
    status: 'PROCESSED',
    processed_at: T1,
    result_balance: resultBalance,
  };
}

export function ledgerRow(
  wallet: Row,
  transaction: Row,
  overrides: Row = {},
): Row {
  return {
    id: randomUUID(),
    wallet_id: wallet.id ?? null,
    transaction_id: transaction.id ?? null,
    direction: 'DEBIT',
    amount: '25.00',
    currency: wallet.currency ?? null,
    balance_before: '100.00',
    balance_after: '75.00',
    created_at: T1,
    ...overrides,
  };
}

interface PgError {
  code: string;
  constraint?: string;
  message: string;
}

function isPgError(error: unknown): error is PgError {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof error.code === 'string' &&
    'message' in error &&
    typeof error.message === 'string'
  );
}

export async function expectViolation(
  action: Promise<unknown>,
  expected: { code: string; constraint?: string; message?: string },
): Promise<void> {
  let caught: unknown;
  try {
    await action;
  } catch (error) {
    caught = error;
  }
  if (caught === undefined) {
    throw new Error(
      `Expected ${expected.constraint ?? expected.code} violation, but the statement succeeded`,
    );
  }
  if (!isPgError(caught)) {
    throw caught;
  }
  expect(caught.code).toBe(expected.code);
  if (expected.constraint !== undefined) {
    expect(caught.constraint).toBe(expected.constraint);
  }
  if (expected.message !== undefined) {
    expect(caught.message).toContain(expected.message);
  }
}
