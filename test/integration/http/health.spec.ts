import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import net from 'node:net';
import {
  ServiceUnavailableException,
  type INestApplication,
} from '@nestjs/common';
import { MikroORM } from '@mikro-orm/postgresql';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import {
  UNIT_OF_WORK,
  type UnitOfWork,
} from '../../../src/application/ports/persistence.js';
import { loadDatabaseConfig } from '../../../src/infrastructure/config/database.config.js';
import {
  loadSqsConfig,
  type SqsConfig,
} from '../../../src/infrastructure/config/sqs.config.js';
import { HealthController } from '../../../src/infrastructure/http/health.controller.js';
import { HealthModule } from '../../../src/infrastructure/http/health.module.js';
import { createSqsClient } from '../../../src/infrastructure/messaging/sqs-client.js';
import { SqsHealthIndicator } from '../../../src/infrastructure/messaging/sqs-health.indicator.js';
import { DatabaseHealthIndicator } from '../../../src/infrastructure/persistence/database-health.indicator.js';
import { createMikroOrmConfig } from '../../../src/infrastructure/persistence/mikro-orm.config.js';
import { MikroOrmUnitOfWork } from '../../../src/infrastructure/persistence/mikro-orm-unit-of-work.js';
import { PersistenceModule } from '../../../src/infrastructure/persistence/persistence.module.js';
import { migrateFresh, openTestOrm } from '../persistence/support.js';

let app: INestApplication;
let orm: MikroORM;

function sqsIndicator(
  overrides: Partial<SqsConfig> = {},
  timeoutMs = 2_000,
): SqsHealthIndicator {
  const config = { ...loadSqsConfig(process.env), ...overrides };
  return new SqsHealthIndicator(
    createSqsClient(
      { ...config, requestTimeoutMs: timeoutMs },
      { maxAttempts: 1 },
    ),
    config,
    timeoutMs,
  );
}

async function unreachableDatabase(): Promise<DatabaseHealthIndicator> {
  return new DatabaseHealthIndicator(
    await MikroORM.init(
      createMikroOrmConfig(
        loadDatabaseConfig({ ...process.env, DATABASE_PORT: '1' }, 'test'),
      ),
    ),
  );
}

async function readinessFailure(
  controller: HealthController,
): Promise<unknown> {
  try {
    await controller.ready();
  } catch (error) {
    if (error instanceof ServiceUnavailableException) {
      expect(error.getStatus()).toBe(503);
      return error.getResponse();
    }
    throw error;
  }
  throw new Error('readiness unexpectedly succeeded');
}

async function silentServer(): Promise<{ port: number; close: () => void }> {
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
  });
  const port = await new Promise<number>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve(
        typeof address === 'object' && address !== null ? address.port : 0,
      );
    });
  });
  return {
    port,
    close: () => {
      for (const socket of sockets) {
        socket.destroy();
      }
      server.close();
    },
  };
}

describe('health endpoints with real PostgreSQL and SQS', () => {
  beforeAll(async () => {
    orm = await openTestOrm();
    await migrateFresh(orm);

    const moduleRef = await Test.createTestingModule({
      imports: [PersistenceModule.forRoot('test'), HealthModule],
    }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    await app.init();
  });

  afterAll(async () => {
    await app.close();
    await orm.close(true);
  });

  it('reports liveness without touching any dependency', async () => {
    const response = await request(app.getHttpServer()).get('/health/live');
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: 'ok' });
  });

  it('reports readiness after real PostgreSQL and SQS round trips', async () => {
    const response = await request(app.getHttpServer()).get('/health/ready');
    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      status: 'ok',
      checks: { postgres: 'up', sqs: 'up' },
    });
  });

  it('provides a working unit of work through dependency injection', async () => {
    const uow = app.get<UnitOfWork>(UNIT_OF_WORK);
    expect(uow).toBeInstanceOf(MikroOrmUnitOfWork);
    expect(
      await uow.run((r) => r.wallets.findById(crypto.randomUUID())),
    ).toBeUndefined();
  });

  it('answers 503 with postgres down when PostgreSQL is unreachable', async () => {
    const database = await unreachableDatabase();
    const sqs = sqsIndicator();
    expect((await database.check()).status).toBe('down');

    const body = await readinessFailure(new HealthController(database, sqs));
    sqs.onApplicationShutdown();
    expect(body).toEqual({
      status: 'error',
      checks: { postgres: 'down', sqs: 'up' },
    });
  });

  it('answers 503 with sqs down when the SQS endpoint refuses connections', async () => {
    const database = app.get(DatabaseHealthIndicator);
    const sqs = sqsIndicator({ endpoint: 'http://127.0.0.1:1' });
    expect((await sqs.check()).status).toBe('down');

    const body = await readinessFailure(new HealthController(database, sqs));
    sqs.onApplicationShutdown();
    expect(body).toEqual({
      status: 'error',
      checks: { postgres: 'up', sqs: 'down' },
    });
  });

  it('answers 503 with sqs down when the command queue does not exist, without creating it', async () => {
    const queueName = `missing-${Date.now()}.fifo`;
    const sqs = sqsIndicator({ queueName, queueUrl: undefined });
    const health = await sqs.check();
    sqs.onApplicationShutdown();
    expect(health.status).toBe('down');

    const probe = sqsIndicator({ queueName, queueUrl: undefined });
    expect((await probe.check()).status).toBe('down');
    probe.onApplicationShutdown();
  });

  it('gives up within the timeout when SQS accepts connections but never answers', async () => {
    const silent = await silentServer();
    const sqs = sqsIndicator(
      { endpoint: `http://127.0.0.1:${silent.port}` },
      300,
    );
    const startedAt = performance.now();
    const health = await sqs.check();
    const elapsed = performance.now() - startedAt;
    sqs.onApplicationShutdown();
    silent.close();

    expect(health).toEqual({ status: 'down', reason: 'TimeoutError' });
    expect(elapsed).toBeLessThan(2_000);
  });

  it('answers 503 with both dependencies down', async () => {
    const database = await unreachableDatabase();
    const sqs = sqsIndicator({ endpoint: 'http://127.0.0.1:1' });
    const body = await readinessFailure(new HealthController(database, sqs));
    sqs.onApplicationShutdown();
    expect(body).toEqual({
      status: 'error',
      checks: { postgres: 'down', sqs: 'down' },
    });
  });

  it('exposes system-wide gauges from PostgreSQL and SQS on /metrics', async () => {
    const response = await request(app.getHttpServer()).get('/metrics');
    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toContain('text/plain');
    const text = response.text;
    expect(text).toContain('wagering_metrics_source_up{source="postgres"} 1');
    expect(text).toContain('wagering_metrics_source_up{source="sqs"} 1');
    expect(text).toContain('# TYPE wagering_outbox_lag_seconds gauge');
    expect(text).toContain('wagering_outbox_pending_events ');
    expect(text).toContain(
      'wagering_sqs_queue_messages{queue="wager-transactions-dlq.fifo"}',
    );
    expect(text).toContain('# TYPE wagering_operations_total counter');
  });
});
