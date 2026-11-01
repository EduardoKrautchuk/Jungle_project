import type { EntityDictionary, EntityManager } from '@mikro-orm/postgresql';
import { ConcurrencyConflictError } from '../../../application/ports/persistence.errors.js';
import type {
  WalletBalanceSnapshot,
  WalletRepository,
} from '../../../application/ports/persistence.js';
import { Money } from '../../../domain/money/money.js';
import type { Wallet } from '../../../domain/wallet/wallet.js';
import { fromWallet, toWallet } from '../mappers.js';
import { WalletSchema, type WalletRecord } from '../schemas.js';

interface LedgerTotals {
  ledger_balance: string;
  ledger_entries: number;
}

export class MikroOrmWalletRepository implements WalletRepository {
  constructor(private readonly em: EntityManager) {}

  async findById(id: string): Promise<Wallet | undefined> {
    const record = await this.em.findOne(
      WalletSchema,
      { id },
      { disableIdentityMap: true },
    );
    return record ? toWallet(record) : undefined;
  }

  async findBalanceSnapshot(
    id: string,
  ): Promise<WalletBalanceSnapshot | undefined> {
    const [row] = await this.em.execute<
      (EntityDictionary<WalletRecord> & LedgerTotals)[]
    >(
      `SELECT w.*, totals.ledger_balance, totals.ledger_entries
         FROM wallets w
         CROSS JOIN LATERAL (
           SELECT
             round(coalesce(sum(CASE WHEN direction = 'CREDIT' THEN amount ELSE -amount END), 0), 2)::text AS ledger_balance,
             count(*)::integer AS ledger_entries
           FROM wallet_ledger_entries
           WHERE wallet_id = w.id
         ) totals
        WHERE w.id = ?`,
      [id],
    );
    if (row === undefined) {
      return undefined;
    }
    const wallet = toWallet(this.em.map(WalletSchema, row));
    return {
      wallet,
      ledgerBalance: signedMoney(row.ledger_balance, wallet.currency),
      ledgerEntries: row.ledger_entries,
    };
  }

  async findByIdForUpdate(id: string): Promise<Wallet | undefined> {
    const [row] = await this.em.execute<EntityDictionary<WalletRecord>[]>(
      'SELECT * FROM wallets WHERE id = ? FOR NO KEY UPDATE',
      [id],
    );
    return row ? toWallet(this.em.map(WalletSchema, row)) : undefined;
  }

  async findByPlayerAndCurrency(
    playerId: string,
    currency: string,
  ): Promise<Wallet | undefined> {
    const record = await this.em.findOne(
      WalletSchema,
      { playerId, currency },
      { disableIdentityMap: true },
    );
    return record ? toWallet(record) : undefined;
  }

  async insert(wallet: Wallet): Promise<void> {
    await this.em.insert(WalletSchema, fromWallet(wallet));
  }

  async update(wallet: Wallet, expectedVersion: number): Promise<void> {
    const record = fromWallet(wallet);
    const affected = await this.em.nativeUpdate(
      WalletSchema,
      { id: wallet.id, version: expectedVersion },
      {
        balance: record.balance,
        version: record.version,
        updatedAt: record.updatedAt,
      },
    );
    if (affected !== 1) {
      throw new ConcurrencyConflictError(
        `wallet ${wallet.id} is no longer at version ${expectedVersion}`,
      );
    }
  }
}

function signedMoney(amount: string, currency: string): Money {
  return amount.startsWith('-')
    ? Money.from({ amount: amount.slice(1), currency }).negate()
    : Money.from({ amount, currency });
}
