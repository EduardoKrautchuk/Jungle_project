import { Module } from '@nestjs/common';
import { HealthModule } from './infrastructure/http/health.module.js';
import { PersistenceModule } from './infrastructure/persistence/persistence.module.js';

@Module({
  imports: [PersistenceModule.forRoot(), HealthModule],
})
export class AppModule {}
