import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { Journal } from '../packages/execution/src/journal.ts';
import { OfflineFanoutController } from '../packages/execution/src/fanout-controller.ts';
import { MockVestAdapter } from '../packages/simulator/src/index.ts';
import {
  leaderEventSchema,
  leaderRootKey,
  type LeaderEvent,
} from '../packages/execution/src/copier-events.ts';
import { ownedRootId } from '../packages/execution/src/copier-mutations.ts';
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
    sourceId: 'owned-events-fixture',
    symbol: 'NDX',
    baselineSequence: 0,
  });
  const arm = {
    environment: 'OFFLINE_FIXTURE' as const,
    evidence: 'SYNTHETIC' as const,
    leaderAccountId: '01',
    followerAccountIds: ['02', '03'],
    symbol: 'NDX' as const,
    maxLeverage: '50',
    maxNotionalPerAccount: '100000',
    maxPlannedLossPerAccount: '10000',
    expiresAt: NOW + 10000,
  };
  await copier.arm(arm);
  const providerEventId = randomUUID();
  const entry = leaderEventSchema.parse({
    environment: 'OFFLINE_FIXTURE',
    evidence: 'SYNTHETIC',
    origin: 'ACCEPTED_EVENT',
    leaderAccountId: '01',
    sourceId: 'owned-events-fixture',
    symbol: 'NDX',
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
  const change = (kind: Exclude<LeaderEvent['kind'], 'ENTRY'>, value = '0.5') =>
    copier.acceptSyntheticLeaderEvent(
      leaderEventSchema.parse({
        ...entry,
        providerEventId: randomUUID(),
        sequence: ++sequence,
        kind,
        quantity: kind === 'ADD' || kind === 'REDUCE' ? value : '1',
        ...(kind === 'STOP_CHANGED' || kind === 'TARGET_CHANGED'
          ? { price: value }
          : {}),
      }),
    ).eventId;
  return { journal, adapter, copier, arm, entryId, change };
}
describe('durable owned leader event execution', () => {
  it('applies ADD, REDUCE and CLOSE in order even when all are accepted before dispatch', async () => {
    const f = await fixture();
    const initial = (await f.adapter.getAccountState('02')).positions[0]!
      .quantity;
    const add = f.change('ADD', '0.5'),
      reduce = f.change('REDUCE', '0.25'),
      close = f.change('CLOSE');
    const a = f.copier.copyChange(add),
      b = f.copier.copyChange(reduce),
      c = f.copier.copyChange(close);
    for (const result of await Promise.all([a, b, c]))
      expect(result.map((row) => row.state)).toEqual(['VERIFIED', 'VERIFIED']);
    expect((await f.adapter.getAccountState('02')).positions).toHaveLength(0);
    const roots = f.journal.mutations.roots();
    expect(
      roots.every((root) => root.closed && root.certainty === 'ABSENT'),
    ).toBe(true);
    expect(
      f.copier.snapshot(f.entryId)[0]!.attempt!.outcome.filledQuantity,
    ).toBe(initial);
    expect(f.copier.snapshot(f.entryId)[0]!.attempt!.terminal!.result).toBe(
      'EXITED',
    );
    const send = vi.spyOn(f.adapter, 'addOwnedPosition');
    await f.copier.copyChange(add);
    expect(send).not.toHaveBeenCalled();
    f.journal.close();
  });
  it('keeps one stop and applies the latest queued protection intent', async () => {
    const f = await fixture();
    const send = vi.spyOn(f.adapter, 'changeOwnedProtection');
    const first = f.change('STOP_CHANGED', '30330'),
      second = f.change('STOP_CHANGED', '30340'),
      third = f.change('STOP_CHANGED', '30350');
    const results = await Promise.all([
      f.copier.copyChange(first),
      f.copier.copyChange(second),
      f.copier.copyChange(third),
    ]);
    expect(results[0]!.every((r) => r.state === 'SUPERSEDED')).toBe(true);
    expect(results[1]!.every((r) => r.state === 'SUPERSEDED')).toBe(true);
    expect(results[2]!.every((r) => r.state === 'VERIFIED')).toBe(true);
    expect(send).toHaveBeenCalledTimes(2);
    const stops = (await f.adapter.getOpenOrders('02')).filter(
      (o) => o.type === 'STOP_LOSS',
    );
    expect(stops).toHaveLength(1);
    expect(stops[0]!.triggerPrice).toBe('30350');
    f.journal.close();
  });
  it('rapid stop changes with no active stop create one stable owned stop', async () => {
    const f = await fixture();
    for (const accountId of ['02', '03']) {
      const stop = (await f.adapter.getOpenOrders(accountId)).find(
        (o) => o.type === 'STOP_LOSS',
      )!;
      await f.adapter.cancelOrder(accountId, stop.orderId);
    }
    const first = f.change('STOP_CHANGED', '30330'),
      last = f.change('STOP_CHANGED', '30350');
    const changes = await Promise.all([
      f.copier.copyChange(first),
      f.copier.copyChange(last),
    ]);
    expect(changes[1]!.every((row) => row.state === 'VERIFIED')).toBe(true);
    const stops = (await f.adapter.getOpenOrders('02')).filter(
      (o) => o.type === 'STOP_LOSS',
    );
    expect(stops).toHaveLength(1);
    expect(stops[0]!.triggerPrice).toBe('30350');
    f.journal.close();
  });
  it('a delayed stop acknowledgement holds only its account lane and preserves the newer intent', async () => {
    const f = await fixture();
    let release!: () => void, started!: () => void;
    const gate = new Promise<void>((r) => {
        release = r;
      }),
      beginning = new Promise<void>((r) => {
        started = r;
      });
    const original = f.adapter.changeOwnedProtection.bind(f.adapter);
    vi.spyOn(f.adapter, 'changeOwnedProtection').mockImplementation(
      async (request) => {
        if (request.accountId === '02' && request.price === '30330') {
          started();
          await gate;
        }
        return original(request);
      },
    );
    const first = f.copier.copyChange(f.change('STOP_CHANGED', '30330'));
    await beginning;
    const next = f.copier.copyChange(f.change('STOP_CHANGED', '30350'));
    await new Promise((resolve) => setImmediate(resolve));
    expect(
      (await f.adapter.getOpenOrders('03')).find((o) => o.type === 'STOP_LOSS')!
        .triggerPrice,
    ).toBe('30350');
    release();
    await first;
    await next;
    expect(
      (await f.adapter.getOpenOrders('02')).filter(
        (o) => o.type === 'STOP_LOSS',
      ),
    ).toHaveLength(1);
    expect(
      (await f.adapter.getOpenOrders('02')).find((o) => o.type === 'STOP_LOSS')!
        .triggerPrice,
    ).toBe('30350');
    f.journal.close();
  });
  it('a follower closed manually is never reopened by ADD or protection changes', async () => {
    const f = await fixture();
    await f.adapter.closePosition('02');
    const add = f.change('ADD');
    const result = await f.copier.copyChange(add);
    expect(result.find((r) => r.accountId === '02')!.state).toBe('NOT_SENT');
    expect(result.find((r) => r.accountId === '03')!.state).toBe('VERIFIED');
    expect((await f.adapter.getAccountState('02')).positions).toHaveLength(0);
    f.journal.close();
  });
  it('UNKNOWN reserves a root while other followers proceed and cannot trigger a second create', async () => {
    const f = await fixture();
    f.adapter.injectOwnedMutationFault('02', 'UNKNOWN_BEFORE');
    const stop = f.change('STOP_CHANGED', '30350');
    const result = await f.copier.copyChange(stop);
    expect(result.find((r) => r.accountId === '02')!.state).toBe('UNKNOWN');
    expect(result.find((r) => r.accountId === '03')!.state).toBe('VERIFIED');
    const send = vi.spyOn(f.adapter, 'changeOwnedProtection');
    const next = f.change('STOP_CHANGED', '30360');
    await f.copier.copyChange(next);
    expect(send.mock.calls.filter((c) => c[0].accountId === '02')).toHaveLength(
      0,
    );
    f.journal.close();
  });
  it('lost acknowledgement reconciles the original receipt without resubmitting', async () => {
    const f = await fixture();
    f.adapter.injectOwnedMutationFault('02', 'UNKNOWN_AFTER');
    const event = f.change('REDUCE', '0.5');
    const results = await f.copier.copyChange(event);
    const row = results.find((r) => r.accountId === '02')!;
    expect(row.state).toBe('UNKNOWN');
    const send = vi.spyOn(f.adapter, 'reduceOwnedPosition');
    f.copier.lock();
    const fixed = await f.copier.reconcileChange(
      'mutationId' in row ? row.mutationId : '',
    );
    expect(fixed.state).toBe('VERIFIED');
    expect(send).not.toHaveBeenCalled();
    f.journal.close();
  });
  it('a partial reduction records remaining exposure and sizes each exit to it', async () => {
    const f = await fixture();
    f.adapter.injectOwnedMutationFault('02', 'PARTIAL_REDUCE');
    const results = await f.copier.copyChange(f.change('REDUCE', '0.5'));
    expect(results.find((r) => r.accountId === '02')!.state).toBe('PARTIAL');
    const root = f.journal.mutations.roots().find((r) => r.accountId === '02')!;
    expect(
      (await f.adapter.getOpenOrders('02')).every(
        (o) => o.quantity === root.quantity,
      ),
    ).toBe(true);
    expect(
      f.copier.snapshot(f.entryId)[0]!.attempt!.outcome.filledQuantity,
    ).not.toBe(root.quantity);
    f.journal.close();
  });
  it('an unresolved change blocks legacy repair while healthy followers proceed', async () => {
    const f = await fixture();
    f.adapter.injectOwnedMutationFault('02', 'UNKNOWN_BEFORE');
    const changes = await f.copier.copyChange(f.change('ADD', '0.5'));
    expect(changes.find((r) => r.accountId === '02')!.state).toBe('UNKNOWN');
    const flatten = vi.spyOn(f.adapter, 'flattenOwnedPosition');
    const attempt = f.copier.snapshot(f.entryId)[0]!.attempt!;
    await expect(
      f.copier.repair(f.entryId, '02', 'FLATTEN', attempt.attemptId),
    ).rejects.toThrow('MUTATION_REPAIR_REQUIRES_CURRENT_SCOPE');
    expect(flatten).not.toHaveBeenCalled();
    expect(changes.find((r) => r.accountId === '03')!.state).toBe('VERIFIED');
    f.journal.close();
  });
  it('locks queued changes after an operator revocation without holding back an already valid follower', async () => {
    const f = await fixture();
    let release!: () => void, started!: () => void;
    const gate = new Promise<void>((r) => {
        release = r;
      }),
      beginning = new Promise<void>((r) => {
        started = r;
      });
    const original = f.adapter.addOwnedPosition.bind(f.adapter);
    vi.spyOn(f.adapter, 'addOwnedPosition').mockImplementation(
      async (request) => {
        if (request.accountId === '02') {
          started();
          await gate;
        }
        return original(request);
      },
    );
    const first = f.copier.copyChange(f.change('ADD', '0.25'));
    await beginning;
    const reduce = vi.spyOn(f.adapter, 'reduceOwnedPosition');
    const queued = f.copier.copyChange(f.change('REDUCE', '0.25'));
    f.copier.lock();
    release();
    await first;
    const result = await queued;
    expect(result.every((row) => row.state === 'NOT_SENT')).toBe(true);
    expect(reduce).not.toHaveBeenCalled();
    f.journal.close();
  });
  it.each(['leverage', 'inactive', 'partial_exit', 'not_reduce_only'] as const)(
    'never verifies tampered post-effect evidence: %s',
    async (fault) => {
      const f = await fixture();
      let effected = false;
      const reduce = f.adapter.reduceOwnedPosition.bind(f.adapter);
      vi.spyOn(f.adapter, 'reduceOwnedPosition').mockImplementation(
        async (request) => {
          const result = await reduce(request);
          if (request.accountId === '02') effected = true;
          return result;
        },
      );
      const list = f.adapter.listAccounts.bind(f.adapter);
      vi.spyOn(f.adapter, 'listAccounts').mockImplementation(async () => {
        const accounts = await list();
        if (effected && fault === 'leverage') {
          const account = accounts.find((a) => a.accountId === '02')!;
          account.positions[0]!.leverage = '49';
        }
        return accounts;
      });
      const orders = f.adapter.getOpenOrders.bind(f.adapter);
      vi.spyOn(f.adapter, 'getOpenOrders').mockImplementation(
        async (accountId) => {
          const result = await orders(accountId);
          if (effected && accountId === '02' && fault !== 'leverage') {
            const stop = result.find((o) => o.type === 'STOP_LOSS')!;
            if (fault === 'inactive') stop.status = 'CANCELED';
            if (fault === 'partial_exit') stop.filledSize = '0.000001';
            if (fault === 'not_reduce_only')
              Object.assign(stop, { reduceOnly: false });
          }
          return result;
        },
      );
      const results = await f.copier.copyChange(f.change('REDUCE', '0.5'));
      expect(results.find((row) => row.accountId === '02')!.state).toBe(
        'UNKNOWN',
      );
      expect(
        f.journal.mutations.roots().find((r) => r.accountId === '02')!
          .certainty,
      ).toBe('UNKNOWN');
      f.journal.close();
    },
  );
  it('atomic revision refusal stays follower-local while other followers complete', async () => {
    const f = await fixture();
    const original = f.adapter.reduceOwnedPosition.bind(f.adapter);
    vi.spyOn(f.adapter, 'reduceOwnedPosition').mockImplementation(
      async (request) => {
        if (request.accountId === '02') {
          const stop = (await f.adapter.getOpenOrders('02')).find(
            (o) => o.type === 'STOP_LOSS',
          )!;
          await f.adapter.cancelOrder('02', stop.orderId);
        }
        return original(request);
      },
    );
    const rows = await f.copier.copyChange(f.change('REDUCE', '0.5'));
    expect(rows.find((r) => r.accountId === '02')!.state).toBe('REJECTED');
    expect(rows.find((r) => r.accountId === '03')!.state).toBe('VERIFIED');
    expect(f.copier.status()).toBe('ARMED');
    f.journal.close();
  });
  it.each([0, 1])(
    'old activated events never catch up missing followers after %s durable child claims',
    async (count) => {
      const f = await fixture();
      const eventId = f.change('ADD', '0.5'),
        event = f.journal.copier.leaderEvent(eventId)!,
        rootKey = leaderRootKey(event),
        generation = randomUUID();
      f.journal.mutations.activate({
        eventId,
        rootKey,
        followerAccountIds: ['02', '03'],
        ownerGeneration: generation,
        activatedAt: NOW,
      });
      if (count)
        f.journal.mutations.claim(
          {
            eventId,
            rootKey,
            rootId: ownedRootId(rootKey, '02'),
            accountId: '02',
            operation: 'ADD',
            sequence: 2,
            deltaQuantity: '0.5',
            price: null,
            ownerGeneration: generation,
            createdAt: NOW,
          },
          NOW,
          generation,
        );
      f.copier.lock();
      await new Promise((resolve) => setImmediate(resolve));
      await f.copier.arm(f.arm);
      const send = vi.spyOn(f.adapter, 'addOwnedPosition');
      const rows = await f.copier.copyChange(eventId);
      expect(rows).toHaveLength(2);
      expect(rows.filter((row) => row.state === 'NOT_ATTEMPTED')).toHaveLength(
        2 - count,
      );
      expect(send).not.toHaveBeenCalled();
      expect(f.journal.mutations.records()).toHaveLength(count);
      f.journal.close();
    },
  );
  it.each(['side', 'leverage'] as const)(
    'refuses conflicting accepted leader %s before any command claim',
    async (field) => {
      const f = await fixture();
      const base = f.journal.copier.leaderEvent(f.entryId)!;
      const event = f.copier.acceptSyntheticLeaderEvent(
        leaderEventSchema.parse({
          ...base,
          providerEventId: randomUUID(),
          kind: 'REDUCE',
          sequence: 2,
          quantity: '0.5',
          ...(field === 'side' ? { side: 'SHORT' } : { leverage: '49' }),
        }),
      ).eventId;
      const send = vi.spyOn(f.adapter, 'reduceOwnedPosition');
      await expect(f.copier.copyChange(event)).rejects.toThrow();
      expect(send).not.toHaveBeenCalled();
      expect(f.journal.mutations.records()).toEqual([]);
      expect(f.copier.status()).toBe('HALTED');
      f.journal.close();
    },
  );
  it('retains execution root history after the recent-event dashboard limit', async () => {
    const f = await fixture();
    let last = '';
    for (let i = 0; i < 105; i++) last = f.change('STOP_CHANGED', '30350');
    expect(
      f.journal.copier.leaderEvents().some((row) => row.eventId === f.entryId),
    ).toBe(false);
    const rows = await f.copier.copyChange(last);
    expect(rows.every((row) => row.state === 'VERIFIED')).toBe(true);
    f.journal.close();
  });
  it('restart is locked and replays mutations with zero additional effects', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'owned-event-restart-')),
      path = join(dir, 'journal.sqlite');
    const f = await fixture(path);
    const event = f.change('REDUCE', '0.5');
    await f.copier.copyChange(event);
    const saved = f.adapter.exportSnapshot();
    f.journal.close();
    const journal = new Journal(path),
      adapter = new MockVestAdapter(
        config,
        () => NOW,
        undefined,
        '30400',
        undefined,
        undefined,
        saved,
      );
    await adapter.connect();
    const copier = new OfflineFanoutController(
      adapter,
      config,
      journal,
      () => NOW,
    );
    const send = vi.spyOn(adapter, 'reduceOwnedPosition');
    expect(copier.status()).toBe('LOCKED');
    await copier.copyChange(event);
    expect(send).not.toHaveBeenCalled();
    journal.close();
    rmSync(dir, { recursive: true, force: true });
  });
});
