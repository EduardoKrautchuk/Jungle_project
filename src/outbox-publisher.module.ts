import { Module, type DynamicModule } from '@nestjs/common';
import type { DatabaseTarget } from './infrastructure/config/database.config.js';
import { OutboxPublisherModule } from './infrastructure/outbox/outbox-publisher.module.js';
import { PersistenceModule } from './infrastructure/persistence/persistence.module.js';

@Module({})
export class OutboxPublisherAppModule {
  static forRoot(target: DatabaseTarget = 'default'): DynamicModule {
    return {
      module: OutboxPublisherAppModule,
      imports: [PersistenceModule.forRoot(target), OutboxPublisherModule],
    };
  }
}
