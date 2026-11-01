import { MikroOrmUnitOfWork } from '../../../src/infrastructure/persistence/mikro-orm-unit-of-work.js';
import { WagerTransactionKind } from '../../../src/domain/wagering/wager-transaction.enums.js';
import { WagerTransaction } from '../../../src/domain/wagering/wager-transaction.js';
import {
  NOW,
  applyDebit,
  brl,
} from '../../integration/persistence/domain-fixtures.js';
import { openTestOrm } from '../../integration/persistence/support.js';
import {
  parseWorkerJob,
  type DebitRequest,
  type WorkerJob,
  type WorkerResult,
} from './protocol.js';

const emit = (line: string): void => {
  process.stdout.write(`${line}\n`);
};

const forever = (): Promise<never> => new Promise<never>(() => undefined);

async function waitForGo(): Promise<void> {
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const chunk of Bun.stdin.stream()) {
    buffer += decoder.decode(chunk);
    if (buffer.split('\n').some((line) => line.trim() === 'GO')) {
      return;
    }
  }
  throw new Error('stdin closed before GO');
}

function toTransaction(
  job: WorkerJob,
  request: DebitRequest,
): WagerTransaction {
  return WagerTransaction.create({
    id: request.id,
    providerId: 'provider-a',
    externalTransactionId: request.externalTransactionId,
    idempotencyKey: request.idempotencyKey,
    payloadHash: request.payloadHash,
    walletId: job.walletId,
    playerId: job.playerId,
    roundId: 'round-1',
    gameId: 'fortune-chimp',
    kind: WagerTransactionKind.Bet,
    money: brl(request.amount),
    createdAt: NOW,
  });
}

const job = parseWorkerJob(process.env.WORKER_JOB);
const orm = await openTestOrm();
const uow = new MikroOrmUnitOfWork(orm.em);
await orm.em.getConnection().execute('SELECT 1');
emit('READY');
await waitForGo();

if (job.mode === 'debits') {
  const results = await Promise.all(
    job.requests.map(async (request): Promise<WorkerResult> => {
      try {
        const outcome = await applyDebit(uow, toTransaction(job, request));
        return { requestId: request.id, ...outcome };
      } catch (error) {
        return {
          requestId: request.id,
          outcome: 'ERROR',
          message: error instanceof Error ? error.message : String(error),
        };
      }
    }),
  );
  emit(`RESULT ${JSON.stringify(results)}`);
  await orm.close(true);
  process.exit(0);
}

const [request] = job.requests;
if (request === undefined) {
  throw new Error('crash modes need one request');
}

if (job.mode === 'crash-before-commit') {
  await applyDebit(uow, toTransaction(job, request), {
    beforeCommit: async () => {
      emit('HOLDING');
      await forever();
    },
  });
}

if (job.mode === 'crash-after-commit') {
  const outcome = await applyDebit(uow, toTransaction(job, request));
  emit(`COMMITTED ${JSON.stringify({ requestId: request.id, ...outcome })}`);
  await forever();
}
