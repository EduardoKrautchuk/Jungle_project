import {
  Controller,
  Get,
  Inject,
  ServiceUnavailableException,
} from '@nestjs/common';
import { DatabaseHealthIndicator } from '../persistence/database-health.indicator.js';

@Controller('health')
export class HealthController {
  constructor(
    @Inject(DatabaseHealthIndicator)
    private readonly database: DatabaseHealthIndicator,
  ) {}

  @Get('live')
  live(): { status: 'ok' } {
    return { status: 'ok' };
  }

  @Get('ready')
  async ready(): Promise<{ status: 'ok'; checks: { postgres: 'up' } }> {
    const postgres = await this.database.check();
    if (postgres.status === 'down') {
      throw new ServiceUnavailableException({
        status: 'error',
        checks: { postgres: 'down' },
      });
    }
    return { status: 'ok', checks: { postgres: 'up' } };
  }
}
