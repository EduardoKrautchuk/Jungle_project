import { Module, type DynamicModule } from '@nestjs/common';
import type { DatabaseTarget } from './infrastructure/config/database.config.js';
import { ApiModule } from './infrastructure/http/api.module.js';
import { HealthModule } from './infrastructure/http/health.module.js';
import { PersistenceModule } from './infrastructure/persistence/persistence.module.js';

@Module({})
export class AppModule {
  static forRoot(target: DatabaseTarget = 'default'): DynamicModule {
    return {
      module: AppModule,
      imports: [PersistenceModule.forRoot(target), HealthModule, ApiModule],
    };
  }
}
