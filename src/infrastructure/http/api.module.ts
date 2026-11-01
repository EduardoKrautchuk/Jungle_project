import { Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { WageringModule } from '../application/wagering.module.js';
import { ApiExceptionFilter } from './api-exception.filter.js';
import { WageringController } from './wagering.controller.js';
import { WalletsController } from './wallets.controller.js';

@Module({
  imports: [WageringModule],
  controllers: [WalletsController, WageringController],
  providers: [{ provide: APP_FILTER, useClass: ApiExceptionFilter }],
})
export class ApiModule {}
