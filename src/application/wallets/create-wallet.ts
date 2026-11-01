import { OutboxMessage } from '../../domain/messaging/outbox-message.js';
import { MoneyError } from '../../domain/money/money.errors.js';
import { Money, type MoneyProps } from '../../domain/money/money.js';
import { WagerTransactionKind } from '../../domain/wagering/wager-transaction.enums.js';
import { WagerTransaction } from '../../domain/wagering/wager-transaction.js';
import { WalletError } from '../../domain/wallet/wallet.errors.js';
import { Wallet } from '../../domain/wallet/wallet.js';
import {
  InvalidRequestError,
  WalletAlreadyExistsError,
} from '../application.errors.js';
import {
  WagerTransactionProcessed,
  WalletBalanceChanged,
} from '../events/wagering-events.js';
import { canonicalJson, sha256Hex } from '../idempotency/canonical-json.js';
import { UniqueConstraintViolationError } from '../ports/persistence.errors.js';
import type { UnitOfWork } from '../ports/persistence.js';
import type { Clock, IdGenerator } from '../ports/runtime.js';
import { eventContext } from '../wagering/wager-settlement.js';

export const OPENING_PROVIDER_ID = '_internal';
const OPENING_ROUND_ID = 'wallet-opening';
const OPENING_GAME_ID = 'wallet';
const WALLET_PLAYER_CURRENCY_CONSTRAINT = 'wallets_player_currency_uq';

export interface CreateWalletCommand {
  readonly playerId: string;
  readonly initialBalance: MoneyProps;
  readonly correlationId: string;
}

export class CreateWallet {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
  ) {}

  async execute(command: CreateWalletCommand): Promise<Wallet> {
    const initialBalance = parseInitialBalance(command.initialBalance);
    const now = this.clock.now();
    const walletId = this.ids.next();
    const openingId = this.ids.next();
    const opening = initialBalance.isPositive()
      ? { entryId: this.ids.next(), transactionId: openingId }
      : undefined;

    let opened: ReturnType<typeof Wallet.open>;
    try {
      opened = Wallet.open({
        id: walletId,
        playerId: command.playerId,
        initialBalance,
        at: now,
        opening,
      });
    } catch (error) {
      if (error instanceof WalletError) {
        throw new InvalidRequestError([
          { field: 'body', code: error.code, message: error.message },
        ]);
      }
      throw error;
    }
    const { wallet, openingEntry } = opened;
    const context = { now, correlationId: command.correlationId };

    try {
      await this.uow.run(async (repositories) => {
        await repositories.wallets.insert(wallet);
        if (openingEntry === undefined) {
          return;
        }
        const externalTransactionId = `opening:${walletId}`;
        const transaction = WagerTransaction.create({
          id: openingId,
          providerId: OPENING_PROVIDER_ID,
          externalTransactionId,
          idempotencyKey: externalTransactionId,
          payloadHash: sha256Hex(
            canonicalJson({
              walletId,
              playerId: wallet.playerId,
              initialBalance: {
                amount: initialBalance.toJSON().amount,
                currency: initialBalance.currency,
              },
            }),
          ),
          walletId,
          playerId: wallet.playerId,
          roundId: OPENING_ROUND_ID,
          gameId: OPENING_GAME_ID,
          kind: WagerTransactionKind.Opening,
          money: initialBalance,
          createdAt: now,
        });
        transaction.markProcessed(undefined, now);
        await repositories.transactions.insert({
          transaction,
          resultBalance: wallet.balance,
          referenceAttempts: 0,
          nextReferenceAttemptAt: undefined,
        });
        await repositories.ledger.append(openingEntry);
        await repositories.outbox.enqueue(
          OutboxMessage.enqueue(
            WagerTransactionProcessed.from(
              transaction,
              wallet.balance.toJSON(),
              now,
              eventContext(this.ids, context),
            ),
          ),
        );
        await repositories.outbox.enqueue(
          OutboxMessage.enqueue(
            WalletBalanceChanged.from(
              wallet,
              openingEntry,
              eventContext(this.ids, context),
            ),
          ),
        );
      });
    } catch (error) {
      if (
        error instanceof UniqueConstraintViolationError &&
        error.constraint === WALLET_PLAYER_CURRENCY_CONSTRAINT
      ) {
        throw new WalletAlreadyExistsError();
      }
      throw error;
    }
    return wallet;
  }
}

function parseInitialBalance(props: MoneyProps): Money {
  try {
    return Money.from(props);
  } catch (error) {
    if (error instanceof MoneyError) {
      throw new InvalidRequestError([
        { field: 'initialBalance', code: error.code, message: error.message },
      ]);
    }
    throw error;
  }
}
