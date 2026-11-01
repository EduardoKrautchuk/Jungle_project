import { Test } from '@nestjs/testing';
import {
  UNIT_OF_WORK,
  type PendingReferenceCandidate,
  type UnitOfWork,
} from '../../../src/application/ports/persistence.js';
import {
  CLOCK,
  ID_GENERATOR,
  type Clock,
  type IdGenerator,
} from '../../../src/application/ports/runtime.js';
import {
  ResolvePendingReference,
  type ResolutionOutcome,
} from '../../../src/application/wagering/resolve-pending-reference.js';
import { WagerSettlement } from '../../../src/application/wagering/wager-settlement.js';
import type { PendingReferenceWorkerConfig } from '../../../src/infrastructure/config/pending-reference.config.js';
import { PENDING_WORKER_CONFIG } from '../../../src/infrastructure/pending/pending-reference.module.js';
import { runPendingWorker } from '../../../src/infrastructure/pending/run-pending-worker.js';
import { PendingWorkerAppModule } from '../../../src/pending-worker.module.js';

class CrashAfterCommit extends ResolvePendingReference {
  override async resolve(
    candidate: PendingReferenceCandidate,
  ): Promise<ResolutionOutcome> {
    const outcome = await super.resolve(candidate);
    if (outcome.result === 'PROCESSED') {
      process.stdout.write(`COMMITTED ${outcome.transactionId}\n`);
      process.kill(process.pid, 'SIGKILL');
    }
    return outcome;
  }
}

const builder = Test.createTestingModule({
  imports: [PendingWorkerAppModule.forRoot('test')],
});
if (process.env.CRASH_POINT === 'after-commit') {
  builder.overrideProvider(ResolvePendingReference).useFactory({
    inject: [
      UNIT_OF_WORK,
      WagerSettlement,
      CLOCK,
      ID_GENERATOR,
      PENDING_WORKER_CONFIG,
    ],
    factory: (
      uow: UnitOfWork,
      settlement: WagerSettlement,
      clock: Clock,
      ids: IdGenerator,
      config: PendingReferenceWorkerConfig,
    ) =>
      new CrashAfterCommit(uow, settlement, clock, ids, {
        maxAttempts: config.maxAttempts,
        baseDelayMs: config.baseDelayMs,
        maxDelayMs: config.maxDelayMs,
      }),
  });
}
const moduleRef = await builder.compile();
moduleRef.useLogger(false);
await moduleRef.init();
process.stdout.write(`READY ${process.pid}\n`);
await runPendingWorker(moduleRef);
process.exit(0);
