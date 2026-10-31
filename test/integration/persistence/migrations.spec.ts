import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from 'bun:test';
import type { MikroORM } from '@mikro-orm/postgresql';
import { MIGRATIONS } from '../../../src/infrastructure/persistence/migrations/index.js';
import { Db, migrateFresh, openTestOrm } from './support.js';

const APP_TABLES = [
  'inbox_messages',
  'outbox_messages',
  'wager_transactions',
  'wallet_ledger_entries',
  'wallets',
];
const FINANCIAL_TABLES = [
  'wager_transactions',
  'wallet_ledger_entries',
  'wallets',
];
const DOMAINS = ['currency_code', 'identifier', 'money_amount', 'sha256_hex'];

const CONSTRAINTS = [
  'wallets_pk',
  'wallets_player_currency_uq',
  'wallets_id_currency_uq',
  'wallets_id_player_currency_uq',
  'wallets_balance_non_negative_ck',
  'wallets_version_ck',
  'wallets_updated_after_created_ck',
  'wager_tx_pk',
  'wager_tx_provider_external_uq',
  'wager_tx_provider_idempotency_uq',
  'wager_tx_wallet_currency_uq',
  'wager_tx_reference_scope_uq',
  'wager_tx_reference_scope_fk',
  'wager_tx_wallet_fk',
  'wager_tx_kind_ck',
  'wager_tx_status_ck',
  'wager_tx_failure_code_ck',
  'wager_tx_amount_ck',
  'wager_tx_reference_required_ck',
  'wager_tx_reference_forbidden_ck',
  'wager_tx_not_self_reference_ck',
  'wager_tx_resolved_reference_ck',
  'wager_tx_processed_at_ck',
  'wager_tx_failure_code_status_ck',
  'wager_tx_processed_reference_ck',
  'wager_tx_pending_reference_ck',
  'wager_tx_result_balance_ck',
  'wager_tx_processed_result_ck',
  'wager_tx_reference_attempts_ck',
  'wager_tx_processed_after_created_ck',
  'ledger_pk',
  'ledger_wallet_transaction_uq',
  'ledger_wallet_fk',
  'ledger_transaction_fk',
  'ledger_direction_ck',
  'ledger_amount_positive_ck',
  'ledger_balance_before_non_negative_ck',
  'ledger_balance_after_non_negative_ck',
  'ledger_arithmetic_ck',
  'inbox_messages_pk',
  'inbox_processed_after_received_ck',
  'outbox_messages_pk',
  'outbox_payload_object_ck',
  'outbox_attempts_ck',
  'outbox_published_after_occurred_ck',
].sort();

const INDEXES = [
  'ledger_transaction_idx',
  'ledger_wallet_created_idx',
  'outbox_pending_due_idx',
  'wager_tx_pending_reference_due_idx',
  'wager_tx_single_reversal_uq',
  'wager_tx_wallet_link_idx',
];

let orm: MikroORM;
let db: Db;

const names = async (sql: string): Promise<string[]> =>
  (await db.query(sql)).map((row) => String(row.name)).sort();

const tables = () =>
  names(
    `SELECT table_name AS name FROM information_schema.tables
     WHERE table_schema = 'public' AND table_name <> 'mikro_orm_migrations'`,
  );
const domains = () =>
  names(
    `SELECT t.typname AS name FROM pg_type t
     JOIN pg_namespace n ON n.oid = t.typnamespace
     WHERE n.nspname = 'public' AND t.typtype = 'd'`,
  );
const tableConstraints = () =>
  names(
    `SELECT c.conname AS name FROM pg_constraint c
     JOIN pg_class r ON r.oid = c.conrelid
     JOIN pg_namespace n ON n.oid = r.relnamespace
     WHERE n.nspname = 'public' AND r.relname <> 'mikro_orm_migrations'`,
  );
const ledgerTriggers = () =>
  names(
    `SELECT tgname AS name FROM pg_trigger
     WHERE tgrelid = 'wallet_ledger_entries'::regclass AND NOT tgisinternal`,
  );
const appendOnlyFunctions = () =>
  names(
    `SELECT proname AS name FROM pg_proc
     WHERE proname = 'wallet_ledger_entries_append_only'`,
  );
const executed = async () =>
  (await orm.migrator.getExecuted()).map((migration) => migration.name);

const indexDefinition = async (name: string): Promise<string> => {
  const [row] = await db.query(
    'SELECT indexdef AS definition FROM pg_indexes WHERE indexname = ?',
    [name],
  );
  return String(row?.definition);
};

