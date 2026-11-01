import {
  Body,
  Controller,
  Get,
  Headers,
  Inject,
  Param,
  Post,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import {
  ID_GENERATOR,
  type IdGenerator,
} from '../../application/ports/runtime.js';
import { SubmitWagerTransaction } from '../../application/wagering/submit-wager-transaction.js';
import { WagerTransactionQueries } from '../../application/wagering/wager-transaction-queries.js';
import { WagerTransactionStatus } from '../../domain/wagering/wager-transaction.enums.js';
import {
  presentSubmission,
  presentTransaction,
  type SubmitWagerTransactionResponse,
  type WagerTransactionResponse,
} from './presenters/presenters.js';
import {
  parseCorrelationId,
  parseProviderPath,
  parseWagerRequest,
} from './validation/request-parsers.js';
import { readUuid } from '../validation/request-reader.js';
import { ProviderAuthGuard } from './auth/provider-auth.guard.js';

const STATUS_CODE: Readonly<Record<WagerTransactionStatus, number>> = {
  [WagerTransactionStatus.Processed]: 200,
  [WagerTransactionStatus.Pending]: 202,
  [WagerTransactionStatus.PendingReference]: 202,
  [WagerTransactionStatus.Rejected]: 422,
  [WagerTransactionStatus.Failed]: 422,
};

@Controller()
@UseGuards(ProviderAuthGuard)
export class WageringController {
  constructor(
    @Inject(SubmitWagerTransaction)
    private readonly submitTransaction: SubmitWagerTransaction,
    @Inject(WagerTransactionQueries)
    private readonly queries: WagerTransactionQueries,
    @Inject(ID_GENERATOR) private readonly ids: IdGenerator,
  ) {}

  @Post('wagering/transactions')
  async submit(
    @Body() body: unknown,
    @Headers('idempotency-key') idempotencyKey: unknown,
    @Headers('x-correlation-id') correlationHeader: unknown,
    @Res({ passthrough: true }) response: Response,
  ): Promise<SubmitWagerTransactionResponse> {
    const request = parseWagerRequest(body, idempotencyKey);
    const correlationId =
      parseCorrelationId(correlationHeader) ?? this.ids.next();
    const result = await this.submitTransaction.execute({
      ...request,
      correlationId,
    });
    response.setHeader('X-Correlation-Id', correlationId);
    response.status(STATUS_CODE[result.status]);
    return presentSubmission(result);
  }

  @Get('wagering/transactions/:transactionId')
  async getById(
    @Param('transactionId') transactionId: string,
  ): Promise<WagerTransactionResponse> {
    return presentTransaction(
      await this.queries.getById(readUuid(transactionId, 'transactionId')),
    );
  }

  @Get('providers/:providerId/wagering/transactions/:externalTransactionId')
  async getByExternalId(
    @Param('providerId') providerId: string,
    @Param('externalTransactionId') externalTransactionId: string,
  ): Promise<WagerTransactionResponse> {
    const path = parseProviderPath(providerId, externalTransactionId);
    return presentTransaction(
      await this.queries.getByExternalId(
        path.providerId,
        path.externalTransactionId,
      ),
    );
  }
}
