import { MikroOrmModule } from '@mikro-orm/nestjs';
import {
  EntityManager,
  MikroORM,
  PostgreSqlDriver,
} from '@mikro-orm/postgresql';
import { Global, Module, type DynamicModule } from '@nestjs/common';
import { UNIT_OF_WORK } from '../../application/ports/persistence.js';
import {
  loadDatabaseConfig,
  type DatabaseTarget,
} from '../config/database.config.js';
import { DatabaseHealthIndicator } from './database-health.indicator.js';
import { createMikroOrmConfig } from './mikro-orm.config.js';
import { MikroOrmUnitOfWork } from './mikro-orm-unit-of-work.js';

@Global()
@Module({})
export class PersistenceModule {
  static forRoot(target: DatabaseTarget = 'default'): DynamicModule {
    return {
      module: PersistenceModule,
      imports: [
        MikroOrmModule.forRootAsync({
          driver: PostgreSqlDriver,
          useFactory: () =>
            createMikroOrmConfig(loadDatabaseConfig(process.env, target)),
        }),
      ],
      providers: [
        {
          provide: UNIT_OF_WORK,
          inject: [EntityManager],
          useFactory: (em: EntityManager) => new MikroOrmUnitOfWork(em),
        },
        {
          provide: DatabaseHealthIndicator,
          inject: [MikroORM],
          useFactory: (orm: MikroORM) => new DatabaseHealthIndicator(orm),
        },
      ],
      exports: [UNIT_OF_WORK, DatabaseHealthIndicator],
    };
  }
}
