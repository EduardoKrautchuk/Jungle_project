import { Module } from '@nestjs/common';
import {
  UNIT_OF_WORK,
  type UnitOfWork,
} from '../../application/ports/persistence.js';
import {
  CLOCK,
  ID_GENERATOR,
  type Clock,
  type IdGenerator,
} from '../../application/ports/runtime.js';
import { ResolvePendingReference } from '../../application/wagering/resolve-pending-reference.js';
import { WagerSettlement } from '../../application/wagering/wager-settlement.js';
import { WageringModule } from '../application/wagering.module.js';
import {
  loadPendingReferenceConfig,
  type PendingReferenceWorkerConfig,
} from '../config/pending-reference.config.js';
import {
  JsonLinesLog,
  type StructuredLog,
} from '../observability/structured-log.js';
import { PendingReferenceWorker } from './pending-reference-worker.js';

export const PENDING_WORKER_CONFIG = Symbol('PENDING_WORKER_CONFIG');
export const PENDING_WORKER_LOG = Symbol('PENDING_WORKER_LOG');

@Module({
  imports: [WageringModule],
  providers: [
    {
      provide: PENDING_WORKER_CONFIG,
      useFactory: () => loadPendingReferenceConfig(process.env),
    },
    {
      provide: PENDING_WORKER_LOG,
      useFactory: () => new JsonLinesLog('pending-reference-worker'),
    },
    {
      provide: ResolvePendingReference,
      inject: [
        UNIT_OF_WORK,
        WagerSettlement,
        CLOCK,
        ID_GENERATOR,
        PENDING_WORKER_CONFIG,
      ],
      useFactory: (
        uow: UnitOfWork,
        settlement: WagerSettlement,
        clock: Clock,
        ids: IdGenerator,
        config: PendingReferenceWorkerConfig,
      ) =>
        new ResolvePendingReference(uow, settlement, clock, ids, {
          maxAttempts: config.maxAttempts,
          baseDelayMs: config.baseDelayMs,
          maxDelayMs: config.maxDelayMs,
        }),
    },
    {
      provide: PendingReferenceWorker,
      inject: [
        ResolvePendingReference,
        PENDING_WORKER_CONFIG,
        PENDING_WORKER_LOG,
      ],
      useFactory: (
        resolver: ResolvePendingReference,
        config: PendingReferenceWorkerConfig,
        log: StructuredLog,
      ) =>
        new PendingReferenceWorker(
          resolver,
          {
            workerId: config.workerId,
            batchSize: config.batchSize,
            idlePollMs: config.idlePollMs,
            errorBackoffMaxMs: config.errorBackoffMaxMs,
            shutdownGraceMs: config.shutdownGraceMs,
          },
          log,
        ),
    },
  ],
  exports: [
    PendingReferenceWorker,
    ResolvePendingReference,
    PENDING_WORKER_LOG,
  ],
})
export class PendingReferenceModule {}
