import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  OfflineFanoutController,
  CopierSystemError,
  type OfflineFanoutArm,
} from '../packages/execution/src/fanout-controller.ts';
import { leaderEventSchema } from '../packages/execution/src/copier-events.ts';
import { OfflineBridgeExecutionAdapter } from '../packages/browser-execution/src/bridge/adapter.ts';
import { offlineBridge } from './fixtures/offline-bridge.ts';
import { authenticatedOfflineBridge } from '../packages/browser-execution/src/bridge/authenticated-channel.ts';
import { Journal } from '../packages/execution/src/journal.ts';
import { MockVestAdapter } from '../packages/simulator/src/index.ts';
import { config, intent, NOW } from './helpers.ts';
function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function fixture(followers = ['02', '03', '04', '05', '06']) {
  let now = NOW;
  const clock = () => now,
    journal = new Journal(),
    adapter = new MockVestAdapter(config, clock, undefined, '30400');
  await adapter.connect();
  const stream = {
    environment: 'OFFLINE_FIXTURE' as const,
    evidence: 'SYNTHETIC' as const,
    leaderAccountId: '01',
    sourceId: 'synthetic-leader',
    symbol: 'NDX' as const,
    baselineSequence: 0,
  };
  journal.copier.registerLeaderStream(stream);
  // Strict event schema has no baseline field.
  const event = (sequence = 1, side: 'LONG' | 'SHORT' = 'LONG') => {
    const scope = {
      environment: stream.environment,
      evidence: stream.evidence,
      leaderAccountId: stream.leaderAccountId,
      sourceId: stream.sourceId,
      symbol: stream.symbol,
    };
    return journal.copier.recordLeaderEvent(
      leaderEventSchema.parse({
        ...scope,
        origin: 'ACCEPTED_EVENT',
        providerEventId: `entry-${sequence}`,
        entryRootId: `entry-${sequence}`,
        sequence,
        occurredAt: now,
        kind: 'ENTRY',
        side,
        quantity: '1',
        leverage: intent.leverage,
      }),
      { generation: randomUUID(), detectedAt: now },
    );
  };
  const copier = new OfflineFanoutController(
    adapter,
    config,
    journal,
    clock,
    40,
  );
  const arm: OfflineFanoutArm = {
    environment: 'OFFLINE_FIXTURE',
    evidence: 'SYNTHETIC',
    leaderAccountId: '01',
    followerAccountIds: followers,
    symbol: 'NDX',
    maxLeverage: '50',
    maxNotionalPerAccount: '100000',
    maxPlannedLossPerAccount: '10',
    expiresAt: NOW + 10000,
  };
  await copier.arm(arm);
  return {
    journal,
    adapter,
    copier,
    clock,
    event,
    arm,
    advance: (ms: number) => {
      now += ms;
    },
  };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function withFixture(
  run: (f: Fixture) => Promise<void>,
  followers?: string[],
) {
  const f = await fixture(followers);
  try {
    await run(f);
  } finally {
    await f.adapter.disconnect();
    f.journal.close();
  }
}

describe('offline independent follower scheduling', () => {
  it('starts locked and rejects live or serialized adapters', async () =>
    withFixture(async (f) => {
      const restarted = new OfflineFanoutController(
        f.adapter,
        config,
        f.journal,
        f.clock,
      );
      expect(restarted.status()).toBe('LOCKED');
      await expect(
        restarted.copyEntry(f.event().eventId, intent),
      ).rejects.toThrow('OFFLINE_ENTRY_LOCKED');
      expect(
        () =>
          new OfflineFanoutController(
            { ...f.adapter, environment: 'LIVE' } as unknown as MockVestAdapter,
            config,
            f.journal,
          ),
      ).toThrow('OFFLINE_FANOUT_ADAPTER_REFUSED');
      expect(
        () =>
          new OfflineFanoutController(
            {
              ...f.adapter,
              scheduling: 'SERIAL',
            } as unknown as MockVestAdapter,
            config,
            f.journal,
          ),
      ).toThrow('OFFLINE_FANOUT_ADAPTER_REFUSED');
    }));
  it('protects later followers while Account04 is still blocked', async () =>
    withFixture(async (f) => {
      const gate = deferred(),
        started = deferred(),
        later = deferred();
      const original = f.adapter.placeOrder.bind(f.adapter);
      vi.spyOn(f.adapter, 'placeOrder').mockImplementation(async (req) => {
        if (req.accountId === '04') {
          started.resolve();
          await gate.promise;
        }
        return original(req);
      });
      f.copier.subscribe((u) => {
        if (u.accountId === '06' && u.attempt?.outcome.target === 'VERIFIED')
          later.resolve();
      });
      const id = f.event().eventId,
        run = f.copier.copyEntry(id, intent);
      await started.promise;
      await later.promise;
      expect(
        (await f.adapter.getAccountState('06')).positions[0]?.protectionStatus,
      ).toBe('ACTIVE');
      expect(
        f.copier.snapshot(id).find((u) => u.accountId === '04')?.attempt
          ?.outcome.submission,
      ).toBe('SUBMITTING');
      gate.resolve();
      const results = await run;
      expect(
        results.every(
          (r) =>
            r.attempt?.outcome.stop === 'VERIFIED' &&
            r.attempt.outcome.target === 'VERIFIED',
        ),
      ).toBe(true);
    }));
  it('isolates a confirmed rejection and keeps following accounts protected', async () =>
    withFixture(async (f) => {
      const original = f.adapter.placeOrder.bind(f.adapter);
      const rejected = new Set<string>();
      vi.spyOn(f.adapter, 'placeOrder').mockImplementation(async (req) => {
        if (req.accountId === '04') {
          rejected.add(req.requestId);
          return {
            requestId: req.requestId,
            accountId: req.accountId,
            status: 'REJECTED',
            filledSize: '0',
            entryPrice: null,
            fees: '0',
            error: 'REJECTED',
          };
        }
        return original(req);
      });
      const get = f.adapter.getOrder.bind(f.adapter);
      vi.spyOn(f.adapter, 'getOrder').mockImplementation(async (id) =>
        rejected.has(id)
          ? {
              requestId: id,
              accountId: '04',
              status: 'REJECTED',
              filledSize: '0',
              entryPrice: null,
              fees: '0',
              error: 'REJECTED',
            }
          : get(id),
      );
      const results = await f.copier.copyEntry(f.event().eventId, intent);
      expect(
        results.find((r) => r.accountId === '04')?.attempt?.outcome.submission,
      ).toBe('REJECTED');
      expect(
        results.find((r) => r.accountId === '06')?.attempt?.outcome.target,
      ).toBe('VERIFIED');
      expect(f.copier.status()).toBe('ARMED');
      expect(f.journal.halted()).toBe(false);
    }));
  it('isolates missing stop protection and leaves exposure visible for repair', async () =>
    withFixture(async (f) => {
      const original = f.adapter.placeProtectionOrder.bind(f.adapter);
      vi.spyOn(f.adapter, 'placeProtectionOrder').mockImplementation(
        async (req) => {
          if (req.accountId === '04' && req.type === 'STOP_LOSS')
            throw new Error('untrusted diagnostic');
          return original(req);
        },
      );
      const flatten = vi.spyOn(f.adapter, 'flattenAccount');
      const results = await f.copier.copyEntry(f.event().eventId, intent),
        bad = results.find((r) => r.accountId === '04');
      expect(bad?.attempt?.outcome).toMatchObject({
        submission: 'ACCEPTED',
        stop: 'FAILED',
        exposure: 'PRESENT',
      });
      expect(
        results.find((r) => r.accountId === '06')?.attempt?.outcome.target,
      ).toBe('VERIFIED');
      expect(flatten).not.toHaveBeenCalled();
      expect(f.copier.status()).toBe('ARMED');
    }));
  it('replays a duplicate event without dispatching again, including after restart', async () =>
    withFixture(async (f) => {
      const place = vi.spyOn(f.adapter, 'placeOrder'),
        id = f.event().eventId;
      const first = await f.copier.copyEntry(id, intent);
      await f.copier.copyEntry(id, intent);
      expect(place).toHaveBeenCalledTimes(5);
      const restarted = new OfflineFanoutController(
        f.adapter,
        config,
        f.journal,
        f.clock,
      );
      const replay = await restarted.copyEntry(id, intent);
      expect(replay.map((r) => r.attempt)).toEqual(first.map((r) => r.attempt));
      expect(place).toHaveBeenCalledTimes(5);
      expect(restarted.status()).toBe('LOCKED');
    }));
  it('isolates UNKNOWN and never blindly retries it', async () =>
    withFixture(async (f) => {
      const original = f.adapter.placeOrder.bind(f.adapter);
      vi.spyOn(f.adapter, 'placeOrder').mockImplementation(async (req) => {
        if (req.accountId === '04')
          return {
            requestId: req.requestId,
            accountId: req.accountId,
            status: 'UNKNOWN',
            filledSize: '0',
            entryPrice: null,
            fees: '0',
            error: null,
          };
        return original(req);
      });
      const id = f.event().eventId,
        results = await f.copier.copyEntry(id, intent),
        unknown = results.find((r) => r.accountId === '04')!;
      expect(unknown.attempt?.outcome.submission).toBe('UNKNOWN');
      expect(unknown.attempt?.outcome.exposure).toBe('UNKNOWN');
      expect(
        results.find((r) => r.accountId === '06')?.attempt?.outcome.target,
      ).toBe('VERIFIED');
      expect(() =>
        f.journal.copier.claimExplicitRetry(
          unknown.command!.commandId,
          unknown.attempt!.attemptId,
          randomUUID(),
          NOW,
        ),
      ).toThrow('EXPLICIT_RETRY_UNPROVEN');
      await f.copier.copyEntry(id, intent);
      expect(f.adapter.placeOrder).toHaveBeenCalledTimes(5);
      expect(f.copier.status()).toBe('ARMED');
    }));
  it('revocation before dispatch produces no provider entry', async () =>
    withFixture(async (f) => {
      const place = vi.spyOn(f.adapter, 'placeOrder');
      f.copier.subscribe((u) => {
        if (u.attempt?.outcome.submission === 'NOT_SENT') f.copier.lock();
      });
      await f.copier.copyEntry(f.event().eventId, intent);
      expect(place).not.toHaveBeenCalled();
      expect(f.copier.status()).toBe('LOCKED');
    }));
  it('continues protecting an owned fill after entry revocation', async () =>
    withFixture(async (f) => {
      f.copier.subscribe((u) => {
        if (u.attempt?.outcome.fill === 'FILLED') f.copier.lock();
      });
      const results = await f.copier.copyEntry(f.event().eventId, intent);
      expect(
        results
          .filter((r) => r.attempt?.outcome.fill === 'FILLED')
          .every(
            (r) =>
              r.attempt!.outcome.stop === 'VERIFIED' &&
              r.attempt!.outcome.target === 'VERIFIED',
          ),
      ).toBe(true);
      expect(f.copier.status()).toBe('LOCKED');
    }));
  it('does not let subscriber exceptions affect execution', async () =>
    withFixture(async (f) => {
      f.copier.subscribe(() => {
        throw new Error('observer failed');
      });
      const results = await f.copier.copyEntry(f.event().eventId, intent);
      expect(
        results.every((r) => r.attempt?.outcome.target === 'VERIFIED'),
      ).toBe(true);
    }));
  it('holds UNKNOWN exposure and its lane after timeout and late fill', async () =>
    withFixture(async (f) => {
      const gate = deferred(),
        started = deferred();
      const original = f.adapter.placeOrder.bind(f.adapter);
      vi.spyOn(f.adapter, 'placeOrder').mockImplementation(async (req) => {
        if (req.accountId === '04') {
          started.resolve();
          await gate.promise;
        }
        return original(req);
      });
      const id = f.event().eventId,
        run = f.copier.copyEntry(id, intent);
      await started.promise;
      const results = await run,
        bad = results.find((r) => r.accountId === '04')!;
      expect(bad.attempt?.outcome.submission).toBe('UNKNOWN');
      f.copier.lock();
      await expect(f.copier.arm(f.arm)).rejects.toThrow('OFFLINE_ARM_REFUSED');
      gate.resolve();
      await new Promise((done) => setTimeout(done, 0));
      expect((await f.adapter.getAccountState('04')).positions).toHaveLength(1);
      expect(
        f.journal.copier.followerAttempt(bad.attempt!.attemptId)?.outcome
          .submission,
      ).toBe('UNKNOWN');
      expect(f.journal.copier.accountBlockers('04')).toHaveLength(1);
      expect(f.adapter.placeOrder).toHaveBeenCalledTimes(5);
    }));
  it('globally stops wrong-account evidence before pending follower entries', async () =>
    withFixture(async (f) => {
      const original = f.adapter.getAccountState.bind(f.adapter);
      vi.spyOn(f.adapter, 'getAccountState').mockImplementation(async (id) => {
        if (id === '02') return { ...(await original(id)), accountId: 'WRONG' };
        return original(id);
      });
      const place = vi.spyOn(f.adapter, 'placeOrder');
      await f.copier.copyEntry(f.event().eventId, intent);
      expect(place).not.toHaveBeenCalled();
      expect(f.copier.status()).toBe('HALTED');
      expect(f.journal.copier.globalStop()).toBe('ACCOUNT_MAPPING_CORRUPT');
    }));
  it('propagates a typed channel integrity failure globally', async () =>
    withFixture(async (f) => {
      vi.spyOn(f.adapter, 'placeOrder').mockRejectedValue(
        new CopierSystemError('CHANNEL_INTEGRITY_LOST'),
      );
      await f.copier.copyEntry(f.event().eventId, intent);
      expect(f.copier.status()).toBe('HALTED');
      expect(f.journal.copier.globalStop()).toBe('CHANNEL_INTEGRITY_LOST');
    }));
  it('has zero entry side effects when the durable dispatch mark fails', async () =>
    withFixture(async (f) => {
      vi.spyOn(f.journal.copier, 'markDispatchStarted').mockImplementation(
        () => {
          throw new Error('storage failure');
        },
      );
      const place = vi.spyOn(f.adapter, 'placeOrder');
      await f.copier.copyEntry(f.event().eventId, intent);
      expect(place).not.toHaveBeenCalled();
      expect(f.copier.status()).toBe('HALTED');
    }));
});

describe('account lane boundaries', () => {
  it('does not overlap a new account command while its previous operation is pending', async () =>
    withFixture(async (f) => {
      const gate = deferred(),
        original = f.adapter.placeOrder.bind(f.adapter);
      const calls: string[] = [];
      vi.spyOn(f.adapter, 'placeOrder').mockImplementation(async (req) => {
        calls.push(req.accountId);
        if (req.accountId === '04') await gate.promise;
        return original(req);
      });
      const first = f.copier.copyEntry(f.event().eventId, intent);
      await new Promise((done) => setTimeout(done, 0));
      const next = f.event(2).eventId;
      const second = await f.copier.copyEntry(next, intent);
      expect(second.find((r) => r.accountId === '04')?.error).toBe(
        'FOLLOWER_REQUIRES_RECONCILIATION',
      );
      expect(calls.filter((id) => id === '04')).toHaveLength(1);
      gate.resolve();
      await first;
    }));
  it('keeps an account read outage local', async () =>
    withFixture(async (f) => {
      const get = f.adapter.getOpenOrders.bind(f.adapter);
      vi.spyOn(f.adapter, 'getOpenOrders').mockImplementation(async (id) => {
        if (id === '04') throw new Error('untrusted account read detail');
        return get(id);
      });
      const results = await f.copier.copyEntry(f.event().eventId, intent);
      expect(results.find((r) => r.accountId === '04')?.error).toBe(
        'FOLLOWER_UNAVAILABLE',
      );
      expect(
        results.find((r) => r.accountId === '06')?.attempt?.outcome.target,
      ).toBe('VERIFIED');
      expect(f.copier.status()).toBe('ARMED');
    }));
});

describe('durable replay-only fanout activation', () => {
  it('admits concurrent duplicate calls exactly once', async () =>
    withFixture(async (f) => {
      const place = vi.spyOn(f.adapter, 'placeOrder'),
        id = f.event().eventId;
      await Promise.all([
        f.copier.copyEntry(id, intent),
        f.copier.copyEntry(id, intent),
      ]);
      expect(place).toHaveBeenCalledTimes(5);
      expect(f.copier.snapshot(id)).toHaveLength(5);
    }));
  it.each([false, true])(
    'does not catch up missing members after a %s partial activation',
    async (partial) =>
      withFixture(async (f) => {
        const id = f.event().eventId,
          owner = randomUUID();
        f.journal.copier.claimFanoutBatch(
          { eventId: id, followerAccountIds: f.arm.followerAccountIds, intent },
          owner,
          NOW,
        );
        if (partial)
          f.journal.copier.claimFollowerAttempt(
            {
              eventId: id,
              followerAccountId: '02',
              quantity: '0.000001',
              leverage: intent.leverage,
            },
            owner,
            NOW,
          );
        const restarted = new OfflineFanoutController(
          f.adapter,
          config,
          f.journal,
          f.clock,
        );
        const place = vi.spyOn(f.adapter, 'placeOrder');
        const locked = await restarted.copyEntry(id, intent);
        expect(locked).toHaveLength(5);
        expect(locked.filter((r) => r.error === 'NOT_ATTEMPTED')).toHaveLength(
          partial ? 4 : 5,
        );
        await restarted.arm(f.arm);
        const replay = await restarted.copyEntry(id, intent);
        expect(replay).toHaveLength(5);
        expect(place).not.toHaveBeenCalled();
        expect(f.journal.copier.eventFollowers(id)).toHaveLength(
          partial ? 1 : 0,
        );
      }),
  );
  it('refuses changed stop/target intent on replay', async () =>
    withFixture(async (f) => {
      const place = vi.spyOn(f.adapter, 'placeOrder'),
        id = f.event().eventId;
      await f.copier.copyEntry(id, intent);
      await expect(
        f.copier.copyEntry(id, { ...intent, takeProfitPoints: '160' }),
      ).rejects.toThrow('COPIER_IDENTITY_CONFLICT');
      expect(place).toHaveBeenCalledTimes(5);
      expect(f.copier.status()).toBe('HALTED');
    }));
  it('refuses expanded follower membership on replay', async () =>
    withFixture(async (f) => {
      const id = f.event().eventId;
      await f.copier.copyEntry(id, intent);
      await new Promise((done) => setTimeout(done, 0));
      f.copier.lock();
      await f.copier.arm({
        ...f.arm,
        followerAccountIds: [...f.arm.followerAccountIds, '07'],
      });
      const place = vi.spyOn(f.adapter, 'placeOrder');
      await expect(f.copier.copyEntry(id, intent)).rejects.toThrow(
        'COPIER_IDENTITY_CONFLICT',
      );
      expect(place).not.toHaveBeenCalled();
      expect(f.journal.copier.eventFollowers(id)).toHaveLength(5);
    }));
  it('binds new child claims to activation membership and original owner', async () =>
    withFixture(async (f) => {
      const id = f.event().eventId,
        owner = randomUUID();
      f.journal.copier.claimFanoutBatch(
        { eventId: id, followerAccountIds: ['02'], intent },
        owner,
        NOW,
      );
      expect(() =>
        f.journal.copier.claimFollowerAttempt(
          {
            eventId: id,
            followerAccountId: '03',
            quantity: '1',
            leverage: intent.leverage,
          },
          owner,
          NOW,
        ),
      ).toThrow('COPIER_IDENTITY_CONFLICT');
      expect(f.journal.copier.eventFollowers(id)).toHaveLength(0);
    }));
});

describe('concurrent synthetic bridge integration', () => {
  it('lets another account execute while a bridge entry is blocked', async () =>
    withFixture(async (f) => {
      const fixture = offlineBridge(f.adapter, f.clock),
        channel = authenticatedOfflineBridge(
          fixture.port,
          {
            ownerGeneration: randomUUID(),
            controllerGeneration: randomUUID(),
            browserGeneration: randomUUID(),
          },
          {},
          f.clock,
        ),
        bridge = new OfflineBridgeExecutionAdapter(
          channel.port,
          f.journal,
          { timeoutMs: 1000 },
          f.clock,
        );
      await bridge.connect();
      const copier = new OfflineFanoutController(
        bridge,
        config,
        f.journal,
        f.clock,
        1000,
      );
      await copier.arm(f.arm);
      const gate = deferred(),
        later = deferred(),
        original = f.adapter.placeOrder.bind(f.adapter);
      vi.spyOn(f.adapter, 'placeOrder').mockImplementation(async (req) => {
        if (req.accountId === '04') await gate.promise;
        return original(req);
      });
      copier.subscribe((u) => {
        if (u.accountId === '06' && u.attempt?.outcome.target === 'VERIFIED')
          later.resolve();
      });
      const run = copier.copyEntry(f.event().eventId, intent);
      await later.promise;
      expect(
        (await f.adapter.getAccountState('06')).positions[0]?.protectionStatus,
      ).toBe('ACTIVE');
      gate.resolve();
      const results = await run;
      expect(
        results.every((r) => r.attempt?.outcome.target === 'VERIFIED'),
      ).toBe(true);
      await bridge.disconnect();
    }));
  it('refuses a transport that only supports a shared lane', async () =>
    withFixture(async (f) => {
      const fixture = offlineBridge(f.adapter, f.clock),
        port = { ...fixture.port, concurrency: undefined };
      const bridge = new OfflineBridgeExecutionAdapter(
        port as unknown as typeof fixture.port,
        f.journal,
        {},
        f.clock,
      );
      expect(bridge.scheduling).toBe('SERIAL');
      expect(
        () => new OfflineFanoutController(bridge, config, f.journal),
      ).toThrow('OFFLINE_FANOUT_ADAPTER_REFUSED');
    }));
});

describe('partial fills and final safety boundaries', () => {
  it('protects a conclusively terminal partial fill independently', async () =>
    withFixture(async (f) => {
      f.adapter.injectFault('04', 'PARTIAL_FILL');
      const results = await f.copier.copyEntry(f.event().eventId, intent),
        partial = results.find((r) => r.accountId === '04')!;
      expect(partial.attempt?.outcome).toMatchObject({
        submission: 'ACCEPTED',
        fill: 'PARTIAL',
        stop: 'VERIFIED',
        target: 'VERIFIED',
        exposure: 'PRESENT',
      });
      expect(partial.attempt?.terminal?.result).toBe('FILLED');
      expect(
        results.find((r) => r.accountId === '06')?.attempt?.outcome.target,
      ).toBe('VERIFIED');
    }));
  it('reports a correlated partial fill with unknown remainder without retrying', async () =>
    withFixture(async (f) => {
      f.adapter.injectFault('04', 'PARTIAL_FILL_PENDING');
      const results = await f.copier.copyEntry(f.event().eventId, intent),
        partial = results.find((r) => r.accountId === '04')!;
      expect(partial.attempt?.outcome).toMatchObject({
        submission: 'UNKNOWN',
        fill: 'PARTIAL',
        exposure: 'PRESENT',
      });
      expect(partial.attempt?.outcome.fillPrice).not.toBeNull();
      expect(partial.attempt?.terminal).toBeNull();
      expect(
        results.find((r) => r.accountId === '06')?.attempt?.outcome.target,
      ).toBe('VERIFIED');
      expect(f.copier.status()).toBe('ARMED');
    }));
  it('keeps a failed target separate from the verified stop', async () =>
    withFixture(async (f) => {
      const original = f.adapter.placeProtectionOrder.bind(f.adapter);
      vi.spyOn(f.adapter, 'placeProtectionOrder').mockImplementation(
        async (r) => {
          if (r.accountId === '04' && r.type === 'TAKE_PROFIT')
            throw new Error('target rejected');
          return original(r);
        },
      );
      const results = await f.copier.copyEntry(f.event().eventId, intent);
      expect(
        results.find((r) => r.accountId === '04')?.attempt?.outcome,
      ).toMatchObject({
        stop: 'VERIFIED',
        target: 'FAILED',
        exposure: 'PRESENT',
      });
      expect(
        results.find((r) => r.accountId === '06')?.attempt?.outcome.target,
      ).toBe('VERIFIED');
    }));
  it('stops globally before entry if lifecycle journaling fails', async () =>
    withFixture(async (f) => {
      const write = f.journal.child.bind(f.journal);
      vi.spyOn(f.journal, 'child').mockImplementation((id, r) => {
        if (r.state === 'ENTRY_SUBMITTING')
          throw new Error('private storage detail');
        return write(id, r);
      });
      const place = vi.spyOn(f.adapter, 'placeOrder');
      await f.copier.copyEntry(f.event().eventId, intent);
      expect(place).not.toHaveBeenCalled();
      expect(f.copier.status()).toBe('HALTED');
      expect(f.journal.copier.globalStop()).toBe('JOURNAL_INTEGRITY_LOST');
    }));
  it('expires before actual dispatch without revoking owned-fill protection', async () =>
    withFixture(async (f) => {
      f.copier.subscribe((u) => {
        if (u.attempt?.outcome.submission === 'NOT_SENT') f.advance(10001);
      });
      const place = vi.spyOn(f.adapter, 'placeOrder');
      await f.copier.copyEntry(f.event().eventId, intent);
      expect(place).not.toHaveBeenCalled();
      expect(f.copier.status()).toBe('LOCKED');
    }));
  it('preserves durable skips across a fresh controller and re-arming', async () =>
    withFixture(async (f) => {
      f.copier.lock();
      await f.copier.arm({ ...f.arm, maxNotionalPerAccount: '1' });
      const id = f.event().eventId;
      await f.copier.copyEntry(id, intent);
      const next = new OfflineFanoutController(
        f.adapter,
        config,
        f.journal,
        f.clock,
      );
      const place = vi.spyOn(f.adapter, 'placeOrder');
      expect(
        (await next.copyEntry(id, intent)).every(
          (r) => r.error === 'FOLLOWER_SKIPPED',
        ),
      ).toBe(true);
      await next.arm(f.arm);
      await next.copyEntry(id, intent);
      expect(place).not.toHaveBeenCalled();
    }));
  it('keeps status polling from revoking an in-progress arm', async () =>
    withFixture(async (f) => {
      const next = new OfflineFanoutController(
          f.adapter,
          config,
          f.journal,
          f.clock,
        ),
        gate = deferred(),
        get = f.adapter.listAccounts.bind(f.adapter);
      vi.spyOn(f.adapter, 'listAccounts').mockImplementation(async () => {
        await gate.promise;
        return get();
      });
      const run = next.arm(f.arm);
      expect(next.status()).toBe('LOCKED');
      gate.resolve();
      expect(await run).toBe('ARMED');
    }));
});

describe('global fleet reservation revocation', () => {
  it('blocks an opposing event from a second owner while allowing protection of the first owned fill', async () =>
    withFixture(async (f) => {
      f.copier.lock();
      await f.copier.arm({ ...f.arm, followerAccountIds: ['02'] });
      const gate = deferred(),
        started = deferred(),
        original = f.adapter.placeOrder.bind(f.adapter);
      const calls: string[] = [];
      vi.spyOn(f.adapter, 'placeOrder').mockImplementation(async (r) => {
        calls.push(r.intent.side);
        if (r.accountId === '02') {
          started.resolve();
          await gate.promise;
        }
        return original(r);
      });
      const first = f.copier.copyEntry(f.event().eventId, intent);
      await started.promise;
      const next = new OfflineFanoutController(
        f.adapter,
        config,
        f.journal,
        f.clock,
        1000,
      );
      await next.arm({ ...f.arm, followerAccountIds: ['03'] });
      await expect(
        next.copyEntry(f.event(2, 'SHORT').eventId, {
          ...intent,
          side: 'SHORT',
        }),
      ).rejects.toThrow('COPIER_HEDGE_CONFLICT');
      expect(calls).toEqual(['LONG']);
      expect(next.status()).toBe('HALTED');
      gate.resolve();
      const results = await first;
      expect(results[0]?.attempt?.outcome.target).toBe('VERIFIED');
      expect(f.copier.status()).toBe('HALTED');
    }));
});

describe('prepared fan-out session integration', () => {
  it('halts before dispatch when a prewarmed leader becomes unavailable', async () => {
    const f = await fixture(['02']);
    await f.copier.prepare(intent);
    const list = f.adapter.listAccounts.bind(f.adapter);
    vi.spyOn(f.adapter, 'listAccounts').mockImplementation(async () => {
      const fleet = await list();
      fleet.find((a) => a.accountId === '01')!.enabled = false;
      return fleet;
    });
    const entry = vi.spyOn(f.adapter, 'placeOrder');
    await f.copier.copyEntry(f.event().eventId, intent);
    expect(f.copier.status()).toBe('HALTED');
    expect(entry).not.toHaveBeenCalled();
  });
  it('cannot rearm after losing leader identity while disarmed', async () => {
    const f = await fixture(['02']);
    f.copier.lock();
    f.copier.invalidateContext('01');
    expect(f.copier.status()).toBe('HALTED');
    await expect(f.copier.arm(f.arm)).rejects.toThrow('OFFLINE_ARM_REFUSED');
  });
  it('uses prewarmed preparation without repeating initial fleet reads', async () => {
    const f = await fixture(['02', '03']);
    await f.copier.prepare(intent);
    const prepare = vi.spyOn(f.copier, 'prepare');
    const results = await f.copier.copyEntry(f.event().eventId, intent);
    expect(prepare).not.toHaveBeenCalled();
    expect(results.every((r) => r.attempt?.outcome.stop === 'VERIFIED')).toBe(
      true,
    );
  });
  it('refreshes preparation for a changed exact intent', async () => {
    const f = await fixture(['02']);
    await f.copier.prepare(intent);
    const quote = vi.spyOn(f.adapter, 'getQuote');
    await f.copier.copyEntry(f.event().eventId, {
      ...intent,
      takeProfitPoints: '90',
    });
    expect(quote).toHaveBeenCalledTimes(2);
  });
  it('isolates lost follower context and never catches up its skipped event', async () => {
    const f = await fixture(['02', '03']);
    f.copier.invalidateContext('02');
    const event = f.event();
    const results = await f.copier.copyEntry(event.eventId, intent);
    expect(results[0]!.attempt).toBeNull();
    expect(results[1]!.attempt?.outcome.stop).toBe('VERIFIED');
    await f.copier.restoreContext('02');
    const entry = vi.spyOn(f.adapter, 'placeOrder');
    await f.copier.copyEntry(event.eventId, intent);
    expect(entry).not.toHaveBeenCalled();
  });
  it('invalidates the session globally on leader context loss and clock rollback', async () => {
    const f = await fixture(['02']);
    f.copier.invalidateContext('01');
    expect(f.copier.status()).toBe('HALTED');
    const g = await fixture(['02']);
    g.advance(-1);
    expect(g.copier.status()).toBe('HALTED');
    const entry = vi.spyOn(g.adapter, 'placeOrder');
    await expect(g.copier.copyEntry(g.event().eventId, intent)).rejects.toThrow(
      'OFFLINE_ENTRY_LOCKED',
    );
    expect(entry).not.toHaveBeenCalled();
  });
  it('rejects context loss between preparation and actual submission without blocking peers', async () => {
    const f = await fixture(['02', '03']);
    const read = f.adapter.getAccountState.bind(f.adapter);
    vi.spyOn(f.adapter, 'getAccountState').mockImplementation(async (id) => {
      const state = await read(id);
      if (id === '02') f.copier.invalidateContext('02');
      return state;
    });
    const results = await f.copier.copyEntry(f.event().eventId, intent);
    expect(results[0]!.attempt?.terminal?.result).toBe('NOT_SENT');
    expect(results[1]!.attempt?.outcome.stop).toBe('VERIFIED');
  });
});
