import { beforeEach, describe, expect, it } from 'bun:test';
import {
  IdempotencyConflictError,
  MessagePayloadMismatchError,
} from '../../../src/application/application.errors.js';
import type { InboxDelivery } from '../../../src/application/messaging/inbox-delivery.js';
import { InjectedFault } from './support/in-memory-unit-of-work.js';
import {
  balanceOf,
  createHarness,
  ledgerOf,
  openWallet,
  wager,
  type Harness,
} from './support/wagering-harness.js';

let h: Harness;

beforeEach(() => {
  h = createHarness();
});

const delivery = (
  messageId: string,
  payloadHash = 'a'.repeat(64),
): InboxDelivery => ({
  consumerName: 'wager-consumer',
  messageId,
  payloadHash,
});

const inboxOf = (messageId: string) =>
  h.uow.tables.inbox.filter((row) => row.messageId === messageId);

async function caught(action: Promise<unknown>): Promise<unknown> {
  try {
    await action;
  } catch (error) {
    return error;
  }
  return undefined;
}

describe('SubmitWagerTransaction.executeMessage', () => {
  it('applies the operation and confirms the inbox in the same unit of work', async () => {
    const wallet = await openWallet(h);
    const commitsBefore = h.uow.commits;
    const submission = await h.submit.executeMessage(
      wager(wallet),
      delivery('m-1'),
    );
    expect(submission.outcome).toBe('APPLIED');
    expect(balanceOf(h, wallet.id)).toBe('75.00');
    const [row] = inboxOf('m-1');
    expect(row?.processedAt).not.toBeNull();
    expect(h.uow.commits - commitsBefore).toBe(2);
  });

  it('turns a redelivered messageId into a no-op', async () => {
    const wallet = await openWallet(h);
    const command = wager(wallet);
    await h.submit.executeMessage(command, delivery('m-2'));
    const again = await h.submit.executeMessage(command, delivery('m-2'));
    expect(again.outcome).toBe('DUPLICATE_MESSAGE');
    expect(ledgerOf(h, wallet.id)).toHaveLength(2);
    expect(inboxOf('m-2')).toHaveLength(1);
  });

  it('refuses a known messageId with another payload hash', async () => {
    const wallet = await openWallet(h);
    await h.submit.executeMessage(wager(wallet), delivery('m-3'));
    expect(
      await caught(
        h.submit.executeMessage(wager(wallet), delivery('m-3', 'b'.repeat(64))),
      ),
    ).toBeInstanceOf(MessagePayloadMismatchError);
  });

  it('replays the financial result for a new messageId and still records it', async () => {
    const wallet = await openWallet(h);
    const command = wager(wallet);
    await h.submit.executeMessage(command, delivery('m-4'));
    const replay = await h.submit.executeMessage(command, delivery('m-5'));
    expect(replay).toMatchObject({
      outcome: 'APPLIED',
      result: { idempotentReplay: true },
    });
    expect(inboxOf('m-5')[0]?.processedAt).not.toBeNull();
    expect(balanceOf(h, wallet.id)).toBe('75.00');
  });

  it('records nothing in the inbox when the financial step conflicts', async () => {
    const wallet = await openWallet(h);
    const command = wager(wallet);
    await h.submit.executeMessage(command, delivery('m-6'));
    const conflicting = {
      ...command,
      money: { amount: '30.00', currency: 'BRL' },
    };
    expect(
      await caught(h.submit.executeMessage(conflicting, delivery('m-7'))),
    ).toBeInstanceOf(IdempotencyConflictError);
    expect(inboxOf('m-7')).toHaveLength(0);
  });

  it('rolls the inbox back together with the wallet when the outbox write fails', async () => {
    const wallet = await openWallet(h);
    h.uow.faults.add('outbox.enqueue');
    expect(
      await caught(h.submit.executeMessage(wager(wallet), delivery('m-8'))),
    ).toBeInstanceOf(InjectedFault);
    expect(inboxOf('m-8')).toHaveLength(0);
    expect(balanceOf(h, wallet.id)).toBe('100.00');
    h.uow.faults.clear();
    const retry = await h.submit.executeMessage(
      wager(wallet, {
        externalTransactionId: 'retry-ext',
      }),
      delivery('m-9'),
    );
    expect(retry.outcome).toBe('APPLIED');
  });

  it('completes an inbox row left received but unprocessed', async () => {
    const wallet = await openWallet(h);
    h.uow.tables.inbox.push({
      consumerName: 'wager-consumer',
      messageId: 'm-10',
      payloadHash: 'a'.repeat(64),
      receivedAt: new Date('2026-01-01T00:00:00.000Z'),
      processedAt: null,
    });
    const submission = await h.submit.executeMessage(
      wager(wallet),
      delivery('m-10'),
    );
    expect(submission.outcome).toBe('APPLIED');
    expect(inboxOf('m-10')).toHaveLength(1);
    expect(inboxOf('m-10')[0]?.processedAt).not.toBeNull();
  });

  it('keeps the HTTP entry point free of inbox writes', async () => {
    const wallet = await openWallet(h);
    await h.submit.execute(wager(wallet));
    expect(h.uow.tables.inbox).toHaveLength(0);
  });
});