const walletLinkColumns = () =>
  names(
    `SELECT column_name AS name FROM information_schema.columns
     WHERE table_name = 'wager_transactions' AND column_name = 'wallet_link_id'`,
  );

describe('migrations', () => {
  beforeAll(async () => {
    orm = await openTestOrm();
    db = new Db(orm);
  });

  beforeEach(async () => {
    await migrateFresh(orm);
  });

  afterAll(async () => {
    await migrateFresh(orm);
    await orm.close(true);
  });

  it('applies every migration on an empty database', async () => {
    expect(await executed()).toEqual(MIGRATIONS.map((m) => m.name));
    expect(await orm.migrator.getPending()).toEqual([]);
    expect(await tables()).toEqual(APP_TABLES);
    expect(await domains()).toEqual(DOMAINS);
  });

  it('creates all named constraints, indexes and the append-only triggers', async () => {
    expect(await tableConstraints()).toEqual(CONSTRAINTS);
    expect(
      (
        await db.query(
          `SELECT indexname AS name FROM pg_indexes
           WHERE schemaname = 'public' AND indexname IN (${INDEXES.map(() => '?').join(', ')})`,
          INDEXES,
        )
      )
        .map((row) => String(row.name))
        .sort(),
    ).toEqual(INDEXES);
    expect(await ledgerTriggers()).toEqual([
      'wallet_ledger_entries_no_truncate',
      'wallet_ledger_entries_no_update_delete',
    ]);
    expect(await appendOnlyFunctions()).toEqual([
      'wallet_ledger_entries_append_only',
    ]);
  });

  it('stores money columns through the exact money_amount domain', async () => {
    const rows = await db.query(
      `SELECT table_name || '.' || column_name AS name FROM information_schema.columns
       WHERE table_schema = 'public' AND domain_name = 'money_amount'`,
    );
    expect(rows.map((row) => String(row.name)).sort()).toEqual([
      'wager_transactions.amount',
      'wager_transactions.result_balance',
      'wallet_ledger_entries.amount',
      'wallet_ledger_entries.balance_after',
      'wallet_ledger_entries.balance_before',
      'wallets.balance',
    ]);
  });

  it('allows a single reversal per referenced transaction', async () => {
    expect(await indexDefinition('wager_tx_single_reversal_uq')).toContain(
      '(reference_transaction_id) WHERE',
    );
  });

  it('reverts one step at a time in reverse order', async () => {
    const expectExecuted = async (count: number) =>
      expect(await executed()).toEqual(
        MIGRATIONS.slice(0, count).map((m) => m.name),
      );

    await orm.migrator.down();
    await expectExecuted(2);
    expect(await walletLinkColumns()).toEqual([]);
    expect(await indexDefinition('wager_tx_single_reversal_uq')).toContain(
      '(reference_transaction_id, kind) WHERE',
    );
    expect(await tableConstraints()).not.toContain('wager_tx_wallet_fk');

    await orm.migrator.down();
    await expectExecuted(1);
    expect(await tables()).toEqual(FINANCIAL_TABLES);

    await orm.migrator.down();
    await expectExecuted(0);
    expect(await tables()).toEqual([]);
    expect(await domains()).toEqual([]);
    expect(await appendOnlyFunctions()).toEqual([]);
  });

  it('reapplies cleanly after a full rollback and keeps working', async () => {
    await orm.migrator.down({ to: 0 });
    await orm.migrator.up();
    expect(await executed()).toEqual(MIGRATIONS.map((m) => m.name));
    expect(await tables()).toEqual(APP_TABLES);
    expect(await tableConstraints()).toEqual(CONSTRAINTS);
    expect(await walletLinkColumns()).toEqual(['wallet_link_id']);

    const wallet = await db.insertWallet();
    const transaction = await db.insertTransaction(wallet);
    await db.insertLedger(wallet, transaction);
    expect(await db.query('SELECT 1 FROM wallet_ledger_entries')).toHaveLength(
      1,
    );
  });

  it('reverts the latest migration with data present and reapplies it', async () => {
    const wallet = await db.insertWallet();
    await db.insertTransaction(wallet);
    await orm.migrator.down();
    await orm.migrator.up();
    expect(await db.query('SELECT 1 FROM wager_transactions')).toHaveLength(1);
  });

  it('rolls back a full cycle even with ledger rows present', async () => {
    const wallet = await db.insertWallet();
    const transaction = await db.insertTransaction(wallet);
    await db.insertLedger(wallet, transaction);
    await orm.migrator.down({ to: 0 });
    expect(await tables()).toEqual([]);
    await orm.migrator.up();
    expect(await db.query('SELECT 1 FROM wallet_ledger_entries')).toHaveLength(
      0,
    );
  });
});
