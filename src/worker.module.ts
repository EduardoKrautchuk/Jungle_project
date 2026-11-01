import { Module, type DynamicModule } from '@nestjs/common';
import type { DatabaseTarget } from './infrastructure/config/database.config.js';
import { MessagingModule } from './infrastructure/messaging/messaging.module.js';
import { PersistenceModule } from './infrastructure/persistence/persistence.module.js';

@Module({})
export class WorkerModule {
  static forRoot(target: DatabaseTarget = 'default'): DynamicModule {
    return {
      module: WorkerModule,
      imports: [PersistenceModule.forRoot(target), MessagingModule],
    };
  }
}
