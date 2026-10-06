import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { Journal } from '../packages/execution/src/journal.ts';
import { OfflineFanoutController } from '../packages/execution/src/fanout-controller.ts';
import {
  leaderEventSchema,
  type LeaderEvent,
} from '../packages/execution/src/copier-events.ts';
import { MockVestAdapter } from '../packages/simulator/src/index.ts';
import { config, intent, NOW } from './helpers.ts';

async function fixture(followerAccountIds = ['02', '03']) {
  const directory = mkdtempSync(join(tmpdir(), 'offline-lifecycle-'));
  const path = join(directory, 'journal.sqlite');
  let journal = new Journal(path);
  let adapter = new MockVestAdapter(config, () => NOW, undefined, '30400');
  await adapter.connect();
  const controller = () =>
    new OfflineFanoutController(adapter, config, journal, () => NOW, 100);
  let copier = controller();
  const arm = {
    environment: 'OFFLINE_FIXTURE' as const,
    evidence: 'SYNTHETIC' as const,
    leaderAccountId: '01',
    followerAccountIds,
    symbol: 'NDX' as const,
    maxLeverage: '50',
    maxNotionalPerAccount: '100000',
    maxPlannedLossPerAccount: '10000',
    expiresAt: NOW + 10000,
  };
  journal.copier.registerLeaderStream({
    environment: arm.environment,
    evidence: arm.evidence,
    leaderAccountId: arm.leaderAccountId,
    symbol: arm.symbol,
    sourceId: 'lifecycle-fixture',
    baselineSequence: 0,
  });
  await copier.arm(arm);
  let sequence = 0;
  let entry: LeaderEvent;
  const newEntry = () => {
    const providerEventId = randomUUID();
    entry = leaderEventSchema.parse({
      environment: arm.environment,
      evidence: arm.evidence,
      origin: 'ACCEPTED_EVENT',
      leaderAccountId: '01',
      sourceId: 'lifecycle-fixture',
      symbol: 'NDX',
      providerEventId,
      entryRootId: providerEventId,
      sequence: ++sequence,
      occurredAt: NOW,
      kind: 'ENTRY',
      side: 'LONG',
      quantity: '1',
      leverage: '50',
    });
    return copier.acceptSyntheticLeaderEvent(entry).eventId;
  };
  const change = (
    kind: Exclude<LeaderEvent['kind'], 'ENTRY'>,
    value = '0.25',
  ) => {
    const event = leaderEventSchema.parse({
      ...entry,
      providerEventId: randomUUID(),
      sequence: ++sequence,
      kind,
      quantity: kind === 'ADD' || kind === 'REDUCE' ? value : '1',
      ...(kind === 'STOP_CHANGED' || kind === 'TARGET_CHANGED'
        ? { price: value }
        : {}),
    });
    return copier.acceptSyntheticLeaderEvent(event).eventId;
  };
  return {
    get journal() {
      return journal;
    },
    get adapter() {
      return adapter;
    },
    get copier() {
      return copier;
    },
    arm,
    get entry() {
      return structuredClone(entry);
    },
    newEntry,
    change,
    async restart() {
      const snapshot = adapter.exportSnapshot();
      copier.lock();
      await adapter.disconnect();
      journal.close();
      journal = new Journal(path);
      adapter = new MockVestAdapter(
        config,
        () => NOW,
        undefined,
        '30400',
        () => {},
        () => {},
        snapshot,
      );
      await adapter.connect();
      copier = controller();
    },
    async close() {
      await adapter.disconnect();
      journal.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

describe('offline event lifecycle and durable recovery', () => {
  it.each(['STOP_LOSS', 'TAKE_PROFIT', 'BREACH', 'MANUAL'] as const)(
    '%s actual provider exit cannot reopen the same entry root across replay and restart',
    async (exit) => {
      const f = await fixture();
      try {
        const entryId = f.newEntry();
        await f.copier.copyEntry(entryId, intent);
        const add = f.change('ADD');
        await f.copier.copyChange(add);
        if (exit === 'MANUAL') {
          await f.adapter.closePosition('02');
          await f.adapter.closePosition('03');
        } else {
          const order = (await f.adapter.getOpenOrders('02')).find(
            (o) => o.type === exit,
          );
          await f.adapter.updatePrice(
            exit === 'BREACH' ? '10000' : order!.triggerPrice,
          );
          if (exit !== 'BREACH') {
            expect(
              (await f.adapter.getProtectionOrder('02', order!.orderId))!
                .status,
            ).toBe('FILLED');
            expect((await f.adapter.getAccountState('02')).status).toBe(
              'ACTIVE',
            );
          }
        }
        for (const account of ['02', '03']) {
          expect((await f.adapter.getAccountState(account)).positions).toEqual(
            [],
          );
          expect(await f.adapter.getOpenOrders(account)).toEqual([]);
          if (exit === 'BREACH')
            expect((await f.adapter.getAccountState(account)).status).toBe(
              'BREACHED',
            );
        }
        await f.restart();
        if (exit === 'BREACH') {
          await expect(f.copier.arm(f.arm)).rejects.toThrow(
            'OFFLINE_ARM_REFUSED',
          );
        } else await f.copier.arm(f.arm);
        const entrySend = vi.spyOn(f.adapter, 'placeOrder');
        const addSend = vi.spyOn(f.adapter, 'addOwnedPosition');
        const protectionSend = vi.spyOn(f.adapter, 'changeOwnedProtection');
        await f.copier.copyEntry(entryId, intent);
        await f.copier.copyChange(add);
        for (const id of [
          f.change('ADD'),
          f.change('STOP_CHANGED', '9900'),
          f.change('TARGET_CHANGED', '31000'),
        ]) {
          if (exit === 'BREACH')
            await expect(f.copier.copyChange(id)).rejects.toThrow(
              'OFFLINE_MUTATION_LOCKED',
            );
          else await f.copier.copyChange(id);
        }
        expect(entrySend).not.toHaveBeenCalled();
        expect(addSend).not.toHaveBeenCalled();
        expect(protectionSend).not.toHaveBeenCalled();
        for (const account of ['02', '03'])
          expect((await f.adapter.getAccountState(account)).positions).toEqual(
            [],
          );
      } finally {
        await f.close();
      }
    },
  );

  it('explicit skip is durable and blocks same-root ADD and protection while another follower proceeds', async () => {
    const f = await fixture();
    try {
      f.adapter.injectFault('02', 'REJECT');
      const entryId = f.newEntry();
      await f.copier.copyEntry(entryId, intent);
      await f.copier.repair(entryId, '02', 'SKIP');
      await f.restart();
      await f.copier.arm(f.arm);
      const send = vi.spyOn(f.adapter, 'placeOrder');
      const add = vi.spyOn(f.adapter, 'addOwnedPosition');
      const protection = vi.spyOn(f.adapter, 'changeOwnedProtection');
      await f.copier.copyEntry(entryId, intent);
      await f.copier.copyChange(f.change('ADD'));
      await f.copier.copyChange(f.change('STOP_CHANGED', '30350'));
      expect(f.journal.copier.followerDisposition(entryId, '02')!.reason).toBe(
        'SKIPPED',
      );
      expect(send).not.toHaveBeenCalled();
      expect(add.mock.calls.map((c) => c[0].accountId)).toEqual(['03']);
      expect(protection.mock.calls.map((c) => c[0].accountId)).toEqual(['03']);
      expect((await f.adapter.getAccountState('02')).positions).toEqual([]);
    } finally {
      await f.close();
    }
  });

  it('three distinct leader cycles enter after verified flat, while old events never create new effects', async () => {
    const f = await fixture();
    try {
      const oldEntries: string[] = [],
        oldAdds: string[] = [],
        oldProtections: string[] = [];
      for (let cycle = 0; cycle < 3; cycle++) {
        const entryId = f.newEntry();
        oldEntries.push(entryId);
        await f.copier.copyEntry(entryId, intent);
        const add = f.change('ADD');
        oldAdds.push(add);
        await f.copier.copyChange(add);
        const protection = f.change('STOP_CHANGED', '30350');
        oldProtections.push(protection);
        await f.copier.copyChange(protection);
        for (const root of f.journal.mutations
          .roots()
          .filter((r) => r.entryEventId === entryId)) {
          const repair = await f.copier.repairOwnedRoot({
            actionId: randomUUID(),
            rootId: root.rootId,
            expectedRootRevision: root.revision,
            operation: 'FLATTEN',
          });
          expect(repair.state).toBe('VERIFIED');
        }
        await f.restart();
        await f.copier.arm(f.arm);
        const send = vi.spyOn(f.adapter, 'placeOrder');
        const addSend = vi.spyOn(f.adapter, 'addOwnedPosition');
        const protectionSend = vi.spyOn(f.adapter, 'changeOwnedProtection');
        for (const id of oldEntries) await f.copier.copyEntry(id, intent);
        for (const id of oldAdds) await f.copier.copyChange(id);
        for (const id of oldProtections) await f.copier.copyChange(id);
        expect(protectionSend).not.toHaveBeenCalled();
        expect(send).not.toHaveBeenCalled();
        expect(addSend).not.toHaveBeenCalled();
        expect(
          f.journal.mutations
            .roots()
            .every((r) => r.closed && r.certainty === 'ABSENT'),
        ).toBe(true);
      }
      expect(f.journal.mutations.roots()).toHaveLength(6);
    } finally {
      await f.close();
    }
  });

  it('UNKNOWN persists its root reservation across restart and isolates later commands to healthy followers', async () => {
    const f = await fixture();
    try {
      const entryId = f.newEntry();
      await f.copier.copyEntry(entryId, intent);
      f.adapter.injectOwnedMutationFault('02', 'UNKNOWN_BEFORE');
      const addId = f.change('ADD');
      const results = await f.copier.copyChange(addId);
      const unknown = results.find((r) => r.accountId === '02')!;
      expect(unknown.state).toBe('UNKNOWN');
      if (!('mutationId' in unknown))
        throw new Error('EXPECTED_MUTATION_RECORD');
      expect(results.find((r) => r.accountId === '03')!.state).toBe('VERIFIED');
      const root = f.journal.mutations
        .roots()
        .find((r) => r.accountId === '02')!;
      const reservation = f.journal.mutations.reservation(root.rootId);
      expect(reservation!.commandId).toBe(unknown.mutationId);
      await f.restart();
      expect(f.journal.mutations.reservation(root.rootId)).toEqual(reservation);
      const send = vi.spyOn(f.adapter, 'addOwnedPosition');
      expect((await f.copier.reconcileChange(unknown.mutationId)).state).toBe(
        'UNKNOWN',
      );
      await new Promise((resolve) => setImmediate(resolve));
      await f.copier.arm(f.arm);
      await f.copier.copyChange(addId);
      const next = await f.copier.copyChange(f.change('ADD'));
      expect(next.find((r) => r.accountId === '02')!.state).toBe('NOT_SENT');
      expect(next.find((r) => r.accountId === '03')!.state).toBe('VERIFIED');
      expect(send.mock.calls.map((c) => c[0].accountId)).toEqual(['03']);
      expect(f.journal.mutations.reservation(root.rootId)).toEqual(reservation);
    } finally {
      await f.close();
    }
  });

  it('lost mutation acknowledgement reconciles the durable provider receipt after restart without resend', async () => {
    const f = await fixture();
    try {
      const entryId = f.newEntry();
      await f.copier.copyEntry(entryId, intent);
      f.adapter.injectOwnedMutationFault('02', 'UNKNOWN_AFTER');
      const reduceId = f.change('REDUCE', '0.5');
      const row = (await f.copier.copyChange(reduceId)).find(
        (r) => r.accountId === '02',
      )!;
      expect(row.state).toBe('UNKNOWN');
      if (!('mutationId' in row)) throw new Error('EXPECTED_MUTATION_RECORD');
      const quantity = (await f.adapter.getAccountState('02')).positions[0]!
        .quantity;
      await f.restart();
      const send = vi.spyOn(f.adapter, 'reduceOwnedPosition');
      expect((await f.copier.reconcileChange(row.mutationId)).state).toBe(
        'VERIFIED',
      );
      await new Promise((resolve) => setImmediate(resolve));
      await f.copier.arm(f.arm);
      await f.copier.copyChange(reduceId);
      expect(send).not.toHaveBeenCalled();
      expect(
        (await f.adapter.getAccountState('02')).positions[0]!.quantity,
      ).toBe(quantity);
      const root = f.journal.mutations
        .roots()
        .find((r) => r.accountId === '02')!;
      expect(f.journal.mutations.reservation(root.rootId)).toBeNull();
    } finally {
      await f.close();
    }
  });
  it('a reordered event gap causes zero sends until its genuine predecessor arrives, then replay cannot apply twice', async () => {
    const f = await fixture();
    try {
      const entryId = f.newEntry();
      await f.copier.copyEntry(entryId, intent);
      const gap = leaderEventSchema.parse({
        ...f.entry,
        providerEventId: randomUUID(),
        sequence: 3,
        kind: 'ADD',
        quantity: '0.25',
      });
      const gapId = f.copier.acceptSyntheticLeaderEvent(gap).eventId;
      const send = vi.spyOn(f.adapter, 'addOwnedPosition');
      await expect(f.copier.copyChange(gapId)).rejects.toThrow(
        'MUTATION_SEQUENCE_GAP',
      );
      expect(send).not.toHaveBeenCalled();
      const predecessor = leaderEventSchema.parse({
        ...f.entry,
        providerEventId: randomUUID(),
        sequence: 2,
        kind: 'STOP_CHANGED',
        price: '30350',
      });
      const predecessorId =
        f.copier.acceptSyntheticLeaderEvent(predecessor).eventId;
      await f.copier.copyChange(predecessorId);
      expect(
        (await f.copier.copyChange(gapId)).map((row) => row.state),
      ).toEqual(['VERIFIED', 'VERIFIED']);
      expect(send).toHaveBeenCalledTimes(2);
      const quantities = await Promise.all(
        ['02', '03'].map(
          async (id) =>
            (await f.adapter.getAccountState(id)).positions[0]!.quantity,
        ),
      );
      await f.restart();
      expect(f.copier.acceptSyntheticLeaderEvent(gap).eventId).toBe(gapId);
      expect(f.copier.acceptSyntheticLeaderEvent(predecessor).eventId).toBe(
        predecessorId,
      );
      const restartedSend = vi.spyOn(f.adapter, 'addOwnedPosition');
      await f.copier.copyChange(gapId);
      await f.copier.copyChange(predecessorId);
      expect(restartedSend).not.toHaveBeenCalled();
      expect(
        await Promise.all(
          ['02', '03'].map(
            async (id) =>
              (await f.adapter.getAccountState(id)).positions[0]!.quantity,
          ),
        ),
      ).toEqual(quantities);
    } finally {
      await f.close();
    }
  });
  it('completes 25 nine-follower cycles with lost acknowledgements, durable restarts and zero replay effects', async () => {
    const followers = Array.from({ length: 9 }, (_, i) =>
      String(i + 2).padStart(2, '0'),
    );
    const f = await fixture(followers);
    const sends: { kind: string; requestId: string; accountId: string }[] = [];
    const observeProvider = () => {
      const entry = f.adapter.placeOrder.bind(f.adapter);
      vi.spyOn(f.adapter, 'placeOrder').mockImplementation((request) => {
        sends.push({
          kind: 'ENTRY',
          requestId: request.requestId,
          accountId: request.accountId,
        });
        return entry(request);
      });
      const reduce = f.adapter.reduceOwnedPosition.bind(f.adapter);
      vi.spyOn(f.adapter, 'reduceOwnedPosition').mockImplementation(
        (request) => {
          sends.push({
            kind: 'REDUCE',
            requestId: request.requestId,
            accountId: request.accountId,
          });
          return reduce(request);
        },
      );
      const close = f.adapter.closeOwnedPosition.bind(f.adapter);
      vi.spyOn(f.adapter, 'closeOwnedPosition').mockImplementation(
        (request) => {
          sends.push({
            kind: 'CLOSE',
            requestId: request.requestId,
            accountId: request.accountId,
          });
          return close(request);
        },
      );
    };
    const history: { entry: string; reduce: string; close: string }[] = [];
    observeProvider();
    try {
      for (let cycle = 0; cycle < 25; cycle++) {
        const entryId = f.newEntry();
        if (f.copier.status() === 'LOCKED') {
          const before = sends.length;
          await expect(f.copier.copyEntry(entryId, intent)).rejects.toThrow(
            'OFFLINE_ENTRY_LOCKED',
          );
          expect(sends).toHaveLength(before);
          await f.copier.arm(f.arm);
        }
        const entries = await f.copier.copyEntry(entryId, intent);
        expect(entries).toHaveLength(9);
        expect(
          entries.map((row) => ({
            accountId: row.accountId,
            outcome: row.attempt?.outcome,
            error: row.error,
          })),
          `cycle ${cycle}`,
        ).toEqual(
          followers.map((accountId) =>
            expect.objectContaining({
              accountId,
              outcome: expect.objectContaining({ exposure: 'PRESENT' }),
            }),
          ),
        );
        expect(
          entries.every((row) => row.attempt?.outcome.exposure === 'PRESENT'),
        ).toBe(true);
        const uncertainAccount =
          followers[Math.floor(cycle / 5) % followers.length]!;
        const loseAck = cycle % 5 === 4;
        if (loseAck)
          f.adapter.injectOwnedMutationFault(uncertainAccount, 'UNKNOWN_AFTER');
        const reduceId = f.change('REDUCE', '0.25');
        const reduced = await f.copier.copyChange(reduceId);
        expect(reduced).toHaveLength(9);
        for (const row of reduced) {
          expect(row.state).toBe(
            loseAck && row.accountId === uncertainAccount
              ? 'UNKNOWN'
              : 'VERIFIED',
          );
          if (row.state === 'UNKNOWN') {
            if (!('mutationId' in row))
              throw new Error('EXPECTED_MUTATION_RECORD');
            const before = sends.length;
            expect((await f.copier.reconcileChange(row.mutationId)).state).toBe(
              'VERIFIED',
            );
            expect(sends).toHaveLength(before);
          }
        }
        const closeId = f.change('CLOSE');
        const closed = await f.copier.copyChange(closeId);
        expect(closed.map((row) => row.state)).toEqual(
          Array(9).fill('VERIFIED'),
        );
        history.push({ entry: entryId, reduce: reduceId, close: closeId });
        const roots = f.journal.mutations.roots();
        expect(roots).toHaveLength((cycle + 1) * 9);
        for (const root of roots) {
          expect(root.closed).toBe(true);
          expect(root.certainty).toBe('ABSENT');
          expect(f.journal.mutations.reservation(root.rootId)).toBeNull();
        }
        for (const account of followers) {
          expect((await f.adapter.getAccountState(account)).positions).toEqual(
            [],
          );
          expect(await f.adapter.getOpenOrders(account)).toEqual([]);
        }
        if (cycle % 5 === 4) {
          await f.restart();
          observeProvider();
          expect(f.copier.status()).toBe('LOCKED');
          // Replay each completed checkpoint's events while locked; at the final
          // restart also replay every older cycle to prove long-lived deduplication.
          const beforeReplay = sends.length;
          const replay = cycle === 24 ? history : history.slice(-5);
          for (const previous of replay) {
            await f.copier.copyEntry(previous.entry, intent);
            await f.copier.copyChange(previous.reduce);
            await f.copier.copyChange(previous.close);
          }
          expect(sends).toHaveLength(beforeReplay);
        }
      }
      expect(sends).toHaveLength(25 * 9 * 3);
      expect(new Set(sends.map((row) => row.requestId)).size).toBe(
        sends.length,
      );
      for (const account of followers) {
        for (const kind of ['ENTRY', 'REDUCE', 'CLOSE']) {
          expect(
            sends.filter(
              (row) => row.accountId === account && row.kind === kind,
            ),
          ).toHaveLength(25);
        }
      }
      const provider = f.adapter.exportSnapshot();
      expect(provider.orders).toHaveLength(25 * 9);
      expect(provider.ownedMutations).toHaveLength(25 * 9 * 2);
      expect(
        provider.ownedMutations.every(
          (row) =>
            row.receipt.status === 'VERIFIED' && row.receipt.noFutureExecution,
        ),
      ).toBe(true);
    } finally {
      await f.close();
    }
  }, 60000);
});
