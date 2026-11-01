import type { MikroORM } from '@mikro-orm/postgresql';

export type DatabaseHealth =
  | { readonly status: 'up' }
  | { readonly status: 'down'; readonly reason: string };

export class DatabaseHealthIndicator {
  constructor(private readonly orm: MikroORM) {}

  async check(): Promise<DatabaseHealth> {
    try {
      await this.orm.em.getConnection().execute('SELECT 1');
      return { status: 'up' };
    } catch (error) {
      return {
        status: 'down',
        reason: error instanceof Error ? error.message : 'unknown error',
      };
    }
  }
}
