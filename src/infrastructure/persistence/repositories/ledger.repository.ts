import type { EntityManager, FilterQuery } from '@mikro-orm/postgresql';
import type {
  LedgerCursor,
  LedgerRepository,
} from '../../../application/ports/persistence.js';
import type { WalletLedgerEntry } from '../../../domain/ledger/wallet-ledger-entry.js';
import { fromLedgerEntry, toLedgerEntry } from '../mappers.js';
import { LedgerEntrySchema, type LedgerEntryRecord } from '../schemas.js';

export class MikroOrmLedgerRepository implements LedgerRepository {
  constructor(private readonly em: EntityManager) {}

  async append(entry: WalletLedgerEntry): Promise<void> {
    await this.em.insert(LedgerEntrySchema, fromLedgerEntry(entry));
  }

  async findByWalletAndTransaction(
    walletId: string,
    transactionId: string,
  ): Promise<WalletLedgerEntry | undefined> {
    const record = await this.em.findOne(
      LedgerEntrySchema,
      { walletId, transactionId },
      { disableIdentityMap: true },
    );
    return record ? toLedgerEntry(record) : undefined;
  }

  async listByWallet(
    walletId: string,
    page: { after?: LedgerCursor; limit: number },
  ): Promise<WalletLedgerEntry[]> {
    const where: FilterQuery<LedgerEntryRecord> = page.after
      ? {
          walletId,
          $or: [
            { createdAt: { $gt: page.after.createdAt } },
            { createdAt: page.after.createdAt, id: { $gt: page.after.id } },
          ],
        }
      : { walletId };
    const records = await this.em.find(LedgerEntrySchema, where, {
      orderBy: { createdAt: 'asc', id: 'asc' },
      limit: page.limit,
      disableIdentityMap: true,
    });
    return records.map(toLedgerEntry);
  }
}
