import { Module } from '@nestjs/common';
import { APP_FILTER, APP_INTERCEPTOR } from '@nestjs/core';
import { WageringModule } from '../application/wagering.module.js';
import { MeteredLog } from '../observability/metered-log.js';
import type { Metrics } from '../observability/metrics.js';
import {
  METRICS,
  ObservabilityModule,
} from '../observability/observability.module.js';
import { JsonLinesLog } from '../observability/structured-log.js';
import { ApiExceptionFilter } from './api-exception.filter.js';
import {
  HTTP_LOG,
  HttpObservabilityInterceptor,
} from './http-observability.interceptor.js';
import { WageringController } from './wagering.controller.js';
import { WalletsController } from './wallets.controller.js';

@Module({
  imports: [WageringModule, ObservabilityModule],
  controllers: [WalletsController, WageringController],
  providers: [
    {
      provide: HTTP_LOG,
      inject: [METRICS],
      useFactory: (metrics: Metrics) =>
        new MeteredLog(new JsonLinesLog('http-api'), metrics),
    },
    { provide: APP_FILTER, useClass: ApiExceptionFilter },
    { provide: APP_INTERCEPTOR, useClass: HttpObservabilityInterceptor },
  ],
})
export class ApiModule {}
