import type { StoredWagerTransaction } from '../../../application/ports/persistence.js';
import type { WagerTransactionResult } from '../../../application/wagering/wager-transaction-result.js';
import type {
  LedgerPage,
  ReconciliationReport,
} from '../../../application/wallets/wallet-queries.js';
import type { WalletLedgerEntry } from '../../../domain/ledger/wallet-ledger-entry.js';
import type { MoneyProps } from '../../../domain/money/money.js';
import type { Wallet } from '../../../domain/wallet/wallet.js';

export interface WalletResponse {
  id: string;
  playerId: string;
  balance: MoneyProps;
  version: number;
}

export interface SubmitWagerTransactionResponse {
  transactionId: string;
  status: string;
  balance: MoneyProps | null;
  failureCode?: string;
  idempotentReplay: boolean;
}

export interface WagerTransactionResponse {
  transactionId: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: string;
  money: MoneyProps;
  status: string;
  failureCode: string | null;
  referenceExternalTransactionId: string | null;
  referenceTransactionId: string | null;
  balance: MoneyProps | null;
  createdAt: string;
  processedAt: string | null;
}

export interface LedgerEntryResponse {
  id: string;
  transactionId: string;
  direction: string;
  money: MoneyProps;
  balanceBefore: MoneyProps;
  balanceAfter: MoneyProps;
  createdAt: string;
}

export interface LedgerPageResponse {
  walletId: string;
  entries: LedgerEntryResponse[];
  nextCursor: string | null;
}

export interface ReconciliationResponse {
  walletId: string;
  storedBalance: MoneyProps;
  calculatedBalance: MoneyProps;
  difference: MoneyProps;
  consistent: boolean;
  checkedEntries: number;
}

export function presentWallet(wallet: Wallet): WalletResponse {
  return {
    id: wallet.id,
    playerId: wallet.playerId,
    balance: wallet.balance.toJSON(),
    version: wallet.version,
  };
}

export function presentSubmission(
  result: WagerTransactionResult,
): SubmitWagerTransactionResponse {
  const response: SubmitWagerTransactionResponse = {
    transactionId: result.transactionId,
    status: result.status,
    balance: result.balance?.toJSON() ?? null,
    idempotentReplay: result.idempotentReplay,
  };
  if (result.failureCode !== undefined) {
    response.failureCode = result.failureCode;
  }
  return response;
}

export function presentTransaction(
  stored: StoredWagerTransaction,
): WagerTransactionResponse {
  const { transaction } = stored;
  return {
    transactionId: transaction.id,
    providerId: transaction.providerId,
    externalTransactionId: transaction.externalTransactionId,
    idempotencyKey: transaction.idempotencyKey,
    walletId: transaction.walletId,
    playerId: transaction.playerId,
    roundId: transaction.roundId,
    gameId: transaction.gameId,
    kind: transaction.kind,
    money: transaction.money.toJSON(),
    status: transaction.status,
    failureCode: transaction.failureCode ?? null,
    referenceExternalTransactionId:
      transaction.referenceExternalTransactionId ?? null,
    referenceTransactionId: transaction.referenceTransactionId ?? null,
    balance: stored.resultBalance?.toJSON() ?? null,
    createdAt: transaction.createdAt.toISOString(),
    processedAt: transaction.processedAt?.toISOString() ?? null,
  };
}

function presentLedgerEntry(entry: WalletLedgerEntry): LedgerEntryResponse {
  return {
    id: entry.id,
    transactionId: entry.transactionId,
    direction: entry.direction,
    money: entry.money.toJSON(),
    balanceBefore: entry.balanceBefore.toJSON(),
    balanceAfter: entry.balanceAfter.toJSON(),
    createdAt: entry.createdAt.toISOString(),
  };
}

export function presentLedgerPage(page: LedgerPage): LedgerPageResponse {
  return {
    walletId: page.walletId,
    entries: page.entries.map(presentLedgerEntry),
    nextCursor: page.nextCursor ?? null,
  };
}

export function presentReconciliation(
  report: ReconciliationReport,
): ReconciliationResponse {
  return {
    walletId: report.walletId,
    storedBalance: report.storedBalance.toJSON(),
    calculatedBalance: report.calculatedBalance.toJSON(),
    difference: report.difference.toJSON(),
    consistent: report.consistent,
    checkedEntries: report.checkedEntries,
  };
}
