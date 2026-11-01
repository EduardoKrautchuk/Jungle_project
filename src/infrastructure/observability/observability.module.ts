import { Module } from '@nestjs/common';
import { Metrics } from './metrics.js';

export const METRICS = Symbol('METRICS');

@Module({
  providers: [{ provide: METRICS, useFactory: () => new Metrics() }],
  exports: [METRICS],
})
export class ObservabilityModule {}
