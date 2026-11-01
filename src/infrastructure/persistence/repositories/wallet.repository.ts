import type { EntityDictionary, EntityManager } from '@mikro-orm/postgresql';
import { ConcurrencyConflictError } from '../../../application/ports/persistence.errors.js';
import type { WalletRepository } from '../../../application/ports/persistence.js';
import type { Wallet } from '../../../domain/wallet/wallet.js';
import { fromWallet, toWallet } from '../mappers.js';
import { WalletSchema, type WalletRecord } from '../schemas.js';

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
