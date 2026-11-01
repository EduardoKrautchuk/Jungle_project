import { MikroORM } from '@mikro-orm/postgresql';
import { loadDatabaseConfig } from '../config/database.config.js';
import { createMikroOrmConfig } from '../persistence/mikro-orm.config.js';
import { SqlOutboxPublicationStore } from '../persistence/outbox-publication.store.js';

const target = process.argv.includes('--test') ? 'test' : 'default';
const orm = await MikroORM.init(
  createMikroOrmConfig(loadDatabaseConfig(process.env, target)),
);
try {
  const backlog = await new SqlOutboxPublicationStore(orm.em).backlog();
  console.log(
    JSON.stringify({ database: orm.config.get('dbName'), ...backlog }),
  );
} catch (error) {
  console.error(
    `outbox backlog failed: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = 1;
} finally {
  await orm.close(true);
}
