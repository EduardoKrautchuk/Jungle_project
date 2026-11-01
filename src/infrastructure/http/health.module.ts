import { EntityManager } from '@mikro-orm/postgresql';
import { Module } from '@nestjs/common';
import { loadSqsConfig, type SqsConfig } from '../config/sqs.config.js';
import { createSqsClient } from '../messaging/sqs-client.js';
import { SqsHealthIndicator } from '../messaging/sqs-health.indicator.js';
import { DEFAULT_HEALTH_TIMEOUT_MS } from '../observability/dependency-health.js';
import { ObservabilityModule } from '../observability/observability.module.js';
import { SystemGauges } from '../observability/system-gauges.js';
import { HealthController } from './health.controller.js';
import { MetricsController } from './metrics.controller.js';

const HEALTH_SQS_CONFIG = Symbol('HEALTH_SQS_CONFIG');

@Module({
  imports: [ObservabilityModule],
  controllers: [HealthController, MetricsController],
  providers: [
    {
      provide: HEALTH_SQS_CONFIG,
      useFactory: () => loadSqsConfig(process.env),
    },
    {
      provide: SqsHealthIndicator,
      inject: [HEALTH_SQS_CONFIG],
      useFactory: (config: SqsConfig) =>
        new SqsHealthIndicator(
          createSqsClient(
            { ...config, requestTimeoutMs: DEFAULT_HEALTH_TIMEOUT_MS },
            { maxAttempts: 1 },
          ),
          config,
        ),
    },
    {
      provide: SystemGauges,
      inject: [EntityManager, SqsHealthIndicator, HEALTH_SQS_CONFIG],
      useFactory: (
        em: EntityManager,
        sqs: SqsHealthIndicator,
        config: SqsConfig,
      ) => new SystemGauges(em, sqs, config),
    },
  ],
})
export class HealthModule {}
