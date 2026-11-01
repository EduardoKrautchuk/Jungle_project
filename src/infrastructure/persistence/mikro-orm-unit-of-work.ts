import type { EntityManager } from '@mikro-orm/postgresql';
import type {
  TransactionalRepositories,
  UnitOfWork,
  WalletLockScope,
} from '../../application/ports/persistence.js';
import { translateDatabaseError } from './database-errors.js';
import { MikroOrmInboxRepository } from './repositories/inbox.repository.js';
import { MikroOrmLedgerRepository } from './repositories/ledger.repository.js';
import { MikroOrmOutboxRepository } from './repositories/outbox.repository.js';
import { MikroOrmWagerTransactionRepository } from './repositories/wager-transaction.repository.js';
import { MikroOrmWalletRepository } from './repositories/wallet.repository.js';

export function createRepositories(
  em: EntityManager,
): TransactionalRepositories {
  return {
    wallets: new MikroOrmWalletRepository(em),
    transactions: new MikroOrmWagerTransactionRepository(em),
    ledger: new MikroOrmLedgerRepository(em),
    inbox: new MikroOrmInboxRepository(em),
    outbox: new MikroOrmOutboxRepository(em),
  };
}

export const DEFAULT_LOCK_TIMEOUT_MS = 5_000;

export class MikroOrmUnitOfWork implements UnitOfWork {
  private readonly lockTimeoutMs: number;

  constructor(
    private readonly em: EntityManager,
    options: { lockTimeoutMs?: number } = {},
  ) {
    const lockTimeoutMs = options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
    if (!Number.isSafeInteger(lockTimeoutMs) || lockTimeoutMs <= 0) {
      throw new RangeError('lockTimeoutMs must be a positive integer');
    }
    this.lockTimeoutMs = lockTimeoutMs;
  }

  async run<T>(
    work: (repositories: TransactionalRepositories) => Promise<T>,
  ): Promise<T> {
    return this.transaction((repositories) => work(repositories));
  }

  async runWithWalletLock<T>(
    walletId: string,
    work: (scope: WalletLockScope) => Promise<T>,
  ): Promise<T> {
    return this.transaction(async (repositories) => {
      const wallet = await repositories.wallets.findByIdForUpdate(walletId);
      return work({ wallet, repositories });
    });
  }

  private async transaction<T>(
    work: (repositories: TransactionalRepositories) => Promise<T>,
  ): Promise<T> {
    try {
      return await this.em.fork().transactional(async (em) => {
        await em.execute(`SET LOCAL lock_timeout = ${this.lockTimeoutMs}`);
        return work(createRepositories(em));
      });
    } catch (error) {
      throw translateDatabaseError(error);
    }
  }
}
