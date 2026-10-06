import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { Journal } from '../packages/execution/src/journal.ts';
import { OfflineFanoutController } from '../packages/execution/src/fanout-controller.ts';
import { MockVestAdapter } from '../packages/simulator/src/index.ts';
import { leaderEventSchema } from '../packages/execution/src/copier-events.ts';
import { config, intent, NOW } from './helpers.ts';
async function fixture(path?: string) {
  const journal = new Journal(path),
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
describe('scoped offline copier repairs', () => {
  it('position disappearance cannot manufacture an exit or permit reopening', async () => {
    const f = await fixture();
    await f.copier.copyEntry(f.eventId, intent);
    await f.adapter.closePosition('02');
    const reconciled = await f.copier.repair(f.eventId, '02', 'RECONCILE');
    expect(reconciled.update.attempt?.outcome.exposure).toBe('UNKNOWN');
    expect(reconciled.update.attempt?.terminal?.result).toBe('FILLED');
    await expect(
      f.copier.repair(
        f.eventId,
        '02',
        'RETRY',
        f.copier.snapshot(f.eventId).find((r) => r.accountId === '02')!.attempt!
          .attemptId,
      ),
    ).rejects.toThrow('EXPLICIT_RETRY_UNPROVEN');
    const send = vi.spyOn(f.adapter, 'placeOrder');
    await f.copier.copyEntry(f.eventId, intent);
    expect(send).not.toHaveBeenCalled();
    f.journal.close();
  });
  it('repair queues behind actual unsettled entry work without blocking other accounts', async () => {
    const f = await fixture();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started!: () => void;
    const entering = new Promise<void>((resolve) => {
      started = resolve;
    });
    const original = f.adapter.placeOrder.bind(f.adapter);
    vi.spyOn(f.adapter, 'placeOrder').mockImplementation(async (request) => {
      if (request.accountId === '02') {
        started();
        await gate;
      }
      return original(request);
    });
    const copy = f.copier.copyEntry(f.eventId, intent);
    await entering;
    const reconcile = f.copier.repair(f.eventId, '02', 'RECONCILE');
    await copy;
    expect(
      f.copier.snapshot(f.eventId).find((row) => row.accountId === '03')
        ?.attempt?.outcome.target,
    ).toBe('VERIFIED');
    const read = vi.spyOn(f.adapter, 'getOrder');
    expect(read.mock.calls).toHaveLength(0);
    release();
    await reconcile;
    expect(read).toHaveBeenCalled();
    f.journal.close();
  });
  it('replaces a conclusively rejected stop once and preserves the filled entry', async () => {
    const f = await fixture();
    f.adapter.injectProtectionFault('02', 'STOP_LOSS', 'REJECT');
    await f.copier.copyEntry(f.eventId, intent);
    const send = vi.spyOn(f.adapter, 'repairOwnedProtection');
    const [a, b] = await Promise.all([
      f.copier.repair(f.eventId, '02', 'ADD_STOP'),
      f.copier.repair(f.eventId, '02', 'ADD_STOP'),
    ]);
    expect(a.repair?.state).toBe('VERIFIED');
    expect(b.repair?.state).toBe('VERIFIED');
    expect(send).toHaveBeenCalledOnce();
    expect(a.update.attempt?.outcome.stop).toBe('VERIFIED');
    expect(a.update.attempt?.outcome.exposure).toBe('PRESENT');
    expect(a.update.attempt?.outcome.reason).toBe('TP_MISSING');
    const target = await f.copier.repair(f.eventId, '02', 'ADD_TARGET');
    expect(target.repair?.state).toBe('VERIFIED');
    expect(target.update.attempt?.outcome).toMatchObject({
      stop: 'VERIFIED',
      target: 'VERIFIED',
      reason: 'NONE',
    });
    expect((await f.adapter.getAccountState('02')).positions).toHaveLength(1);
    f.journal.close();
  });
  it('repairs a rejected target independently of its verified stop', async () => {
    const f = await fixture();
    f.adapter.injectProtectionFault('02', 'TAKE_PROFIT', 'REJECT');
    await f.copier.copyEntry(f.eventId, intent);
    const repaired = await f.copier.repair(f.eventId, '02', 'ADD_TARGET');
    expect(repaired.repair?.state).toBe('VERIFIED');
    expect(repaired.update.attempt?.outcome).toMatchObject({
      stop: 'VERIFIED',
      target: 'VERIFIED',
    });
    f.journal.close();
  });
  it('does not retry missing or uncertain protection without terminal rejection proof', async () => {
    const f = await fixture();
    f.adapter.injectProtectionFault('02', 'STOP_LOSS', 'TIMEOUT_BEFORE_CREATE');
    await f.copier.copyEntry(f.eventId, intent);
    const send = vi.spyOn(f.adapter, 'repairOwnedProtection');
    await expect(f.copier.repair(f.eventId, '02', 'ADD_STOP')).rejects.toThrow(
      'PROTECTION_RETRY_UNPROVEN',
    );
    expect(send).not.toHaveBeenCalled();
    f.journal.close();
  });
  it('UNKNOWN stays reserved and never gets a blind entry retry', async () => {
    const f = await fixture();
    f.adapter.injectFault('02', 'TIMEOUT_BEFORE_FILL');
    await f.copier.copyEntry(f.eventId, intent);
    const send = vi.spyOn(f.adapter, 'placeOrder');
    const observed = await f.copier.repair(f.eventId, '02', 'RECONCILE');
    expect(observed.update.attempt?.outcome.submission).toBe('UNKNOWN');
    await expect(
      f.copier.repair(
        f.eventId,
        '02',
        'RETRY',
        f.copier.snapshot(f.eventId).find((r) => r.accountId === '02')!.attempt!
          .attemptId,
      ),
    ).rejects.toThrow('EXPLICIT_RETRY_UNPROVEN');
    expect(send).not.toHaveBeenCalled();
    f.journal.close();
  });
  it('an explicit retry links one new attempt after conclusively rejected entry', async () => {
    const f = await fixture();
    f.adapter.injectFault('02', 'REJECT');
    await f.copier.copyEntry(f.eventId, intent);
    const send = vi.spyOn(f.adapter, 'placeOrder');
    const repaired = await f.copier.repair(
      f.eventId,
      '02',
      'RETRY',
      f.copier.snapshot(f.eventId).find((r) => r.accountId === '02')!.attempt!
        .attemptId,
    );
    expect(send).toHaveBeenCalledOnce();
    expect(repaired.update.attempt?.number).toBe(2);
    expect(repaired.update.attempt?.outcome.target).toBe('VERIFIED');
    await expect(
      f.copier.repair(
        f.eventId,
        '02',
        'RETRY',
        f.copier.snapshot(f.eventId).find((r) => r.accountId === '02')!.attempt!
          .attemptId,
      ),
    ).rejects.toThrow('EXPLICIT_RETRY_UNPROVEN');
    f.journal.close();
  });
  it('flattens owned exposure once, records exit and never reopens on replay', async () => {
    const f = await fixture();
    await f.copier.copyEntry(f.eventId, intent);
    const close = vi.spyOn(f.adapter, 'flattenOwnedPosition');
    const result = await f.copier.repair(f.eventId, '02', 'FLATTEN');
    expect(result.repair?.state).toBe('VERIFIED');
    expect(result.update.attempt?.terminal?.result).toBe('EXITED');
    await f.copier.repair(f.eventId, '02', 'FLATTEN');
    expect(close).toHaveBeenCalledOnce();
    const send = vi.spyOn(f.adapter, 'placeOrder');
    await f.copier.copyEntry(f.eventId, intent);
    expect(send).not.toHaveBeenCalled();
    f.journal.close();
  });
  it('refuses unsupported conditional flatten without falling back to account-wide close', async () => {
    const f = await fixture();
    await f.copier.copyEntry(f.eventId, intent);
    Object.defineProperty(f.adapter, 'flattenOwnedPosition', {
      value: undefined,
    });
    const close = vi.spyOn(f.adapter, 'flattenAccount');
    await expect(f.copier.repair(f.eventId, '02', 'FLATTEN')).rejects.toThrow(
      'CONDITIONAL_FLATTEN_UNSUPPORTED',
    );
    expect(close).not.toHaveBeenCalled();
    f.journal.close();
  });
  it('atomic revision and ownership checks protect an unrelated position introduced after inspection', async () => {
    const f = await fixture();
    await f.copier.copyEntry(f.eventId, intent);
    const original = f.adapter.flattenOwnedPosition.bind(f.adapter),
      close = vi.spyOn(f.adapter, 'flattenAccount');
    vi.spyOn(f.adapter, 'flattenOwnedPosition').mockImplementation(
      async (scope) => {
        const accounts = (
          f.adapter as unknown as {
            accounts: Map<
              string,
              { revision: number; positions: { entryRequestId: string }[] }
            >;
          }
        ).accounts;
        const account = accounts.get('02')!;
        account.revision++;
        account.positions[0]!.entryRequestId = 'unrelated-entry';
        return original(scope);
      },
    );
    const result = await f.copier.repair(f.eventId, '02', 'FLATTEN');
    expect(result.repair?.state).toBe('UNKNOWN');
    expect(close).not.toHaveBeenCalled();
    expect(
      (await f.adapter.getAccountState('02')).positions[0]?.entryRequestId,
    ).toBe('unrelated-entry');
    f.journal.close();
  });
  it('a repair journal claim failure halts before any repair side effect', async () => {
    const f = await fixture();
    f.adapter.injectProtectionFault('02', 'STOP_LOSS', 'REJECT');
    await f.copier.copyEntry(f.eventId, intent);
    vi.spyOn(f.journal.repairs, 'claim').mockImplementation(() => {
      throw new Error('REPAIR_CLAIM_FAILED');
    });
    const send = vi.spyOn(f.adapter, 'repairOwnedProtection');
    await expect(
      f.copier.repair(f.eventId, '02', 'ADD_STOP'),
    ).rejects.toThrow();
    expect(send).not.toHaveBeenCalled();
    expect(f.copier.status()).toBe('HALTED');
    f.journal.close();
  });
  it('mutations require arming but read-only reconciliation remains available while locked', async () => {
    const f = await fixture();
    await f.copier.copyEntry(f.eventId, intent);
    f.copier.lock();
    await expect(f.copier.repair(f.eventId, '02', 'FLATTEN')).rejects.toThrow(
      'OFFLINE_REPAIR_LOCKED',
    );
    const result = await f.copier.repair(f.eventId, '02', 'RECONCILE');
    expect(result.update.attempt?.outcome.exposure).toBe('PRESENT');
    f.journal.close();
  });
  it('duplicate retries remain bound to the observed rejected attempt across restart', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'copier-retry-replay-'));
    const path = join(directory, 'journal.sqlite');
    const f = await fixture(path);
    f.adapter.injectFault('02', 'REJECT');
    await f.copier.copyEntry(f.eventId, intent);
    const original = f.copier
      .snapshot(f.eventId)
      .find((r) => r.accountId === '02')!.attempt!;
    const place = f.adapter.placeOrder.bind(f.adapter);
    const send = vi
      .spyOn(f.adapter, 'placeOrder')
      .mockImplementation(async (req) => {
        f.adapter.injectFault(req.accountId, 'REJECT');
        return place(req);
      });
    const results = await Promise.allSettled([
      f.copier.repair(f.eventId, '02', 'RETRY', original.attemptId),
      f.copier.repair(f.eventId, '02', 'RETRY', original.attemptId),
    ]);
    expect(results[0]!.status).toBe('fulfilled');
    expect(results[1]!.status).toBe('rejected');
    expect(send).toHaveBeenCalledOnce();
    await expect(
      f.copier.repair(f.eventId, '02', 'RETRY', original.attemptId),
    ).rejects.toThrow('REPAIR_ATTEMPT_STALE');
    expect(f.journal.copier.followerAttempts(original.commandId)).toHaveLength(
      2,
    );
    expect(send).toHaveBeenCalledOnce();
    const snapshot = f.adapter.exportSnapshot();
    f.journal.close();
    const journal = new Journal(path);
    const adapter = new MockVestAdapter(
      config,
      () => NOW,
      undefined,
      '30400',
      undefined,
      undefined,
      snapshot,
    );
    await adapter.connect();
    const restarted = new OfflineFanoutController(
      adapter,
      config,
      journal,
      () => NOW,
    );
    const restartedSend = vi.spyOn(adapter, 'placeOrder');
    expect(restarted.status()).toBe('LOCKED');
    await expect(
      restarted.repair(f.eventId, '02', 'RETRY', original.attemptId),
    ).rejects.toThrow('REPAIR_ATTEMPT_STALE');
    expect(restartedSend).not.toHaveBeenCalled();
    expect(journal.copier.followerAttempts(original.commandId)).toHaveLength(2);
    journal.close();
    rmSync(directory, { recursive: true, force: true });
  });
  it.each([
    { state: 'DISPATCHING', operation: 'ADD_STOP' as const },
    { state: 'VERIFIED', operation: 'ADD_STOP' as const },
    { state: 'VERIFIED', operation: 'FLATTEN' as const },
  ])(
    'halts on actual repair storage failure writing $state for $operation',
    async ({ state, operation }) => {
      const directory = mkdtempSync(join(tmpdir(), 'copier-repair-write-'));
      const path = join(directory, 'journal.sqlite');
      const f = await fixture(path);
      f.adapter.injectProtectionFault('02', 'STOP_LOSS', 'REJECT');
      await f.copier.copyEntry(f.eventId, intent);
      f.journal.repairs.get('0'.repeat(64));
      const db = new DatabaseSync(path);
      db.exec(`CREATE TRIGGER reject_repair_write BEFORE UPDATE ON copier_repairs
      WHEN json_extract(NEW.record,'$.state')='${state}'
      BEGIN SELECT RAISE(ABORT,'private storage failure'); END;`);
      const send =
        operation === 'FLATTEN'
          ? vi.spyOn(f.adapter, 'flattenOwnedPosition')
          : vi.spyOn(f.adapter, 'repairOwnedProtection');
      try {
        if (state === 'DISPATCHING') {
          await expect(
            f.copier.repair(f.eventId, '02', operation),
          ).rejects.toThrow('REPAIR_STORAGE_FAILED');
          expect(send).not.toHaveBeenCalled();
        } else {
          const result = await f.copier.repair(f.eventId, '02', operation);
          expect(result.repair?.state).toBe('UNKNOWN');
          expect(result.update.attempt?.outcome.exposure).toBe(
            operation === 'FLATTEN' ? 'ABSENT' : 'UNKNOWN',
          );
          if (operation === 'FLATTEN')
            expect(result.update.attempt?.terminal?.result).toBe('EXITED');
          expect(send).toHaveBeenCalledOnce();
        }
        expect(f.copier.status()).toBe('HALTED');
        expect(f.journal.copier.globalStop()).toBe('JOURNAL_INTEGRITY_LOST');
      } finally {
        db.close();
        f.journal.close();
        rmSync(directory, { recursive: true, force: true });
      }
    },
  );
  it('globally quarantines a repair acknowledgement for the wrong account', async () => {
    const f = await fixture();
    f.adapter.injectProtectionFault('02', 'STOP_LOSS', 'REJECT');
    await f.copier.copyEntry(f.eventId, intent);
    const repair = f.adapter.repairOwnedProtection.bind(f.adapter);
    vi.spyOn(f.adapter, 'repairOwnedProtection').mockImplementation(
      async (request, revision) => ({
        ...(await repair(request, revision)),
        accountId: '03',
      }),
    );
    const result = await f.copier.repair(f.eventId, '02', 'ADD_STOP');
    expect(result.repair?.state).toBe('UNKNOWN');
    expect(f.copier.status()).toBe('HALTED');
    expect(f.journal.copier.globalStop()).toBe('ACCOUNT_MAPPING_CORRUPT');
    f.journal.close();
  });
});
