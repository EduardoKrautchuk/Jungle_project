import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Inject,
  Logger,
  Param,
  Post,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import {
  ID_GENERATOR,
  type IdGenerator,
} from '../../application/ports/runtime.js';
import { CreateWallet } from '../../application/wallets/create-wallet.js';
import { WalletQueries } from '../../application/wallets/wallet-queries.js';
import {
  presentLedgerPage,
  presentReconciliation,
  presentWallet,
  type LedgerPageResponse,
  type ReconciliationResponse,
  type WalletResponse,
} from './presenters/presenters.js';
import {
  parseCorrelationId,
  parseCreateWallet,
  parseLedgerQuery,
} from './validation/request-parsers.js';
import { readUuid } from '../validation/request-reader.js';
import { ProviderAuthGuard } from './auth/provider-auth.guard.js';

@Controller('wallets')
@UseGuards(ProviderAuthGuard)
export class WalletsController {
  private readonly logger = new Logger(WalletsController.name);

  constructor(
    @Inject(CreateWallet) private readonly createWallet: CreateWallet,
    @Inject(WalletQueries) private readonly queries: WalletQueries,
    @Inject(ID_GENERATOR) private readonly ids: IdGenerator,
  ) {}

  @Post()
  async create(
    @Body() body: unknown,
    @Headers('x-correlation-id') correlationHeader: unknown,
    @Res({ passthrough: true }) response: Response,
  ): Promise<WalletResponse> {
    const command = parseCreateWallet(body);
    const correlationId =
      parseCorrelationId(correlationHeader) ?? this.ids.next();
    const wallet = await this.createWallet.execute({
      ...command,
      correlationId,
    });
    response.setHeader('X-Correlation-Id', correlationId);
    response.status(201);
    return presentWallet(wallet);
  }

  @Get(':walletId')
  async get(@Param('walletId') walletId: string): Promise<WalletResponse> {
    return presentWallet(
      await this.queries.getWallet(readUuid(walletId, 'walletId')),
    );
  }

  @Get(':walletId/ledger')
  async ledger(
    @Param('walletId') walletId: string,
    @Query() query: unknown,
  ): Promise<LedgerPageResponse> {
    const id = readUuid(walletId, 'walletId');
    const page = parseLedgerQuery(query);
    return presentLedgerPage(await this.queries.listLedger(id, page));
  }

  @Post(':walletId/reconciliation')
  @HttpCode(200)
  async reconcile(
    @Param('walletId') walletId: string,
  ): Promise<ReconciliationResponse> {
    const report = await this.queries.reconcile(readUuid(walletId, 'walletId'));
    if (!report.consistent) {
      this.logger.warn(
        JSON.stringify({
          event: 'wallet.reconciliation.divergence',
          walletId: report.walletId,
          checkedEntries: report.checkedEntries,
        }),
      );
    }
    return presentReconciliation(report);
  }
}
