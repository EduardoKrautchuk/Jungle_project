import { Controller, Get, Header, Inject } from '@nestjs/common';
import type { Metrics } from '../observability/metrics.js';
import { METRICS } from '../observability/observability.module.js';
import { SystemGauges } from '../observability/system-gauges.js';

@Controller('metrics')
export class MetricsController {
  constructor(
    @Inject(METRICS) private readonly metrics: Metrics,
    @Inject(SystemGauges) private readonly gauges: SystemGauges,
  ) {}

  @Get()
  @Header('Content-Type', 'text/plain; version=0.0.4; charset=utf-8')
  async render(): Promise<string> {
    return this.metrics.render(await this.gauges.collect());
  }
}
