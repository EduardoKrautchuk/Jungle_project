import type { MikroORM } from '@mikro-orm/postgresql';
import {
  DEFAULT_HEALTH_TIMEOUT_MS,
  type DependencyHealth,
} from '../observability/dependency-health.js';
import { withTimeout } from '../observability/with-timeout.js';

export class DatabaseHealthIndicator {
  constructor(
    private readonly orm: MikroORM,
    private readonly timeoutMs = DEFAULT_HEALTH_TIMEOUT_MS,
  ) {}

  async check(): Promise<DependencyHealth> {
    try {
      await withTimeout(
        () => this.orm.em.getConnection().execute('SELECT 1'),
        this.timeoutMs,
      );
      return { status: 'up' };
    } catch (error) {
      return {
        status: 'down',
        reason: error instanceof Error ? error.message : 'unknown error',
      };
    }
  }
}
