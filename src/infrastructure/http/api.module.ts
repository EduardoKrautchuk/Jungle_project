import { Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import {
  UNIT_OF_WORK,
  type UnitOfWork,
} from '../../application/ports/persistence.js';
import {
  CLOCK,
  ID_GENERATOR,
  type Clock,
  type IdGenerator,
} from '../../application/ports/runtime.js';
import { SubmitWagerTransaction } from '../../application/wagering/submit-wager-transaction.js';
import { WagerSettlement } from '../../application/wagering/wager-settlement.js';
import { WagerTransactionQueries } from '../../application/wagering/wager-transaction-queries.js';
import { CreateWallet } from '../../application/wallets/create-wallet.js';
import { WalletQueries } from '../../application/wallets/wallet-queries.js';
import { SystemClock, UuidV7Generator } from '../runtime/system-runtime.js';
import { ApiExceptionFilter } from './api-exception.filter.js';
import { WageringController } from './wagering.controller.js';
import { WalletsController } from './wallets.controller.js';

@Module({
  controllers: [WalletsController, WageringController],
  providers: [
    { provide: APP_FILTER, useClass: ApiExceptionFilter },
    { provide: CLOCK, useClass: SystemClock },
    { provide: ID_GENERATOR, useClass: UuidV7Generator },
    {
      provide: WagerSettlement,
      inject: [ID_GENERATOR],
      useFactory: (ids: IdGenerator) => new WagerSettlement(ids),
    },
    {
      provide: SubmitWagerTransaction,
      inject: [UNIT_OF_WORK, WagerSettlement, CLOCK, ID_GENERATOR],
      useFactory: (
        uow: UnitOfWork,
        settlement: WagerSettlement,
        clock: Clock,
        ids: IdGenerator,
      ) => new SubmitWagerTransaction(uow, settlement, clock, ids),
    },
    {
      provide: CreateWallet,
      inject: [UNIT_OF_WORK, CLOCK, ID_GENERATOR],
      useFactory: (uow: UnitOfWork, clock: Clock, ids: IdGenerator) =>
        new CreateWallet(uow, clock, ids),
    },
    {
      provide: WalletQueries,
      inject: [UNIT_OF_WORK],
      useFactory: (uow: UnitOfWork) => new WalletQueries(uow),
    },
    {
      provide: WagerTransactionQueries,
      inject: [UNIT_OF_WORK],
      useFactory: (uow: UnitOfWork) => new WagerTransactionQueries(uow),
    },
  ],
})
export class ApiModule {}
