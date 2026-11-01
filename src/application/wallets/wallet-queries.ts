import type { WalletLedgerEntry } from '../../domain/ledger/wallet-ledger-entry.js';
import type { Money } from '../../domain/money/money.js';
import type { Wallet } from '../../domain/wallet/wallet.js';
import { WalletNotFoundError } from '../application.errors.js';
import type { UnitOfWork } from '../ports/persistence.js';
import { decodeLedgerCursor, encodeLedgerCursor } from './ledger-cursor.js';

export interface LedgerPage {
  readonly walletId: string;
  readonly entries: readonly WalletLedgerEntry[];
  readonly nextCursor: string | undefined;
}

export interface ReconciliationReport {
  readonly walletId: string;
  readonly storedBalance: Money;
  readonly calculatedBalance: Money;
  readonly difference: Money;
  readonly consistent: boolean;
  readonly checkedEntries: number;
}

export class WalletQueries {
  constructor(private readonly uow: UnitOfWork) {}

  async getWallet(walletId: string): Promise<Wallet> {
    const wallet = await this.uow.run((repositories) =>
      repositories.wallets.findById(walletId),
    );
    if (wallet === undefined) {
      throw new WalletNotFoundError();
    }
    return wallet;
  }

  async listLedger(
    walletId: string,
    page: { cursor: string | undefined; limit: number },
  ): Promise<LedgerPage> {
    const after =
      page.cursor === undefined ? undefined : decodeLedgerCursor(page.cursor);
    const { wallet, entries } = await this.uow.run(async (repositories) => ({
      wallet: await repositories.wallets.findById(walletId),
      entries: await repositories.ledger.listByWallet(walletId, {
        after,
        limit: page.limit + 1,
      }),
    }));
    if (wallet === undefined) {
      throw new WalletNotFoundError();
    }
    const visible = entries.slice(0, page.limit);
    const last = visible.at(-1);
    return {
      walletId,
      entries: visible,
      nextCursor:
        entries.length > page.limit && last !== undefined
          ? encodeLedgerCursor({ createdAt: last.createdAt, id: last.id })
          : undefined,
    };
  }

  async reconcile(walletId: string): Promise<ReconciliationReport> {
    const snapshot = await this.uow.run((repositories) =>
      repositories.wallets.findBalanceSnapshot(walletId),
    );
    if (snapshot === undefined) {
      throw new WalletNotFoundError();
    }
    const storedBalance = snapshot.wallet.balance;
    const calculatedBalance = snapshot.ledgerBalance;
    const difference = storedBalance.subtract(calculatedBalance);
    return {
      walletId,
      storedBalance,
      calculatedBalance,
      difference,
      consistent: difference.isZero(),
      checkedEntries: snapshot.ledgerEntries,
    };
  }
}
