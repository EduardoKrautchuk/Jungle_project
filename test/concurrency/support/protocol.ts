export interface DebitRequest {
  id: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  amount: string;
}

export type WorkerMode =
  'debits' | 'crash-before-commit' | 'crash-after-commit';

export interface WorkerJob {
  mode: WorkerMode;
  walletId: string;
  playerId: string;
  requests: DebitRequest[];
}

export interface WorkerResult {
  requestId: string;
  outcome: string;
  status?: string;
  balance?: string;
  message?: string;
}

const MODES: readonly string[] = [
  'debits',
  'crash-before-commit',
  'crash-after-commit',
];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isString = (value: unknown): value is string => typeof value === 'string';

function isDebitRequest(value: unknown): value is DebitRequest {
  return (
    isRecord(value) &&
    isString(value.id) &&
    isString(value.externalTransactionId) &&
    isString(value.idempotencyKey) &&
    isString(value.payloadHash) &&
    isString(value.amount)
  );
}

export function parseWorkerJob(raw: string | undefined): WorkerJob {
  const value: unknown = JSON.parse(raw ?? 'null');
  if (
    !isRecord(value) ||
    !isString(value.mode) ||
    !MODES.includes(value.mode) ||
    !isString(value.walletId) ||
    !isString(value.playerId) ||
    !Array.isArray(value.requests) ||
    !value.requests.every(isDebitRequest)
  ) {
    throw new Error('invalid WORKER_JOB');
  }
  const mode = value.mode;
  if (
    mode !== 'debits' &&
    mode !== 'crash-before-commit' &&
    mode !== 'crash-after-commit'
  ) {
    throw new Error('invalid WORKER_JOB mode');
  }
  return {
    mode,
    walletId: value.walletId,
    playerId: value.playerId,
    requests: value.requests,
  };
}

export function parseWorkerResults(raw: string): WorkerResult[] {
  const value: unknown = JSON.parse(raw);
  if (!Array.isArray(value)) {
    throw new Error('invalid RESULT payload');
  }
  return value.map((item: unknown) => {
    if (
      !isRecord(item) ||
      !isString(item.requestId) ||
      !isString(item.outcome)
    ) {
      throw new Error('invalid RESULT item');
    }
    return {
      requestId: item.requestId,
      outcome: item.outcome,
      status: isString(item.status) ? item.status : undefined,
      balance: isString(item.balance) ? item.balance : undefined,
      message: isString(item.message) ? item.message : undefined,
    };
  });
}
