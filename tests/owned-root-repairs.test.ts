import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { reserveRoot } from '../packages/execution/src/root-reservations.ts';
import { mkdtempSync, rmSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { Journal } from '../packages/execution/src/journal.ts';
import { OfflineFanoutController } from '../packages/execution/src/fanout-controller.ts';
import { leaderEventSchema } from '../packages/execution/src/copier-events.ts';
import { MockVestAdapter } from '../packages/simulator/src/index.ts';
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
    100,
  );
  const binding = {
    environment: 'OFFLINE_FIXTURE' as const,
    evidence: 'SYNTHETIC' as const,
    leaderAccountId: '01',
    sourceId: 'owned-repair-fixture',
    symbol: 'NDX' as const,
    baselineSequence: 0,
  };
  journal.copier.registerLeaderStream(binding);
  const arm = {
    environment: binding.environment,
    evidence: binding.evidence,
    leaderAccountId: '01',
    followerAccountIds: ['02', '03'],
    symbol: binding.symbol,
    maxLeverage: '50',
    maxNotionalPerAccount: '100000',
    maxPlannedLossPerAccount: '10000',
    expiresAt: NOW + 10000,
  };
  await copier.arm(arm);
  const providerEventId = randomUUID(),
    entry = leaderEventSchema.parse({
      environment: binding.environment,
      evidence: binding.evidence,
      leaderAccountId: binding.leaderAccountId,
      sourceId: binding.sourceId,
      symbol: binding.symbol,
      origin: 'ACCEPTED_EVENT',
      providerEventId,
      entryRootId: providerEventId,
      sequence: 1,
      occurredAt: NOW,
      kind: 'ENTRY',
      side: 'LONG',
      quantity: '1',
      leverage: '50',
    });
  const entryId = copier.acceptSyntheticLeaderEvent(entry).eventId;
  await copier.copyEntry(entryId, intent);
  let sequence = 1;
  const change = (kind: 'ADD' | 'REDUCE' | 'STOP_CHANGED', value = '0.5') =>
    copier.acceptSyntheticLeaderEvent(
      leaderEventSchema.parse({
        ...entry,
        providerEventId: randomUUID(),
        sequence: ++sequence,
        kind,
        quantity: kind === 'STOP_CHANGED' ? '1' : value,
        ...(kind === 'STOP_CHANGED' ? { price: value } : {}),
      }),
    ).eventId;
  await copier.copyChange(change('ADD', '0.25'));
  const root = (accountId = '02') =>
    journal.mutations.roots().find((r) => r.accountId === accountId)!;
  const remove = async (
    accountId: string,
    type: 'STOP_LOSS' | 'TAKE_PROFIT',
  ) => {
    const order = (await adapter.getOpenOrders(accountId)).find(
      (o) => o.type === type,
    )!;
    await adapter.cancelOrder(accountId, order.orderId);
  };
  return { journal, adapter, copier, entryId, change, root, remove, arm };
}
describe('current-root operator repairs', () => {
  it('adds a missing stop after ADD at the current quantity without inventing leader events', async () => {
    const f = await fixture();
    try {
      await f.remove('02', 'STOP_LOSS');
      const root = f.root(),
        events = f.journal.copier.leaderEvents().length,
        fill = f.copier.snapshot(f.entryId)[0]!.attempt!.outcome.filledQuantity;
      const result = await f.copier.repairOwnedRoot({
        actionId: randomUUID(),
        rootId: root.rootId,
        expectedRootRevision: root.revision,
        operation: 'ADD_STOP',
        price: '30350',
      });
      expect(result.state).toBe('VERIFIED');
      expect(
        (await f.adapter.getOpenOrders('02')).find(
          (o) => o.type === 'STOP_LOSS',
        )!.quantity,
      ).toBe(root.quantity);
      expect(f.journal.copier.leaderEvents()).toHaveLength(events);
      expect(
        f.copier.snapshot(f.entryId)[0]!.attempt!.outcome.filledQuantity,
      ).toBe(fill);
      expect(result.request!.operator!.action).toBe('ADD_STOP');
    } finally {
      f.journal.close();
    }
  });
  it('flattens remaining exposure after partial REDUCE while preserving historical fill size', async () => {
    const f = await fixture();
    try {
      f.adapter.injectOwnedMutationFault('02', 'PARTIAL_REDUCE');
      await f.copier.copyChange(f.change('REDUCE', '0.5'));
      const root = f.root(),
        fill = f.copier.snapshot(f.entryId)[0]!.attempt!.outcome.filledQuantity;
      const result = await f.copier.repairOwnedRoot({
        actionId: randomUUID(),
        rootId: root.rootId,
        expectedRootRevision: root.revision,
        operation: 'FLATTEN',
      });
      expect(result.state).toBe('VERIFIED');
      expect((await f.adapter.getAccountState('02')).positions).toEqual([]);
      expect(await f.adapter.getOpenOrders('02')).toEqual([]);
      expect(f.root().closed).toBe(true);
      expect(f.copier.snapshot(f.entryId)[0]!.attempt!.outcome).toMatchObject({
        filledQuantity: fill,
        exposure: 'ABSENT',
      });
    } finally {
      f.journal.close();
    }
  });
  it('replays action IDs while locked and rejects payload changes or stale revision before effects', async () => {
    const f = await fixture();
    try {
      const root = f.root(),
        request = {
          actionId: randomUUID(),
          rootId: root.rootId,
          expectedRootRevision: root.revision,
          operation: 'FLATTEN' as const,
        };
      const send = vi.spyOn(f.adapter, 'closeOwnedPosition');
      await f.copier.repairOwnedRoot(request);
      f.copier.lock();
      expect((await f.copier.repairOwnedRoot(request)).state).toBe('VERIFIED');
      expect(send).toHaveBeenCalledTimes(1);
      await expect(
        f.copier.repairOwnedRoot({
          ...request,
          expectedRootRevision: root.revision + 1,
        }),
      ).rejects.toThrow('OWNED_REPAIR_IDENTITY_CONFLICT');
    } finally {
      f.journal.close();
    }
  });
  it('refuses stale revision and existing protection, never replacing an exit through Add', async () => {
    const f = await fixture();
    try {
      const root = f.root(),
        send = vi.spyOn(f.adapter, 'changeOwnedProtection');
      const a = await f.copier.repairOwnedRoot({
        actionId: randomUUID(),
        rootId: root.rootId,
        expectedRootRevision: root.revision - 1,
        operation: 'ADD_STOP',
        price: '30350',
      });
      expect(a.state).toBe('REFUSED');
      const b = await f.copier.repairOwnedRoot({
        actionId: randomUUID(),
        rootId: root.rootId,
        expectedRootRevision: root.revision,
        operation: 'ADD_STOP',
        price: '30350',
      });
      expect(b.reason).toBe('OWNED_REPAIR_PROTECTION_ALREADY_PRESENT');
      expect(send).not.toHaveBeenCalled();
    } finally {
      f.journal.close();
    }
  });
  it('UNKNOWN operator creation blocks future operator and leader commands on that root', async () => {
    const f = await fixture();
    try {
      await f.remove('02', 'STOP_LOSS');
      f.adapter.injectOwnedMutationFault('02', 'UNKNOWN_BEFORE');
      const root = f.root();
      const result = await f.copier.repairOwnedRoot({
        actionId: randomUUID(),
        rootId: root.rootId,
        expectedRootRevision: root.revision,
        operation: 'ADD_STOP',
        price: '30350',
      });
      expect(result.state).toBe('UNKNOWN');
      const send = vi.spyOn(f.adapter, 'closeOwnedPosition');
      const next = await f.copier.repairOwnedRoot({
        actionId: randomUUID(),
        rootId: root.rootId,
        expectedRootRevision: f.root().revision,
        operation: 'FLATTEN',
      });
      expect(next.state).toBe('REFUSED');
      expect(send).not.toHaveBeenCalled();
      const leader = await f.copier.copyChange(
        f.change('STOP_CHANGED', '30360'),
      );
      expect(leader.find((r) => r.accountId === '02')!.state).toBe('NOT_SENT');
      expect(leader.find((r) => r.accountId === '03')!.state).toBe('VERIFIED');
    } finally {
      f.journal.close();
    }
  });
  it('lost acknowledgements reconcile read-only while locked and never resend', async () => {
    const f = await fixture();
    try {
      await f.remove('02', 'TAKE_PROFIT');
      f.adapter.injectOwnedMutationFault('02', 'UNKNOWN_AFTER');
      const root = f.root();
      const row = await f.copier.repairOwnedRoot({
        actionId: randomUUID(),
        rootId: root.rootId,
        expectedRootRevision: root.revision,
        operation: 'ADD_TARGET',
        price: '30500',
      });
      expect(row.state).toBe('UNKNOWN');
      f.copier.lock();
      const send = vi.spyOn(f.adapter, 'changeOwnedProtection');
      expect((await f.copier.reconcileOwnedRepair(row.operationId)).state).toBe(
        'VERIFIED',
      );
      expect(send).not.toHaveBeenCalled();
    } finally {
      f.journal.close();
    }
  });
  it('leader uncertainty blocks a current-root flatten', async () => {
    const f = await fixture();
    try {
      f.adapter.injectOwnedMutationFault('02', 'UNKNOWN_BEFORE');
      await f.copier.copyChange(f.change('REDUCE', '0.5'));
      const root = f.root(),
        send = vi.spyOn(f.adapter, 'closeOwnedPosition');
      const row = await f.copier.repairOwnedRoot({
        actionId: randomUUID(),
        rootId: root.rootId,
        expectedRootRevision: root.revision,
        operation: 'FLATTEN',
      });
      expect(row.state).toBe('REFUSED');
      expect(send).not.toHaveBeenCalled();
    } finally {
      f.journal.close();
    }
  });
  it('repair and leader work share one account lane while another follower finishes', async () => {
    const f = await fixture();
    let release!: () => void;
    try {
      await f.remove('02', 'STOP_LOSS');
      let started!: () => void;
      const gate = new Promise<void>((r) => {
          release = r;
        }),
        beginning = new Promise<void>((r) => {
          started = r;
        });
      const original = f.adapter.changeOwnedProtection.bind(f.adapter);
      vi.spyOn(f.adapter, 'changeOwnedProtection').mockImplementation(
        async (request) => {
          if (request.operator && request.accountId === '02') {
            started();
            await gate;
          }
          return original(request);
        },
      );
      const root = f.root(),
        repair = f.copier.repairOwnedRoot({
          actionId: randomUUID(),
          rootId: root.rootId,
          expectedRootRevision: root.revision,
          operation: 'ADD_STOP',
          price: '30350',
        });
      await beginning;
      const leader = f.copier.copyChange(f.change('REDUCE', '0.25'));
      await new Promise((r) => setImmediate(r));
      expect(f.root('03').quantity).not.toBe(root.quantity);
      release();
      await repair;
      await leader;
      expect(f.root().certainty).toBe('PRESENT');
    } finally {
      release?.();
      f.journal.close();
    }
  });
  it('reconciles canceled protection while locked without changing position or sending orders', async () => {
    const f = await fixture();
    try {
      await f.remove('02', 'STOP_LOSS');
      f.copier.lock();
      const send = vi.spyOn(f.adapter, 'changeOwnedProtection');
      const root = await f.copier.reconcileOwnedRoot(f.root().rootId);
      expect(root.stopId).toBeNull();
      expect(root.certainty).toBe('PRESENT');
      expect(send).not.toHaveBeenCalled();
    } finally {
      f.journal.close();
    }
  });
  it('manual exits reconcile flat and subsequent genuine leader changes never reopen that follower', async () => {
    const f = await fixture();
    try {
      await f.adapter.closePosition('02');
      const root = await f.copier.reconcileOwnedRoot(f.root().rootId);
      expect(root.closed).toBe(true);
      const send = vi.spyOn(f.adapter, 'addOwnedPosition');
      await f.copier.copyChange(f.change('ADD', '0.25'));
      expect(send.mock.calls.some(([r]) => r.accountId === '02')).toBe(false);
    } finally {
      f.journal.close();
    }
  });
  it('an uncertain repair cannot be cleared by merely observing empty books', async () => {
    const f = await fixture();
    try {
      f.adapter.injectOwnedMutationFault('02', 'UNKNOWN_BEFORE');
      const root = f.root();
      const row = await f.copier.repairOwnedRoot({
        actionId: randomUUID(),
        rootId: root.rootId,
        expectedRootRevision: root.revision,
        operation: 'FLATTEN',
      });
      await f.adapter.closePosition('02');
      await expect(f.copier.reconcileOwnedRoot(root.rootId)).rejects.toThrow(
        'OWNED_REPAIR_RECONCILIATION_REQUIRED',
      );
      expect((await f.copier.reconcileOwnedRepair(row.operationId)).state).toBe(
        'UNKNOWN',
      );
      expect(f.root().certainty).toBe('UNKNOWN');
    } finally {
      f.journal.close();
    }
  });
  it('wrong operator receipt identity halts globally rather than verifying a repair', async () => {
    const f = await fixture();
    try {
      const root = f.root(),
        original = f.adapter.closeOwnedPosition.bind(f.adapter);
      vi.spyOn(f.adapter, 'closeOwnedPosition').mockImplementation(
        async (request) => ({ ...(await original(request)), accountId: '03' }),
      );
      const row = await f.copier.repairOwnedRoot({
        actionId: randomUUID(),
        rootId: root.rootId,
        expectedRootRevision: root.revision,
        operation: 'FLATTEN',
      });
      expect(row.state).toBe('UNKNOWN');
      expect(f.copier.status()).toBe('HALTED');
    } finally {
      f.journal.close();
    }
  });
  it('a journal settle failure halts globally even when the provider already flattened', async () => {
    const f = await fixture();
    try {
      const root = f.root();
      vi.spyOn(f.journal.ownedRepairs, 'settle').mockImplementationOnce(() => {
        throw new Error('OWNED_REPAIR_STORAGE_FAILED');
      });
      await expect(
        f.copier.repairOwnedRoot({
          actionId: randomUUID(),
          rootId: root.rootId,
          expectedRootRevision: root.revision,
          operation: 'FLATTEN',
        }),
      ).rejects.toThrow();
      expect(f.copier.status()).toBe('HALTED');
      expect((await f.adapter.getAccountState('02')).positions).toEqual([]);
      const row = f.journal.ownedRepairs.records()[0]!;
      expect(row.state).toBe('DISPATCHING');
      expect((await f.copier.reconcileOwnedRepair(row.operationId)).state).toBe(
        'VERIFIED',
      );
      expect(f.copier.status()).toBe('HALTED');
    } finally {
      f.journal.close();
    }
  });
  it('lowered risk ceilings do not prevent a correctly scoped risk-reducing flatten', async () => {
    const f = await fixture();
    try {
      await new Promise((r) => setImmediate(r));
      f.copier.lock();
      await f.copier.arm({
        ...f.arm,
        maxLeverage: '1',
        maxNotionalPerAccount: '1',
        maxPlannedLossPerAccount: '1',
      });
      const root = f.root();
      expect(
        (
          await f.copier.repairOwnedRoot({
            actionId: randomUUID(),
            rootId: root.rootId,
            expectedRootRevision: root.revision,
            operation: 'FLATTEN',
          })
        ).state,
      ).toBe('VERIFIED');
    } finally {
      f.journal.close();
    }
  });
  it.each([false, true])(
    'read-only reconciliation refuses a reservation acquired during reads (changed=%s)',
    async (changed) => {
      const directory = mkdtempSync(join(tmpdir(), 'owned-reconcile-race-'));
      const path = join(directory, 'journal.sqlite');
      const f = await fixture(path);
      const peer = new DatabaseSync(path);
      try {
        if (changed) await f.remove('02', 'STOP_LOSS');
        const root = f.root();
        const original = f.adapter.getOpenOrders.bind(f.adapter);
        let release!: () => void, started!: () => void;
        const gate = new Promise<void>((resolve) => {
          release = resolve;
        });
        const reached = new Promise<void>((resolve) => {
          started = resolve;
        });
        vi.spyOn(f.adapter, 'getOpenOrders').mockImplementationOnce(
          async (accountId) => {
            const value = await original(accountId);
            started();
            await gate;
            return value;
          },
        );
        const pending = f.copier.reconcileOwnedRoot(root.rootId);
        const refused = expect(pending).rejects.toThrow(
          'ROOT_RESERVATION_BUSY',
        );
        await reached;
        peer.exec('BEGIN IMMEDIATE');
        reserveRoot(peer, {
          rootId: root.rootId,
          commandId: 'f'.repeat(64),
          kind: 'LEADER_EVENT',
          ownerGeneration: randomUUID(),
          rootRevision: root.revision,
          at: NOW,
        });
        peer.exec('COMMIT');
        release();
        await refused;
        expect(f.root()).toEqual(root);
        expect(f.journal.mutations.reservation(root.rootId)?.commandId).toBe(
          'f'.repeat(64),
        );
      } finally {
        peer.close();
        f.journal.close();
        rmSync(directory, { recursive: true, force: true });
      }
    },
  );
  it('older provider revisions cannot clear current exposure using a fresh flat snapshot', async () => {
    const f = await fixture();
    try {
      const root = f.root(),
        history = f.copier.snapshot(f.entryId);
      const accounts = await f.adapter.listAccounts();
      vi.spyOn(f.adapter, 'listAccounts').mockResolvedValue(
        accounts.map((account) =>
          account.accountId === '02'
            ? { ...account, positions: [], revision: root.providerRevision - 1 }
            : account,
        ),
      );
      vi.spyOn(f.adapter, 'getOpenOrders').mockResolvedValue([]);
      await expect(f.copier.reconcileOwnedRoot(root.rootId)).rejects.toThrow(
        'OWNED_REPAIR_STALE_EVIDENCE',
      );
      expect(f.root()).toEqual(root);
      expect(f.copier.snapshot(f.entryId)).toEqual(history);
      expect(() =>
        f.journal.mutations.updateRoot(root.rootId, root.revision, {
          providerRevision: root.providerRevision - 1,
        }),
      ).toThrow('MUTATION_ROOT_REFUSED');
    } finally {
      f.journal.close();
    }
  });
  it('sanitizes current-root submission and read errors without persisting synthetic secrets', async () => {
    const marker = 'synthetic-secret_4b845593195a4a19a16c807f323cdeac';
    const directory = mkdtempSync(join(tmpdir(), 'owned-repair-canary-'));
    const f = await fixture(join(directory, 'journal.sqlite'));
    try {
      const root = f.root();
      vi.spyOn(f.adapter, 'closeOwnedPosition').mockRejectedValueOnce(
        new Error(marker),
      );
      const row = await f.copier.repairOwnedRoot({
        actionId: randomUUID(),
        rootId: root.rootId,
        expectedRootRevision: root.revision,
        operation: 'FLATTEN',
      });
      expect(row.state).toBe('UNKNOWN');
      expect(JSON.stringify(row)).not.toContain(marker);
      vi.spyOn(f.adapter, 'readOwnedMutation').mockRejectedValueOnce(
        new Error(marker),
      );
      await expect(
        f.copier.reconcileOwnedRepair(row.operationId),
      ).rejects.toThrow('OWNED_REPAIR_RECONCILE_UNCONFIRMED');
      expect(JSON.stringify(f.journal.ownedRepairs.records())).not.toContain(
        marker,
      );
      expect(JSON.stringify(f.journal.mutations.roots())).not.toContain(marker);
      expect(JSON.stringify(f.journal.events())).not.toContain(marker);
      for (const name of readdirSync(directory))
        expect(
          readFileSync(join(directory, name)).toString('latin1'),
        ).not.toContain(marker);
    } finally {
      f.journal.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
  it('reconciliation integrity failure locks new execution globally', async () => {
    const f = await fixture();
    try {
      vi.spyOn(f.journal.mutations, 'reconcileIdleRoot').mockImplementationOnce(
        () => {
          throw new Error('ROOT_RESERVATION_STORAGE_INVALID');
        },
      );
      await expect(
        f.copier.reconcileOwnedRoot(f.root().rootId),
      ).rejects.toThrow('ROOT_RESERVATION_STORAGE_INVALID');
      expect(f.copier.status()).toBe('HALTED');
    } finally {
      f.journal.close();
    }
  });
  it('revoking arming during fresh evidence collection prevents dispatch', async () => {
    const f = await fixture();
    try {
      const original = f.adapter.listAccounts.bind(f.adapter);
      let release!: () => void;
      let started!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const reached = new Promise<void>((resolve) => {
        started = resolve;
      });
      vi.spyOn(f.adapter, 'listAccounts').mockImplementationOnce(async () => {
        started();
        await gate;
        return original();
      });
      const send = vi.spyOn(f.adapter, 'closeOwnedPosition');
      const root = f.root();
      const pending = f.copier.repairOwnedRoot({
        actionId: randomUUID(),
        rootId: root.rootId,
        expectedRootRevision: root.revision,
        operation: 'FLATTEN',
      });
      await reached;
      f.copier.lock();
      release();
      expect((await pending).state).toBe('REFUSED');
      expect(send).not.toHaveBeenCalled();
      expect(f.copier.status()).toBe('LOCKED');
      expect(f.journal.mutations.reservation(root.rootId)).toBeNull();
    } finally {
      f.journal.close();
    }
  });
  it('restart stays locked and replays durable operator outcomes with no extra effect', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'owned-repair-restart-'));
    const f = await fixture(join(dir, 'journal.sqlite'));
    const root = f.root(),
      request = {
        actionId: randomUUID(),
        rootId: root.rootId,
        expectedRootRevision: root.revision,
        operation: 'FLATTEN' as const,
      };
    await f.copier.repairOwnedRoot(request);
    const saved = f.adapter.exportSnapshot();
    f.journal.close();
    const journal = new Journal(join(dir, 'journal.sqlite')),
      adapter = new MockVestAdapter(
        config,
        () => NOW,
        undefined,
        '30400',
        undefined,
        undefined,
        saved,
      );
    try {
      await adapter.connect();
      const copier = new OfflineFanoutController(
        adapter,
        config,
        journal,
        () => NOW,
      );
      const send = vi.spyOn(adapter, 'closeOwnedPosition');
      expect(copier.status()).toBe('LOCKED');
      expect((await copier.repairOwnedRoot(request)).state).toBe('VERIFIED');
      expect(send).not.toHaveBeenCalled();
    } finally {
      journal.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
