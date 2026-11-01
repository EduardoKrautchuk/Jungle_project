import { describe, expect, it } from 'bun:test';
import { WalletBalanceChanged } from '../../../src/application/events/wagering-events.js';
import { LedgerDirection } from '../../../src/domain/ledger/ledger-direction.js';
import { OutboxMessage } from '../../../src/domain/messaging/outbox-message.js';
import { Money } from '../../../src/domain/money/money.js';
import { Wallet } from '../../../src/domain/wallet/wallet.js';

describe('integration events', () => {
  it('serializes the envelope with MoneyProps and enqueues it in the outbox', () => {
    const at = new Date('2026-10-31T12:00:00.000Z');
    const { wallet } = Wallet.open({
      id: 'w-1',
      playerId: 'p-1',
      initialBalance: Money.from({ amount: '10.00', currency: 'BRL' }),
      at,
      opening: { entryId: 'e-0', transactionId: 't-0' },
    });
    const entry = wallet.debit(
      Money.from({ amount: '2.50', currency: 'BRL' }),
      {
        entryId: 'e-1',
        transactionId: 't-1',
        at,
      },
    );
    const event = WalletBalanceChanged.from(wallet, entry, {
      eventId: 'ev-1',
      correlationId: 'corr-1',
      occurredAt: at,
    });

    expect(event.toJSON()).toEqual({
      eventId: 'ev-1',
      eventType: 'WalletBalanceChanged',
      aggregateId: 'w-1',
      correlationId: 'corr-1',
      occurredAt: '2026-10-31T12:00:00.000Z',
      version: 1,
      data: {
        walletId: 'w-1',
        transactionId: 't-1',
        direction: LedgerDirection.Debit,
        money: { amount: '2.50', currency: 'BRL' },
        balanceBefore: { amount: '10.00', currency: 'BRL' },
        balanceAfter: { amount: '7.50', currency: 'BRL' },
        walletVersion: 2,
      },
    });
    const message = OutboxMessage.enqueue(event);
    expect(message.eventType).toBe('WalletBalanceChanged');
    expect(message.payload).toEqual(event.toJSON());
  });
});
