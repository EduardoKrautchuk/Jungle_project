import { describe, expect, it } from 'bun:test';
import { WagerMessageProcessor } from '../../../../src/infrastructure/messaging/wager-message-processor.js';
import type { QueueMessage } from '../../../../src/infrastructure/messaging/wager-queue.js';
import {
  createHarness,
  openWallet,
  wager,
} from '../../application/support/wagering-harness.js';

function queueMessage(body: string): QueueMessage {
  return {
    sqsMessageId: 'sqs-1',
    receiptHandle: 'handle',
    body,
    receiveCount: 1,
    groupId: 'group',
    receivedAtMs: Date.now(),
  };
}

async function setup(balance = '100.00') {
  const harness = createHarness();
  const wallet = await openWallet(harness, balance);
  const command = wager(wallet);
  const body = (messageId: string, overrides: object = {}) =>
    JSON.stringify({
      messageId,
      type: 'WagerTransactionRequested',
      occurredAt: '2026-07-29T15:00:00.000Z',
      data: {
        providerId: command.providerId,
        externalTransactionId: command.externalTransactionId,
        idempotencyKey: command.idempotencyKey,
        playerId: command.playerId,
        walletId: command.walletId,
        roundId: command.roundId,
        gameId: command.gameId,
        kind: command.kind,
        money: command.money,
        ...overrides,
      },
    });
  return {
    harness,
    body,
    processor: new WagerMessageProcessor(harness.submit, 'consumer'),
  };
}

describe('WagerMessageProcessor', () => {
  it('acknowledges processed, duplicate, replayed and rejected messages', async () => {
    const { processor, body } = await setup();
    const first = await processor.process(queueMessage(body('m-1')));
    const duplicate = await processor.process(queueMessage(body('m-1')));
    const replay = await processor.process(queueMessage(body('m-2')));
    expect([first, duplicate, replay].map((o) => o.action)).toEqual([
      'ACKNOWLEDGE',
      'ACKNOWLEDGE',
      'ACKNOWLEDGE',
    ]);
    expect(
      [first, duplicate, replay].map((o) =>
        o.action === 'ACKNOWLEDGE' ? o.result : o.errorCode,
      ),
    ).toEqual(['PROCESSED', 'DUPLICATE_MESSAGE', 'REPLAYED']);
  });

  it('acknowledges a business rejection with its failure code', async () => {
    const { processor, body } = await setup('1.00');
    expect(await processor.process(queueMessage(body('m-3')))).toMatchObject({
      action: 'ACKNOWLEDGE',
      result: 'REJECTED',
      failureCode: 'INSUFFICIENT_FUNDS',
    });
  });

  it('dead-letters permanent failures', async () => {
    const { processor, body } = await setup();
    await processor.process(queueMessage(body('m-4')));
    const outcomes = await Promise.all([
      processor.process(queueMessage('{')),
      processor.process(queueMessage(body('m-5', { kind: 'JACKPOT' }))),
      processor.process(
        queueMessage(
          body('m-4', { money: { amount: '1.00', currency: 'BRL' } }),
        ),
      ),
      processor.process(
        queueMessage(
          body('m-6', { money: { amount: '1.00', currency: 'BRL' } }),
        ),
      ),
    ]);
    expect(
      outcomes.map((o) =>
        o.action === 'ACKNOWLEDGE' ? o.result : `${o.action}:${o.errorCode}`,
      ),
    ).toEqual([
      'DEAD_LETTER:MALFORMED_MESSAGE',
      'DEAD_LETTER:VALIDATION_FAILED',
      'DEAD_LETTER:MESSAGE_PAYLOAD_MISMATCH',
      'DEAD_LETTER:IDEMPOTENCY_CONFLICT',
    ]);
  });

  it('retries unexpected failures instead of discarding them', async () => {
    const { processor, body, harness } = await setup();
    harness.uow.faults.add('ledger.append');
    expect(await processor.process(queueMessage(body('m-7')))).toMatchObject({
      action: 'RETRY',
      errorCode: 'UNEXPECTED_ERROR',
      errorName: 'InjectedFault',
    });
    expect(harness.uow.tables.inbox).toHaveLength(0);
  });
});
