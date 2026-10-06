import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { Journal } from '../packages/execution/src/journal.ts';
import { OfflineFanoutController } from '../packages/execution/src/fanout-controller.ts';
import { MockVestAdapter } from '../packages/simulator/src/index.ts';
import {
  copierHash,
  leaderEventSchema,
} from '../packages/execution/src/copier-events.ts';
import { config, intent, NOW } from './helpers.ts';
async function fixture() {
  const journal = new Journal(),
    adapter = new MockVestAdapter(config, () => NOW, undefined, '30400');
  await adapter.connect();
  const copier = new OfflineFanoutController(
    adapter,
    config,
    journal,
    () => NOW,
    50,
  );
  journal.copier.registerLeaderStream({
    environment: 'OFFLINE_FIXTURE',
    evidence: 'SYNTHETIC',
    leaderAccountId: '01',
    sourceId: 'repair-fixture',
    symbol: 'NDX',
    baselineSequence: 0,
  });
  await copier.arm({
    environment: 'OFFLINE_FIXTURE',
    evidence: 'SYNTHETIC',
    leaderAccountId: '01',
    followerAccountIds: ['02', '03'],
    symbol: 'NDX',
    maxLeverage: '50',
    maxNotionalPerAccount: '100000',
    maxPlannedLossPerAccount: '10000',
    expiresAt: NOW + 10000,
  });
  const providerEventId = randomUUID();
  const event = copier.acceptSyntheticLeaderEvent(
    leaderEventSchema.parse({
      environment: 'OFFLINE_FIXTURE',
      evidence: 'SYNTHETIC',
      origin: 'ACCEPTED_EVENT',
      leaderAccountId: '01',
      sourceId: 'repair-fixture',
      symbol: 'NDX',
      providerEventId,
      entryRootId: providerEventId,
      sequence: 1,
      occurredAt: NOW,
      kind: 'ENTRY',
      side: 'LONG',
      quantity: '1',
      leverage: '50',
    }),
  );
  return { journal, adapter, copier, eventId: event.eventId };
}
describe('fresh scoped repair evidence', () => {
  it('does not retain a cached target when it is canceled during stop repair', async () => {
    const f = await fixture();
    f.adapter.injectProtectionFault('02', 'STOP_LOSS', 'REJECT');
    await f.copier.copyEntry(f.eventId, intent);
    const attempt = f.copier
      .snapshot(f.eventId)
      .find((row) => row.accountId === '02')!.attempt!;
    const position = (await f.adapter.getAccountState('02')).positions[0]!;
    const targetId = copierHash([attempt.attemptId, 'TAKE_PROFIT']);
    await f.adapter.placeProtectionOrder({
      requestId: targetId,
      masterTradeId: f.eventId,
      entryRequestId: attempt.attemptId,
      accountId: '02',
      symbol: 'NDX',
      positionSide: 'LONG',
      type: 'TAKE_PROFIT',
      quantity: position.quantity,
      triggerPrice: String(Number(position.entryPrice) + 80),
      reduceOnly: true,
    });
    await f.copier.repair(f.eventId, '02', 'RECONCILE');
    const original = f.adapter.getProtectionOrder.bind(f.adapter);
    const stopId = copierHash([attempt.attemptId, 'STOP_LOSS']);
    vi.spyOn(f.adapter, 'getProtectionOrder').mockImplementation(
      async (accountId, id) => {
        const result = await original(accountId, id);
        if (accountId === '02' && id !== stopId && result?.type === 'STOP_LOSS')
          await f.adapter.cancelOrder('02', targetId);
        return result;
      },
    );
    const result = await f.copier.repair(f.eventId, '02', 'ADD_STOP');
    expect(result.update.attempt?.outcome).toMatchObject({
      stop: 'VERIFIED',
      target: 'UNKNOWN',
      reason: 'TP_MISSING',
    });
    f.journal.close();
  });
  it('does not retain exposure or invent an exit if position disappears after repair acknowledgement', async () => {
    const f = await fixture();
    f.adapter.injectProtectionFault('02', 'STOP_LOSS', 'REJECT');
    await f.copier.copyEntry(f.eventId, intent);
    const attempt = f.copier
      .snapshot(f.eventId)
      .find((row) => row.accountId === '02')!.attempt!;
    const stopId = copierHash([attempt.attemptId, 'STOP_LOSS']);
    const original = f.adapter.getProtectionOrder.bind(f.adapter);
    vi.spyOn(f.adapter, 'getProtectionOrder').mockImplementation(
      async (accountId, id) => {
        const result = await original(accountId, id);
        if (accountId === '02' && id !== stopId && result?.type === 'STOP_LOSS')
          await f.adapter.closePosition('02');
        return result;
      },
    );
    const result = await f.copier.repair(f.eventId, '02', 'ADD_STOP');
    expect(result.repair?.state).toBe('UNKNOWN');
    expect(result.update.attempt?.outcome.exposure).toBe('UNKNOWN');
    expect(result.update.attempt?.terminal?.result).toBe('FILLED');
    f.journal.close();
  });
  it.each(['side', 'type'] as const)(
    'rejects wrong original protection %s before replacement',
    async (field) => {
      const f = await fixture();
      f.adapter.injectProtectionFault('02', 'STOP_LOSS', 'REJECT');
      await f.copier.copyEntry(f.eventId, intent);
      const original = f.adapter.getProtectionOrder.bind(f.adapter);
      vi.spyOn(f.adapter, 'getProtectionOrder').mockImplementation(
        async (accountId, id) => {
          const result = await original(accountId, id);
          return result && accountId === '02'
            ? {
                ...result,
                ...(field === 'side'
                  ? { positionSide: 'SHORT' as const }
                  : { type: 'TAKE_PROFIT' as const }),
              }
            : result;
        },
      );
      const send = vi.spyOn(f.adapter, 'repairOwnedProtection');
      await expect(
        f.copier.repair(f.eventId, '02', 'ADD_STOP'),
      ).rejects.toThrow();
      expect(send).not.toHaveBeenCalled();
      expect(f.copier.status()).toBe('HALTED');
      f.journal.close();
    },
  );
  it('cannot retry an old leader event under a different armed leader', async () => {
    const f = await fixture();
    f.adapter.injectFault('02', 'REJECT');
    await f.copier.copyEntry(f.eventId, intent);
    const attempt = f.copier
      .snapshot(f.eventId)
      .find((row) => row.accountId === '02')!.attempt!;
    await new Promise<void>((resolve) => setImmediate(resolve));
    f.copier.lock();
    await f.copier.arm({
      environment: 'OFFLINE_FIXTURE',
      evidence: 'SYNTHETIC',
      leaderAccountId: '03',
      followerAccountIds: ['02'],
      symbol: 'NDX',
      maxLeverage: '50',
      maxNotionalPerAccount: '100000',
      maxPlannedLossPerAccount: '10000',
      expiresAt: NOW + 10000,
    });
    const send = vi.spyOn(f.adapter, 'placeOrder');
    await expect(
      f.copier.repair(f.eventId, '02', 'RETRY', attempt.attemptId),
    ).rejects.toThrow('RETRY_ENVELOPE_MISMATCH');
    expect(send).not.toHaveBeenCalled();
    f.journal.close();
  });
});
