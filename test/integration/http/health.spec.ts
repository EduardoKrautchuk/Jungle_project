import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
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
import { HealthController } from '../../../src/infrastructure/http/health.controller.js';
import { HealthModule } from '../../../src/infrastructure/http/health.module.js';
import { DatabaseHealthIndicator } from '../../../src/infrastructure/persistence/database-health.indicator.js';
import { createMikroOrmConfig } from '../../../src/infrastructure/persistence/mikro-orm.config.js';
import { MikroOrmUnitOfWork } from '../../../src/infrastructure/persistence/mikro-orm-unit-of-work.js';
import { PersistenceModule } from '../../../src/infrastructure/persistence/persistence.module.js';
import { migrateFresh, openTestOrm } from '../persistence/support.js';

let app: INestApplication;

describe('health endpoints with the NestJS persistence module', () => {
  beforeAll(async () => {
    const orm = await openTestOrm();
    await migrateFresh(orm);
    await orm.close(true);

    const moduleRef = await Test.createTestingModule({
      imports: [PersistenceModule.forRoot('test'), HealthModule],
    }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('reports liveness without touching the database', async () => {
    const response = await request(app.getHttpServer()).get('/health/live');
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: 'ok' });
  });

  it('reports readiness after a real PostgreSQL round trip', async () => {
    const response = await request(app.getHttpServer()).get('/health/ready');
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: 'ok', checks: { postgres: 'up' } });
  });

  it('provides a working unit of work through dependency injection', async () => {
    const uow = app.get<UnitOfWork>(UNIT_OF_WORK);
    expect(uow).toBeInstanceOf(MikroOrmUnitOfWork);
    expect(
      await uow.run((r) => r.wallets.findById(crypto.randomUUID())),
    ).toBeUndefined();
  });

  it('reports the database as down and readiness as 503 when PostgreSQL is unreachable', async () => {
    const unreachable = await MikroORM.init(
      createMikroOrmConfig(
        loadDatabaseConfig({ ...process.env, DATABASE_PORT: '1' }, 'test'),
      ),
    );
    const indicator = new DatabaseHealthIndicator(unreachable);

    const health = await indicator.check();
    expect(health.status).toBe('down');

    const controller = new HealthController(indicator);
    let caught: unknown;
    try {
      await controller.ready();
    } catch (error) {
      caught = error;
    }
    await unreachable.close(true);
    expect(caught).toBeInstanceOf(ServiceUnavailableException);
    if (caught instanceof ServiceUnavailableException) {
      expect(caught.getStatus()).toBe(503);
      expect(caught.getResponse()).toEqual({
        status: 'error',
        checks: { postgres: 'down' },
      });
    }
  });
});
