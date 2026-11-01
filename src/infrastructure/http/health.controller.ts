import {
  Controller,
  Get,
  Inject,
  ServiceUnavailableException,
} from '@nestjs/common';
import { SqsHealthIndicator } from '../messaging/sqs-health.indicator.js';
import { DatabaseHealthIndicator } from '../persistence/database-health.indicator.js';

type DependencyStatus = 'up' | 'down';

export interface ReadinessReport {
  readonly status: 'ok' | 'error';
  readonly checks: {
    readonly postgres: DependencyStatus;
    readonly sqs: DependencyStatus;
  };
}

@Controller('health')
export class HealthController {
  constructor(
    @Inject(DatabaseHealthIndicator)
    private readonly database: DatabaseHealthIndicator,
    @Inject(SqsHealthIndicator)
    private readonly sqs: SqsHealthIndicator,
  ) {}

  @Get('live')
  live(): { status: 'ok' } {
    return { status: 'ok' };
  }

  @Get('ready')
  async ready(): Promise<ReadinessReport> {
    const [postgres, sqs] = await Promise.all([
      this.database.check(),
      this.sqs.check(),
    ]);
    const report: ReadinessReport = {
      status: postgres.status === 'up' && sqs.status === 'up' ? 'ok' : 'error',
      checks: { postgres: postgres.status, sqs: sqs.status },
    };
    if (report.status === 'error') {
      throw new ServiceUnavailableException(report);
    }
    return report;
  }
}
