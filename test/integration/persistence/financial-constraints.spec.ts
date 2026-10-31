import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { MikroORM } from '@mikro-orm/postgresql';
import {
  Db,
  SQLSTATE,
  T0,
  T1,
  expectViolation,
  migrateFresh,
  openTestOrm,
  processed,
  transactionRow,
  walletRow,
  type Row,
} from './support.js';

const MAX = '999999999999999999.99';

let orm: MikroORM;
let db: Db;

const check = (constraint: string) => ({
  code: SQLSTATE.checkViolation,
  constraint,
});
const unique = (constraint: string) => ({
  code: SQLSTATE.uniqueViolation,
  constraint,
});
const foreignKey = (constraint: string) => ({
  code: SQLSTATE.foreignKeyViolation,
  constraint,
});

async function processedBet(wallet: Row, overrides: Row = {}): Promise<Row> {
  return db.insertTransaction(wallet, { ...processed(), ...overrides });
}

describe('financial schema constraints', () => {
  beforeAll(async () => {
    orm = await openTestOrm();
    db = new Db(orm);
    await migrateFresh(orm);
  });

  afterAll(async () => {
    await orm.close(true);
  });

  describe('wallets', () => {
    it('accepts a valid wallet', async () => {
      const wallet = await db.insertWallet();
      const [stored] = await db.query(
        'SELECT balance, version FROM wallets WHERE id = ?',
        [wallet.id],
      );
      expect(stored).toEqual({ balance: '100.00', version: 1 });
    });

    it('rejects a second wallet for the same player and currency', async () => {
      const wallet = await db.insertWallet();
      await expectViolation(
        db.insertWallet({ player_id: wallet.player_id ?? null }),
        unique('wallets_player_currency_uq'),
      );
    });

    it('allows the same player in another currency', async () => {
      const wallet = await db.insertWallet();
      await db.insertWallet({
        player_id: wallet.player_id ?? null,
        currency: 'USD',
      });
    });

    it('rejects a negative balance', async () => {
      await expectViolation(
        db.insertWallet({ balance: '-0.01' }),
        check('wallets_balance_non_negative_ck'),
      );
    });

    it('rejects a negative balance on update', async () => {
      const wallet = await db.insertWallet();
      await expectViolation(
        db.query("UPDATE wallets SET balance = '-1.00' WHERE id = ?", [
          wallet.id,
        ]),
        check('wallets_balance_non_negative_ck'),
      );
    });

    it.each([[0], [-1]])('rejects version %p', async (version) => {
      await expectViolation(
        db.insertWallet({ version }),
        check('wallets_version_ck'),
      );
    });

    it.each([['brl'], ['BR'], ['BRLX'], ['']])(
      'rejects invalid currency %p',
      async (currency) => {
        await expectViolation(
          db.insertWallet({ currency }),
          check('currency_code_format_ck'),
        );
      },
    );

    it('rejects a blank player id', async () => {
      await expectViolation(
        db.insertWallet({ player_id: '   ' }),
        check('identifier_not_blank_ck'),
      );
    });

    it('rejects updated_at before created_at', async () => {
      await expectViolation(
        db.insertWallet({ created_at: T1, updated_at: T0 }),
        check('wallets_updated_after_created_ck'),
      );
    });
  });

  describe('exact money values', () => {
    it.each([['0.00'], ['0.01'], ['1000.50'], [MAX]])(
      'stores %p exactly and returns it as a string',
      async (balance) => {
        const wallet = await db.insertWallet({ balance });
        const [stored] = await db.query(
          'SELECT balance FROM wallets WHERE id = ?',
          [wallet.id],
        );
        expect(stored?.balance).toBe(balance);
        expect(typeof stored?.balance).toBe('string');
      },
    );

    it('keeps decimal arithmetic exact', async () => {
      const [row] = await db.query(
        "SELECT ('0.10'::money_amount + '0.20'::money_amount)::text AS total",
      );
      expect(row?.total).toBe('0.30');
    });

    it.each([['1.005'], ['10'], ['10.5'], ['1e2'], ['0.001']])(
      'rejects %p instead of rounding it',
      async (balance) => {
        await expectViolation(
          db.insertWallet({ balance }),
          check('money_amount_scale_ck'),
        );
      },
    );

    it('rejects values beyond the Money range', async () => {
      await expectViolation(
        db.insertWallet({ balance: '1000000000000000000.00' }),
        check('money_amount_range_ck'),
      );
    });
  });

  describe('wager_transactions', () => {
    it('accepts a valid pending BET', async () => {
      const wallet = await db.insertWallet();
      await db.insertTransaction(wallet);
    });

    it('rejects a duplicate (provider, external transaction id)', async () => {
      const wallet = await db.insertWallet();
      const first = await db.insertTransaction(wallet);
      await expectViolation(
        db.insertTransaction(wallet, {
          external_transaction_id: first.external_transaction_id ?? null,
        }),
        unique('wager_tx_provider_external_uq'),
      );
    });

    it('allows the same external transaction id for another provider', async () => {
      const wallet = await db.insertWallet();
      const first = await db.insertTransaction(wallet);
      await db.insertTransaction(wallet, {
        provider_id: 'provider-b',
        external_transaction_id: first.external_transaction_id ?? null,
      });
    });

    it('rejects a duplicate idempotency key for the same provider', async () => {
      const wallet = await db.insertWallet();
      const first = await db.insertTransaction(wallet);
      await expectViolation(
        db.insertTransaction(wallet, {
          idempotency_key: first.idempotency_key ?? null,
        }),
        unique('wager_tx_provider_idempotency_uq'),
      );
    });

    it('scopes idempotency keys by provider', async () => {
      const wallet = await db.insertWallet();
      const first = await db.insertTransaction(wallet);
      await db.insertTransaction(wallet, {
        provider_id: 'provider-b',
        idempotency_key: first.idempotency_key ?? null,
      });
    });

    it.each([
      ['unknown kind', { kind: 'JACKPOT' }, 'wager_tx_kind_ck'],
      ['unknown status', { status: 'DONE' }, 'wager_tx_status_ck'],
      [
        'unknown failure code',
        { status: 'REJECTED', failure_code: 'OOPS' },
        'wager_tx_failure_code_ck',
      ],
      [
        'PROCESSED without processed_at',
        { status: 'PROCESSED', result_balance: '75.00' },
        'wager_tx_processed_at_ck',
      ],
      [
        'PENDING with processed_at',
        { processed_at: T1 },
        'wager_tx_processed_at_ck',
      ],
      [
        'PROCESSED without result balance',
        { status: 'PROCESSED', processed_at: T1 },
        'wager_tx_processed_result_ck',
      ],
      [
        'REJECTED without failure code',
        { status: 'REJECTED' },
        'wager_tx_failure_code_status_ck',
      ],
      [
        'FAILED without failure code',
        { status: 'FAILED' },
        'wager_tx_failure_code_status_ck',
      ],
      [
        'PENDING with failure code',
        { failure_code: 'INSUFFICIENT_FUNDS' },
        'wager_tx_failure_code_status_ck',
      ],
      [
        'PROCESSED with failure code',
        { ...processed(), failure_code: 'INSUFFICIENT_FUNDS' },
        'wager_tx_failure_code_status_ck',
      ],
      [
        'processed before created',
        { ...processed(), created_at: T1, processed_at: T0 },
        'wager_tx_processed_after_created_ck',
      ],
      ['BET with zero amount', { amount: '0.00' }, 'wager_tx_amount_ck'],
      [
        'negative attempts',
        { reference_attempts: -1 },
        'wager_tx_reference_attempts_ck',
      ],
      [
        'negative result balance',
        { ...processed('75.00'), result_balance: '-1.00' },
        'wager_tx_result_balance_ck',
      ],
      ['invalid payload hash', { payload_hash: 'XYZ' }, 'sha256_hex_format_ck'],
      ['blank round id', { round_id: ' ' }, 'identifier_not_blank_ck'],
    ] as const)('rejects %s', async (_label, overrides, constraint) => {
      const wallet = await db.insertWallet();
      await expectViolation(
        db.insertTransaction(wallet, overrides),
        check(constraint),
      );
    });

    it('accepts LOSS with zero amount', async () => {
      const wallet = await db.insertWallet();
      await db.insertTransaction(wallet, {
        kind: 'LOSS',
        amount: '0.00',
        ...processed('100.00'),
      });
    });

    it.each([['REFUND'], ['ROLLBACK']])(
      'rejects %s without reference',
      async (kind) => {
        const wallet = await db.insertWallet();
        await expectViolation(
          db.insertTransaction(wallet, { kind }),
          check('wager_tx_reference_required_ck'),
        );
      },
    );

    it.each([['BET'], ['LOSS'], ['OPENING']])(
      'rejects %s with reference',
      async (kind) => {
        const wallet = await db.insertWallet();
        await expectViolation(
          db.insertTransaction(wallet, {
            kind,
            reference_external_transaction_id: 'ext-other',
          }),
          check('wager_tx_reference_forbidden_ck'),
        );
      },
    );

    it('rejects a transaction referencing itself', async () => {
      const wallet = await db.insertWallet();
      await expectViolation(
        db.insertTransaction(wallet, {
          kind: 'REFUND',
          external_transaction_id: 'ext-self',
          reference_external_transaction_id: 'ext-self',
        }),
        check('wager_tx_not_self_reference_ck'),
      );
    });

    it('rejects PENDING_REFERENCE without retry schedule', async () => {
      const wallet = await db.insertWallet();
      await expectViolation(
        db.insertTransaction(wallet, {
          kind: 'REFUND',
          status: 'PENDING_REFERENCE',
          reference_external_transaction_id: 'ext-missing',
        }),
        check('wager_tx_pending_reference_ck'),
      );
    });

    it('accepts PENDING_REFERENCE for a reference that does not exist yet', async () => {
      const wallet = await db.insertWallet();
      await db.insertTransaction(wallet, {
        kind: 'REFUND',
        status: 'PENDING_REFERENCE',
        reference_external_transaction_id: 'ext-arrives-later',
        next_reference_attempt_at: T1,
      });
    });

    it('rejects a PROCESSED reversal without resolved internal reference', async () => {
      const wallet = await db.insertWallet();
      await expectViolation(
        db.insertTransaction(wallet, {
          kind: 'REFUND',
          reference_external_transaction_id: 'ext-x',
          ...processed('125.00'),
        }),
        check('wager_tx_processed_reference_ck'),
      );
    });

    it('rejects an internal reference without external reference', async () => {
      const wallet = await db.insertWallet();
      const bet = await processedBet(wallet);
      await expectViolation(
        db.insertTransaction(wallet, {
          kind: 'WIN',
          reference_transaction_id: bet.id ?? null,
        }),
        check('wager_tx_resolved_reference_ck'),
      );
    });
  });

  describe('transaction references', () => {
    it('accepts a reversal in the same provider, player, wallet, currency and round', async () => {
      const wallet = await db.insertWallet();
      const bet = await processedBet(wallet);
      await db.insertTransaction(wallet, {
        kind: 'REFUND',
        reference_external_transaction_id: bet.external_transaction_id ?? null,
        reference_transaction_id: bet.id ?? null,
        ...processed('100.00'),
      });
    });

    it('rejects a reference to a missing transaction', async () => {
      const wallet = await db.insertWallet();
      await expectViolation(
        db.insertTransaction(wallet, {
          kind: 'REFUND',
          reference_external_transaction_id: 'ext-ghost',
          reference_transaction_id: randomUUID(),
        }),
        foreignKey('wager_tx_reference_scope_fk'),
      );
    });

    it('rejects an internal reference whose external id does not match', async () => {
      const wallet = await db.insertWallet();
      const bet = await processedBet(wallet);
      await expectViolation(
        db.insertTransaction(wallet, {
          kind: 'REFUND',
          reference_external_transaction_id: 'ext-wrong',
          reference_transaction_id: bet.id ?? null,
        }),
        foreignKey('wager_tx_reference_scope_fk'),
      );
    });

    it.each([
      ['round', { round_id: 'round-2' }],
      ['provider', { provider_id: 'provider-b' }],
    ] as const)(
      'rejects a reference from another %s',
      async (_label, scope) => {
        const wallet = await db.insertWallet();
        const bet = await processedBet(wallet);
        await expectViolation(
          db.insertTransaction(wallet, {
            kind: 'REFUND',
            reference_external_transaction_id:
              bet.external_transaction_id ?? null,
            reference_transaction_id: bet.id ?? null,
            ...scope,
          }),
          foreignKey('wager_tx_reference_scope_fk'),
        );
      },
    );

    it('rejects a reference from another wallet, player or currency', async () => {
      const wallet = await db.insertWallet();
      const other = await db.insertWallet({ currency: 'USD' });
      const bet = await processedBet(wallet);
      await expectViolation(
        db.insertTransaction(other, {
          kind: 'REFUND',
          reference_external_transaction_id:
            bet.external_transaction_id ?? null,
          reference_transaction_id: bet.id ?? null,
        }),
        foreignKey('wager_tx_reference_scope_fk'),
      );
    });
  });

  describe('reversals', () => {
    const reversal = (bet: Row, kind: string, overrides: Row = {}): Row => ({
      kind,
      reference_external_transaction_id: bet.external_transaction_id ?? null,
      reference_transaction_id: bet.id ?? null,
      ...processed('100.00'),
      ...overrides,
    });

    it.each([['REFUND'], ['ROLLBACK']])(
      'rejects a second PROCESSED %s of the same reference',
      async (kind) => {
        const wallet = await db.insertWallet();
        const bet = await processedBet(wallet);
        await db.insertTransaction(wallet, reversal(bet, kind));
        await expectViolation(
          db.insertTransaction(wallet, reversal(bet, kind)),
          unique('wager_tx_single_reversal_uq'),
        );
      },
    );

    it('rejects promoting a second reversal to PROCESSED', async () => {
      const wallet = await db.insertWallet();
      const bet = await processedBet(wallet);
      await db.insertTransaction(wallet, reversal(bet, 'REFUND'));
      const second = await db.insertTransaction(wallet, {
        kind: 'REFUND',
        reference_external_transaction_id: bet.external_transaction_id ?? null,
        status: 'PENDING_REFERENCE',
        next_reference_attempt_at: T1,
      });
      await expectViolation(
        db.query(
          `UPDATE wager_transactions
           SET status = 'PROCESSED', processed_at = ?, result_balance = '100.00',
               reference_transaction_id = ?, next_reference_attempt_at = NULL
           WHERE id = ?`,
          [T1, bet.id, second.id],
        ),
        unique('wager_tx_single_reversal_uq'),
      );
    });

    it('allows pending reversals that are not resolved yet', async () => {
      const wallet = await db.insertWallet();
      const pending = {
        kind: 'REFUND',
        reference_external_transaction_id: 'ext-future-bet',
        status: 'PENDING_REFERENCE',
        next_reference_attempt_at: T1,
      };
      await db.insertTransaction(wallet, pending);
      await db.insertTransaction(wallet, pending);
    });

    it('keeps rejected duplicate reversals auditable', async () => {
      const wallet = await db.insertWallet();
      const bet = await processedBet(wallet);
      await db.insertTransaction(wallet, reversal(bet, 'REFUND'));
      await db.insertTransaction(
        wallet,
        reversal(bet, 'REFUND', {
          status: 'REJECTED',
          failure_code: 'ALREADY_REVERSED',
          processed_at: null,
          result_balance: null,
        }),
      );
    });

    it.each([
      ['REFUND', 'ROLLBACK'],
      ['ROLLBACK', 'REFUND'],
    ])(
      'rejects %s followed by %s of the same BET (double credit)',
      async (first, second) => {
        const wallet = await db.insertWallet();
        const bet = await processedBet(wallet);
        await db.insertTransaction(wallet, reversal(bet, first));
        await expectViolation(
          db.insertTransaction(wallet, reversal(bet, second)),
          unique('wager_tx_single_reversal_uq'),
        );
      },
    );

    it('allows ROLLBACK of a REFUND after the BET was refunded', async () => {
      const wallet = await db.insertWallet();
      const bet = await processedBet(wallet);
      const refund = await db.insertTransaction(
        wallet,
        reversal(bet, 'REFUND'),
      );
      await db.insertTransaction(
        wallet,
        reversal(refund, 'ROLLBACK', processed('75.00')),
      );
    });

    it('allows a single ROLLBACK of a WIN', async () => {
      const wallet = await db.insertWallet();
      const win = await db.insertTransaction(wallet, {
        kind: 'WIN',
        ...processed('125.00'),
      });
      await db.insertTransaction(
        wallet,
        reversal(win, 'ROLLBACK', processed('100.00')),
      );
      await expectViolation(
        db.insertTransaction(
          wallet,
          reversal(win, 'ROLLBACK', processed('100.00')),
        ),
        unique('wager_tx_single_reversal_uq'),
      );
    });

    it('does not count WIN references to a BET as reversals', async () => {
      const wallet = await db.insertWallet();
      const bet = await processedBet(wallet);
      const win = {
        kind: 'WIN',
        reference_external_transaction_id: bet.external_transaction_id ?? null,
        reference_transaction_id: bet.id ?? null,
        ...processed('125.00'),
      };
      await db.insertTransaction(wallet, win);
      await db.insertTransaction(wallet, win);
      await db.insertTransaction(wallet, reversal(bet, 'REFUND'));
    });
  });

  describe('wallet link', () => {
    const missingWallet = () => walletRow();

    it.each([
      ['a pending BET', {}],
      ['a processed LOSS', { kind: 'LOSS', ...processed('100.00') }],
      [
        'a BET rejected for insufficient funds',
        { status: 'REJECTED', failure_code: 'INSUFFICIENT_FUNDS' },
      ],
    ] as const)(
      'rejects %s for a missing wallet',
      async (_label, overrides) => {
        await expectViolation(
          db.insertTransaction(missingWallet(), overrides),
          foreignKey('wager_tx_wallet_fk'),
        );
      },
    );

    it('rejects a transaction for a player that does not own the wallet', async () => {
      const wallet = await db.insertWallet();
      await expectViolation(
        db.insertTransaction(wallet, { player_id: 'player-intruder' }),
        foreignKey('wager_tx_wallet_fk'),
      );
    });

    it('rejects a transaction in a currency other than the wallet', async () => {
      const wallet = await db.insertWallet();
      await expectViolation(
        db.insertTransaction(wallet, { currency: 'USD' }),
        foreignKey('wager_tx_wallet_fk'),
      );
    });

    it('keeps WALLET_NOT_FOUND rejections auditable', async () => {
      const transaction = await db.insertTransaction(missingWallet(), {
        status: 'REJECTED',
        failure_code: 'WALLET_NOT_FOUND',
      });
      const [stored] = await db.query(
        'SELECT wallet_id, wallet_link_id FROM wager_transactions WHERE id = ?',
        [transaction.id],
      );
      expect(stored).toEqual({
        wallet_id: transaction.wallet_id ?? null,
        wallet_link_id: null,
      });
    });

    it.each([
      ['WALLET_PLAYER_MISMATCH', { player_id: 'player-intruder' }],
      ['CURRENCY_MISMATCH', { currency: 'USD' }],
    ] as const)(
      'keeps %s rejections auditable',
      async (failureCode, overrides) => {
        const wallet = await db.insertWallet();
        await db.insertTransaction(wallet, {
          status: 'REJECTED',
          failure_code: failureCode,
          ...overrides,
        });
      },
    );

    it('links every other transaction to its wallet', async () => {
      const wallet = await db.insertWallet();
      const loss = await db.insertTransaction(wallet, {
        kind: 'LOSS',
        ...processed('100.00'),
      });
      const [stored] = await db.query(
        'SELECT wallet_link_id FROM wager_transactions WHERE id = ?',
        [loss.id],
      );
      expect(stored?.wallet_link_id).toBe(wallet.id ?? null);
    });

    it('does not allow writing the generated link directly', async () => {
      const wallet = await db.insertWallet();
      await expectViolation(
        db.insertTransaction(walletRow(), {
          status: 'REJECTED',
          failure_code: 'WALLET_NOT_FOUND',
          wallet_link_id: wallet.id ?? null,
        }),
        { code: '428C9' },
      );
    });

    it('blocks deleting a wallet that has transactions', async () => {
      const wallet = await db.insertWallet();
      await db.insertTransaction(wallet);
      await expectViolation(
        db.query('DELETE FROM wallets WHERE id = ?', [wallet.id]),
        foreignKey('wager_tx_wallet_fk'),
      );
    });
  });

  describe('wallet_ledger_entries', () => {
    it('accepts a balanced DEBIT and CREDIT', async () => {
      const wallet = await db.insertWallet();
      const bet = await processedBet(wallet);
      await db.insertLedger(wallet, bet);
      const win = await db.insertTransaction(wallet, {
        kind: 'WIN',
        amount: '50.00',
        ...processed('125.00'),
      });
      await db.insertLedger(wallet, win, {
        direction: 'CREDIT',
        amount: '50.00',
        balance_before: '75.00',
        balance_after: '125.00',
      });
    });

    it('rejects a second entry for the same wallet and transaction', async () => {
      const wallet = await db.insertWallet();
      const bet = await processedBet(wallet);
      await db.insertLedger(wallet, bet);
      await expectViolation(
        db.insertLedger(wallet, bet),
        unique('ledger_wallet_transaction_uq'),
      );
    });

    it.each([
      [
        'CREDIT off by one cent',
        { direction: 'CREDIT', balance_after: '125.01' },
      ],
      [
        'CREDIT recorded as debit',
        { direction: 'CREDIT', balance_after: '75.00' },
      ],
      ['DEBIT off by one cent', { balance_after: '75.01' }],
      ['unchanged balance', { balance_after: '100.00' }],
    ] as const)(
      'rejects inconsistent arithmetic: %s',
      async (_label, overrides) => {
        const wallet = await db.insertWallet();
        const bet = await processedBet(wallet);
        await expectViolation(
          db.insertLedger(wallet, bet, overrides),
          check('ledger_arithmetic_ck'),
        );
      },
    );

    it('rejects a negative balance after', async () => {
      const wallet = await db.insertWallet({ balance: '10.00' });
      const bet = await processedBet(wallet, { result_balance: '0.00' });
      await expectViolation(
        db.insertLedger(wallet, bet, {
          balance_before: '10.00',
          balance_after: '-15.00',
        }),
        check('ledger_balance_after_non_negative_ck'),
      );
    });

    it('rejects a negative balance before', async () => {
      const wallet = await db.insertWallet();
      const bet = await processedBet(wallet);
      await expectViolation(
        db.insertLedger(wallet, bet, {
          direction: 'CREDIT',
          balance_before: '-5.00',
          balance_after: '20.00',
        }),
        check('ledger_balance_before_non_negative_ck'),
      );
    });

    it.each([
      ['zero amount', { amount: '0.00', balance_after: '100.00' }],
      ['negative amount', { amount: '-25.00', balance_after: '125.00' }],
    ] as const)('rejects %s', async (_label, overrides) => {
      const wallet = await db.insertWallet();
      const bet = await processedBet(wallet);
      await expectViolation(
        db.insertLedger(wallet, bet, overrides),
        check('ledger_amount_positive_ck'),
      );
    });

    it('rejects an unknown direction', async () => {
      const wallet = await db.insertWallet();
      const bet = await processedBet(wallet);
      await expectViolation(
        db.insertLedger(wallet, bet, { direction: 'SIDEWAYS' }),
        check('ledger_direction_ck'),
      );
    });

    it('rejects an entry in a currency different from the wallet', async () => {
      const wallet = await db.insertWallet();
      const bet = await processedBet(wallet);
      await expectViolation(
        db.insertLedger(wallet, bet, { currency: 'USD' }),
        foreignKey('ledger_wallet_fk'),
      );
    });

    it('rejects an entry for a missing wallet', async () => {
      const wallet = await db.insertWallet();
      const bet = await processedBet(wallet);
      await expectViolation(
        db.insertLedger(walletRow(), bet),
        foreignKey('ledger_wallet_fk'),
      );
    });

    it('rejects an entry for a missing transaction', async () => {
      const wallet = await db.insertWallet();
      await expectViolation(
        db.insertLedger(wallet, transactionRow(wallet)),
        foreignKey('ledger_transaction_fk'),
      );
    });

    it('rejects an entry whose transaction belongs to another wallet', async () => {
      const wallet = await db.insertWallet();
      const other = await db.insertWallet();
      const bet = await processedBet(other);
      await expectViolation(
        db.insertLedger(wallet, bet),
        foreignKey('ledger_transaction_fk'),
      );
    });

    it('blocks UPDATE of ledger entries', async () => {
      const wallet = await db.insertWallet();
      const bet = await processedBet(wallet);
      const entry = await db.insertLedger(wallet, bet);
      await expectViolation(
        db.query(
          "UPDATE wallet_ledger_entries SET created_at = created_at + interval '1 second' WHERE id = ?",
          [entry.id],
        ),
        { code: SQLSTATE.restrictViolation, message: 'append-only: UPDATE' },
      );
    });

    it('blocks DELETE of ledger entries', async () => {
      const wallet = await db.insertWallet();
      const bet = await processedBet(wallet);
      const entry = await db.insertLedger(wallet, bet);
      await expectViolation(
        db.query('DELETE FROM wallet_ledger_entries WHERE id = ?', [entry.id]),
        { code: SQLSTATE.restrictViolation, message: 'append-only: DELETE' },
      );
      const remaining = await db.query(
        'SELECT 1 FROM wallet_ledger_entries WHERE id = ?',
        [entry.id],
      );
      expect(remaining).toHaveLength(1);
    });

    it('blocks TRUNCATE of the ledger', async () => {
      await expectViolation(db.query('TRUNCATE wallet_ledger_entries'), {
        code: SQLSTATE.restrictViolation,
        message: 'append-only: TRUNCATE',
      });
    });

    it('blocks deleting a wallet or transaction that has ledger entries', async () => {
      const wallet = await db.insertWallet();
      const bet = await processedBet(wallet);
      await db.insertLedger(wallet, bet);
      await expectViolation(
        db.query('DELETE FROM wager_transactions WHERE id = ?', [bet.id]),
        foreignKey('ledger_transaction_fk'),
      );
      await expectViolation(
        db.query('DELETE FROM wallets WHERE id = ?', [wallet.id]),
        foreignKey('ledger_wallet_fk'),
      );
    });

    it('rebuilds the wallet balance from the ledger exactly', async () => {
      const wallet = await db.insertWallet({ balance: '0.00' });
      const movements = [
        ['CREDIT', '0.10', '0.00', '0.10'],
        ['CREDIT', '0.20', '0.10', '0.30'],
        ['DEBIT', '0.30', '0.30', '0.00'],
        ['CREDIT', MAX, '0.00', MAX],
      ] as const;
      for (const [direction, amount, before, after] of movements) {
        const transaction = await db.insertTransaction(wallet, {
          kind: direction === 'CREDIT' ? 'WIN' : 'BET',
          amount,
          ...processed(after),
        });
        await db.insertLedger(wallet, transaction, {
          direction,
          amount,
          balance_before: before,
          balance_after: after,
        });
      }
      const [row] = await db.query(
        `SELECT SUM(CASE direction WHEN 'CREDIT' THEN amount ELSE -amount END)::text AS total
         FROM wallet_ledger_entries WHERE wallet_id = ?`,
        [wallet.id],
      );
      expect(row?.total).toBe(MAX);
    });
  });
});
