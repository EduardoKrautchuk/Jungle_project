import type { INestApplication } from '@nestjs/common';
import type { MikroORM } from '@mikro-orm/postgresql';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../../src/app.module.js';
import {
  Db,
  migrateFresh,
  openTestOrm,
} from '../integration/persistence/support.js';

export interface TestApp {
  app: INestApplication;
  orm: MikroORM;
  db: Db;
  http: () => ReturnType<typeof request>;
  close: () => Promise<void>;
}

export async function startTestApp(): Promise<TestApp> {
  const orm = await openTestOrm();
  await migrateFresh(orm);
  const moduleRef = await Test.createTestingModule({
    imports: [AppModule.forRoot('test')],
  }).compile();
  const app = moduleRef.createNestApplication({ logger: false });
  await app.init();
  return {
    app,
    orm,
    db: new Db(orm),
    http: () => request(app.getHttpServer()),
    close: async () => {
      await app.close();
      await orm.close(true);
    },
  };
}

export type Json = Record<string, unknown>;

export function json(body: unknown): Json {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new Error(`expected a JSON object, got ${JSON.stringify(body)}`);
  }
  const record: Json = {};
  for (const [key, value] of Object.entries(body)) {
    record[key] = value;
  }
  return record;
}

export function text(value: unknown): string {
  if (typeof value !== 'string') {
    throw new Error(`expected a string, got ${JSON.stringify(value)}`);
  }
  return value;
}

export interface WalletRef {
  id: string;
  playerId: string;
}

export interface WagerBody {
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: string;
  money: { amount: string; currency: string };
  referenceExternalTransactionId?: string;
}

let sequence = 0;

export const uniqueId = (prefix: string): string =>
  `${prefix}-${Date.now().toString(36)}-${++sequence}`;

export function wagerBody(
  wallet: WalletRef,
  overrides: Partial<WagerBody> = {},
): WagerBody {
  return {
    providerId: 'provider-a',
    externalTransactionId: uniqueId('ext'),
    playerId: wallet.playerId,
    walletId: wallet.id,
    roundId: 'round-1',
    gameId: 'fortune-chimp',
    kind: 'BET',
    money: { amount: '25.00', currency: 'BRL' },
    ...overrides,
  };
}

export const keyOf = (body: WagerBody): string =>
  `${body.providerId}:${body.externalTransactionId}`;
