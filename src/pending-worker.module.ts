import { Module, type DynamicModule } from '@nestjs/common';
import type { DatabaseTarget } from './infrastructure/config/database.config.js';
import { PendingReferenceModule } from './infrastructure/pending/pending-reference.module.js';
import { PersistenceModule } from './infrastructure/persistence/persistence.module.js';

@Module({})
export class PendingWorkerAppModule {
  static forRoot(target: DatabaseTarget = 'default'): DynamicModule {
    return {
      module: PendingWorkerAppModule,
      imports: [PersistenceModule.forRoot(target), PendingReferenceModule],
    };
  }
}
