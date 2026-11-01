import { EntitySchema } from '@mikro-orm/postgresql';

export interface WalletRecord {
  id: string;
  playerId: string;
  currency: string;
  balance: string;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface WagerTransactionRecord {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: string;
  status: string;
  amount: string;
  currency: string;
  referenceExternalTransactionId: string | null;
  referenceTransactionId: string | null;
  failureCode: string | null;
  resultBalance: string | null;
  referenceAttempts: number;
  nextReferenceAttemptAt: Date | null;
  createdAt: Date;
  processedAt: Date | null;
}

export interface LedgerEntryRecord {
  id: string;
  walletId: string;
  transactionId: string;
  direction: string;
  amount: string;
  currency: string;
  balanceBefore: string;
  balanceAfter: string;
  createdAt: Date;
}

export interface InboxMessageRecord {
  consumerName: string;
  messageId: string;
  payloadHash: string;
  receivedAt: Date;
  processedAt: Date | null;
}

export interface OutboxMessageRecord {
  id: string;
  aggregateId: string;
  eventType: string;
  payload: Record<string, unknown>;
  occurredAt: Date;
  attempts: number;
  nextAttemptAt: Date;
  publishedAt: Date | null;
}

const money = { type: 'string', columnType: 'money_amount' } as const;
const nullableMoney = { ...money, nullable: true } as const;
const timestamp = { type: 'datetime', columnType: 'timestamptz' } as const;
const nullableTimestamp = { ...timestamp, nullable: true } as const;
const text = { type: 'string', columnType: 'text' } as const;
const nullableText = { ...text, nullable: true } as const;

export const WalletSchema = new EntitySchema<WalletRecord>({
  name: 'WalletRecord',
  tableName: 'wallets',
  properties: {
    id: { type: 'uuid', primary: true },
    playerId: text,
    currency: text,
    balance: money,
    version: { type: 'integer' },
    createdAt: timestamp,
    updatedAt: timestamp,
  },
});

export const WagerTransactionSchema = new EntitySchema<WagerTransactionRecord>({
  name: 'WagerTransactionRecord',
  tableName: 'wager_transactions',
  properties: {
    id: { type: 'uuid', primary: true },
    providerId: text,
    externalTransactionId: text,
    idempotencyKey: text,
    payloadHash: text,
    walletId: { type: 'uuid' },
    playerId: text,
    roundId: text,
    gameId: text,
    kind: text,
    status: text,
    amount: money,
    currency: text,
    referenceExternalTransactionId: nullableText,
    referenceTransactionId: { type: 'uuid', nullable: true },
    failureCode: nullableText,
    resultBalance: nullableMoney,
    referenceAttempts: { type: 'integer' },
    nextReferenceAttemptAt: nullableTimestamp,
    createdAt: timestamp,
    processedAt: nullableTimestamp,
  },
});

export const LedgerEntrySchema = new EntitySchema<LedgerEntryRecord>({
  name: 'LedgerEntryRecord',
  tableName: 'wallet_ledger_entries',
  properties: {
    id: { type: 'uuid', primary: true },
    walletId: { type: 'uuid' },
    transactionId: { type: 'uuid' },
    direction: text,
    amount: money,
    currency: text,
    balanceBefore: money,
    balanceAfter: money,
    createdAt: timestamp,
  },
});

export const InboxMessageSchema = new EntitySchema<InboxMessageRecord>({
  name: 'InboxMessageRecord',
  tableName: 'inbox_messages',
  properties: {
    consumerName: { ...text, primary: true },
    messageId: { ...text, primary: true },
    payloadHash: text,
    receivedAt: timestamp,
    processedAt: nullableTimestamp,
  },
});

export const OutboxMessageSchema = new EntitySchema<OutboxMessageRecord>({
  name: 'OutboxMessageRecord',
  tableName: 'outbox_messages',
  properties: {
    id: { type: 'uuid', primary: true },
    aggregateId: text,
    eventType: text,
    payload: { type: 'json', columnType: 'jsonb' },
    occurredAt: timestamp,
    attempts: { type: 'integer' },
    nextAttemptAt: timestamp,
    publishedAt: nullableTimestamp,
  },
});

export const PERSISTENCE_SCHEMAS = [
  WalletSchema,
  WagerTransactionSchema,
  LedgerEntrySchema,
  InboxMessageSchema,
  OutboxMessageSchema,
];
