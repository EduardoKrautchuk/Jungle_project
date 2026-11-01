import { Migrator } from '@mikro-orm/migrations';
import { defineConfig } from '@mikro-orm/postgresql';
import type { DatabaseConfig } from '../config/database.config.js';
import { MIGRATIONS } from './migrations/index.js';
import { PERSISTENCE_SCHEMAS } from './schemas.js';

export function createMikroOrmConfig(database: DatabaseConfig) {
  return defineConfig({
    host: database.host,
    port: database.port,
    user: database.user,
    password: database.password,
    dbName: database.dbName,
    pool: { min: database.poolMin, max: database.poolMax },
    entities: PERSISTENCE_SCHEMAS,
    extensions: [Migrator],
    migrations: {
      tableName: 'mikro_orm_migrations',
      migrationsList: MIGRATIONS,
      transactional: true,
      allOrNothing: true,
      snapshot: false,
      snapshotOnMigrate: false,
      silent: true,
    },
    debug: false,
  });
}
