import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { createManagedFixture } from '../packages/browser-execution/src/managed-fixture.ts';
import { OfflineFanoutController } from '../packages/execution/src/fanout-controller.ts';
import { Journal } from '../packages/execution/src/journal.ts';
import { leaderEventSchema } from '../packages/execution/src/copier-events.ts';
import { MockVestAdapter } from '../packages/simulator/src/index.ts';
import { D } from '../packages/core/src/index.ts';
import { observeManagedLaunch } from './fixtures/managed-vest-page.ts';
import { config, intent, NOW } from './helpers.ts';
async function fixture(
  run: (f: {
    managed: Awaited<ReturnType<typeof createManagedFixture>>;
    observed: ReturnType<typeof observeManagedLaunch>;
    journal: Journal;
    copier: OfflineFanoutController;
    eventId: string;
  }) => Promise<void>,
) {
  const observed = observeManagedLaunch(),
    journal = new Journal();
  let managed: Awaited<ReturnType<typeof createManagedFixture>> | undefined;
  try {
    managed = await createManagedFixture(config, () => NOW);
    const copier = new OfflineFanoutController(
      managed.adapter,
      config,
      journal,
      () => NOW,
      1500,
    );
    managed.subscribeLifecycle((event) => {
      if (event.scope === 'GLOBAL') copier.halt('CHANNEL_INTEGRITY_LOST');
      else if (event.accountId) copier.invalidateContext(event.accountId);
    });
    journal.copier.registerLeaderStream({
      environment: 'OFFLINE_FIXTURE',
      evidence: 'SYNTHETIC',
      leaderAccountId: '01',
      sourceId: 'managed-synthetic-events',
      symbol: 'NDX',
      baselineSequence: 0,
    });
    const { eventId } = journal.copier.recordLeaderEvent(
      leaderEventSchema.parse({
        environment: 'OFFLINE_FIXTURE',
        evidence: 'SYNTHETIC',
        origin: 'ACCEPTED_EVENT',
        leaderAccountId: '01',
        sourceId: 'managed-synthetic-events',
        symbol: 'NDX',
        providerEventId: 'entry-1',
        entryRootId: 'entry-1',
        sequence: 1,
        occurredAt: NOW,
        kind: 'ENTRY',
        side: 'LONG',
        quantity: '1',
        leverage: intent.leverage,
      }),
      { generation: randomUUID(), detectedAt: NOW },
    );
    await run({ managed, observed, journal, copier, eventId });
  } finally {
    await managed?.close();
    journal.close();
    observed.restore();
    vi.restoreAllMocks();
    if (managed) expect(existsSync(observed.profile())).toBe(false);
  }
}
async function arm(f: {
  managed: Awaited<ReturnType<typeof createManagedFixture>>;
  copier: OfflineFanoutController;
}) {
  await f.managed.armFixture();
  await f.copier.arm({
    environment: 'OFFLINE_FIXTURE',
    evidence: 'SYNTHETIC',
    leaderAccountId: '01',
    followerAccountIds: ['02', '03'],
    symbol: 'NDX',
    maxLeverage: '50',
    maxNotionalPerAccount: '100000',
    maxPlannedLossPerAccount: '10',
    expiresAt: NOW + 10000,
  });
}

describe('owned headless local fixture browser boundary', () => {
  it('cannot restore arming after an operator lock during readiness verification', async () =>
    fixture(async (f) => {
      const arming = f.managed.armFixture();
      f.managed.lock();
      await expect(arming).rejects.toThrow('MANAGED_FIXTURE_ARM_REFUSED');
      expect(f.managed.inspect().session).toBe('LOCKED');
    }));
  it('launches only headless private profiles and begins locked without manufactured entries', async () =>
    fixture(async (f) => {
      expect(f.observed.launch).toHaveBeenCalledTimes(1);
      const options = f.observed.launch.mock.calls[0]![1]!;
      expect(options.headless).toBe(true);
      expect(options.serviceWorkers).toBe('block');
      expect(options.args).toEqual(
        expect.arrayContaining([
          '--disable-background-networking',
          '--disable-component-update',
          '--disable-sync',
          '--disable-default-apps',
        ]),
      );
      expect(f.managed.inspect()).toMatchObject({
        environment: 'OFFLINE_FIXTURE',
        evidence: 'SYNTHETIC',
        session: 'LOCKED',
        state: 'READY',
        blockedRequests: 0,
      });
      expect(f.managed.inspect().contexts).toHaveLength(10);
      expect(
        new Set(
          f.managed.inspect().contexts.map((context) => context.contextId),
        ).size,
      ).toBe(10);
      expect(f.copier.status()).toBe('LOCKED');
      const entries = vi.spyOn(MockVestAdapter.prototype, 'placeOrder');
      expect(
        (await f.managed.adapter.listAccounts()).every(
          (account) => account.positions.length === 0,
        ),
      ).toBe(true);
      expect(f.journal.copier.eventFollowers(f.eventId)).toEqual([]);
      await expect(f.copier.copyEntry(f.eventId, intent)).rejects.toThrow(
        'LOCKED',
      );
      expect(entries).not.toHaveBeenCalled();
      expect(
        'page' in f.managed ||
          'context' in f.managed ||
          'origin' in f.managed ||
          'profile' in f.managed,
      ).toBe(false);
    }));
  it('executes entries and independently verifies full protection across actual page bindings', async () =>
    fixture(async (f) => {
      await arm(f);
      const results = await f.copier.copyEntry(f.eventId, intent);
      expect(results.map((row) => row.attempt!.outcome)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            submission: 'ACCEPTED',
            stop: 'VERIFIED',
            target: 'VERIFIED',
            exposure: 'PRESENT',
          }),
        ]),
      );
      expect(
        results.every((row) => row.attempt!.outcome.stop === 'VERIFIED'),
      ).toBe(true);
      const orders = vi.spyOn(MockVestAdapter.prototype, 'placeOrder');
      await f.copier.copyEntry(f.eventId, intent);
      expect(orders).not.toHaveBeenCalled();
      expect(f.managed.inspect().blockedRequests).toBe(0);
    }));
  it('isolates a closed follower while another valid follower still executes', async () =>
    fixture(async (f) => {
      await arm(f);
      await f.managed.exerciseFault('02', 'CLOSE_PAGE');
      expect(f.copier.status()).toBe('ARMED');
      const results = await f.copier.copyEntry(f.eventId, intent);
      expect(results.find((row) => row.accountId === '02')!.attempt).toBeNull();
      expect(
        results.find((row) => row.accountId === '03')!.attempt!.outcome.stop,
      ).toBe('VERIFIED');
      expect(
        f.managed
          .inspect()
          .contexts.find((context) => context.accountId === '02')!.ready,
      ).toBe(false);
    }));
  it.each(['UNEXPECTED_NAVIGATION', 'IDENTITY_CHANGE', 'CLOSE_PAGE'] as const)(
    'halts globally on leader %s with zero entry effects',
    async (fault) =>
      fixture(async (f) => {
        await arm(f);
        const orders = vi.spyOn(MockVestAdapter.prototype, 'placeOrder');
        try {
          await f.managed.exerciseFault('01', fault);
        } catch {
          /* Identity refusal is expected. */
        }
        expect(f.copier.status()).toBe('HALTED');
        await expect(f.copier.copyEntry(f.eventId, intent)).rejects.toThrow();
        expect(orders).not.toHaveBeenCalled();
      }),
  );
  it('blocks actual nonlocal HTTP and WebSocket attempts without contacting a provider', async () =>
    fixture(async (f) => {
      await arm(f);
      const page = f.observed
        .context()
        .pages()
        .find((page) => page.url().includes('/context/'))!;
      // Test-only access via launch spy. Runtime API never exposes page handles or URLs.
      await page.evaluate(() => {
        const image = document.createElement('img');
        image.src = 'https://fixture-denied.invalid/image.png';
        document.body.append(image);
      });
      // CSP may deny the image before routing; WebSocket interception is exercised separately.
      await page.evaluate(() => {
        try {
          new WebSocket('wss://fixture-denied.invalid/socket');
        } catch {
          /* Expected refusal. */
        }
      });
      if (f.managed.inspect().state === 'READY')
        await f.managed.exerciseFault('02', 'UNAPPROVED_REQUEST');
      await vi.waitFor(() =>
        expect(f.managed.inspect().blockedRequests).toBeGreaterThan(0),
      );
      expect(f.copier.status()).toBe('HALTED');
    }));
  it('keeps per-account provider work serialized while unrelated follower completes', async () =>
    fixture(async (f) => {
      await arm(f);
      let release!: () => void;
      const hold = new Promise<void>((resolve) => {
        release = resolve;
      });
      const original = MockVestAdapter.prototype.placeOrder;
      const entries = vi
        .spyOn(MockVestAdapter.prototype, 'placeOrder')
        .mockImplementation(async function (this: MockVestAdapter, request) {
          if (request.accountId === '02') await hold;
          return original.call(this, request);
        });
      const pending = f.copier.copyEntry(f.eventId, intent);
      try {
        await vi.waitFor(
          () =>
            expect(
              f.copier.snapshot(f.eventId).find((row) => row.accountId === '03')
                ?.attempt?.outcome.stop,
            ).toBe('VERIFIED'),
          { timeout: 2500 },
        );
        expect(entries).toHaveBeenCalledTimes(2);
      } finally {
        release();
        await pending;
      }
    }));
  it('forwards atomic owned reductions and protection changes through named page operations', async () =>
    fixture(async (f) => {
      await arm(f);
      const result = (await f.copier.copyEntry(f.eventId, intent))[0]!;
      let account = await f.managed.adapter.getAccountState('02');
      const position = account.positions[0]!;
      const base = {
        environment: 'OFFLINE_FIXTURE' as const,
        evidence: 'SYNTHETIC' as const,
        requestId: 'a'.repeat(64),
        eventId: f.eventId,
        rootKey: result.command!.rootKey,
        accountId: '02',
        entryRequestId: result.attempt!.attemptId,
        symbol: 'NDX' as const,
        side: 'LONG' as const,
        sequence: 2,
        expectedRevision: account.revision,
        expectedQuantity: position.quantity,
        expectedBasis: position.entryPrice,
        leverage: position.leverage,
        maxNotional: '100000',
        maxPlannedLoss: '10',
      };
      const reduced = await f.managed.adapter.reduceOwnedPosition({
        ...base,
        operation: 'REDUCE',
        deltaQuantity: new D(position.quantity)
          .div(2)
          .div(config.sizeStep)
          .floor()
          .mul(config.sizeStep)
          .toFixed(),
      });
      expect(reduced.status, JSON.stringify(reduced)).toBe('VERIFIED');
      expect(await f.managed.adapter.readOwnedMutation(base.requestId)).toEqual(
        reduced,
      );
      account = await f.managed.adapter.getAccountState('02');
      const changed = await f.managed.adapter.changeOwnedProtection({
        ...base,
        requestId: 'b'.repeat(64),
        sequence: 3,
        operation: 'STOP_CHANGED',
        expectedRevision: account.revision,
        expectedQuantity: account.positions[0]!.quantity,
        price: new D(account.positions[0]!.entryPrice).minus(60).toFixed(),
      });
      expect(changed.status).toBe('VERIFIED');
      await expect(f.managed.adapter.flattenAccount('02')).rejects.toThrow(
        'OWNERSHIP_REQUIRED',
      );
    }));
  it(
    'retains the actual account lane after the controller reports submission UNKNOWN',
    async () =>
      fixture(async (f) => {
        await arm(f);
        let release!: () => void;
        const hold = new Promise<void>((resolve) => {
          release = resolve;
        });
        const original = MockVestAdapter.prototype.placeOrder;
        const entries = vi
          .spyOn(MockVestAdapter.prototype, 'placeOrder')
          .mockImplementation(async function (this: MockVestAdapter, request) {
            if (request.accountId === '02') await hold;
            return original.call(this, request);
          });
        const pending = f.copier.copyEntry(f.eventId, intent);
        let readSettled = false,
          read: Promise<unknown> | undefined;
        try {
          await vi.waitFor(() =>
            expect(
              entries.mock.calls.some(
                ([request]) => request.accountId === '02',
              ),
            ).toBe(true),
          );
          read = f.managed.adapter.getAccountState('02').then((value) => {
            readSettled = true;
            return value;
          });
          await vi.waitFor(
            () =>
              expect(
                f.copier
                  .snapshot(f.eventId)
                  .find((row) => row.accountId === '02')?.attempt?.outcome
                  .submission,
              ).toBe('UNKNOWN'),
            { timeout: 6500 },
          );
          expect(readSettled).toBe(false);
          expect(
            f.copier.snapshot(f.eventId).find((row) => row.accountId === '03')
              ?.attempt?.outcome.stop,
          ).toBe('VERIFIED');
        } finally {
          release();
          await pending;
          await read;
        }
        expect(readSettled).toBe(true);
        expect(entries).toHaveBeenCalledTimes(2);
      }),
    30000,
  );
  it('sanitizes raw provider failures and page identity corruption', async () =>
    fixture(async (f) => {
      const canary =
        'synthetic-managed-secret-a26e0c1bb7d6445b96bacdff2f847840';
      await arm(f);
      vi.spyOn(MockVestAdapter.prototype, 'getOpenOrders').mockRejectedValue(
        new Error(canary),
      );
      const result = await f.copier.copyEntry(f.eventId, intent);
      expect(
        JSON.stringify([
          result,
          f.copier.snapshot(f.eventId),
          f.journal.events(),
          f.managed.inspect(),
        ]),
      ).not.toContain(canary);
      expect(
        result.every((row) => row.attempt?.outcome.submission !== 'ACCEPTED'),
      ).toBe(true);
    }));
  it('refuses unsolicited page-originated mutations without provider effects', async () =>
    fixture(async (f) => {
      await arm(f);
      const identity = f.managed
        .inspect()
        .contexts.find((context) => context.accountId === '02')!;
      const page = f.observed
        .context()
        .pages()
        .find((page) => page.url().endsWith(identity.contextId))!;
      const entries = vi.spyOn(MockVestAdapter.prototype, 'placeOrder');
      await expect(
        page.evaluate(
          async (id) =>
            (
              globalThis as unknown as {
                fixture: {
                  invoke: { submitEntry(payload: unknown): Promise<unknown> };
                };
              }
            ).fixture.invoke.submitEntry({ id, payload: {} }),
          randomUUID(),
        ),
      ).rejects.toThrow();
      expect(entries).not.toHaveBeenCalled();
      expect(f.copier.status()).toBe('HALTED');
    }));
  it('rejects fabricated page replies instead of treating them as provider evidence', async () =>
    fixture(async (f) => {
      await arm(f);
      const identity = f.managed
        .inspect()
        .contexts.find((context) => context.accountId === '02')!;
      const page = f.observed
        .context()
        .pages()
        .find((page) => page.url().endsWith(identity.contextId))!;
      await page.evaluate(() => {
        const window = globalThis as unknown as {
          fixture: {
            invoke: Record<string, (payload: unknown) => Promise<unknown>>;
          };
        };
        window.fixture.invoke = {
          ...window.fixture.invoke,
          readAccount: async () => ({ accountId: '02', invented: true }),
        };
      });
      await expect(f.managed.adapter.getAccountState('02')).rejects.toThrow(
        'MANAGED_FIXTURE_OPERATION_UNCONFIRMED',
      );
      expect(f.copier.status()).toBe('HALTED');
    }));
  it.each(['01', '02'])(
    'revokes account %s authority when actual page identity reads fail',
    async (accountId) =>
      fixture(async (f) => {
        await arm(f);
        const identity = f.managed
          .inspect()
          .contexts.find((context) => context.accountId === accountId)!;
        const page = f.observed
          .context()
          .pages()
          .find((page) => page.url().endsWith(identity.contextId))!;
        const read = vi
          .spyOn(page, 'evaluate')
          .mockRejectedValueOnce(
            new Error('synthetic-page-identity-unavailable'),
          );
        await expect(
          f.managed.adapter.getAccountState(accountId),
        ).rejects.toThrow('IDENTITY_UNPROVEN');
        read.mockRestore();
        const entries = vi.spyOn(MockVestAdapter.prototype, 'placeOrder');
        if (accountId === '01') {
          expect(f.copier.status()).toBe('HALTED');
          await expect(f.copier.copyEntry(f.eventId, intent)).rejects.toThrow();
          expect(entries).not.toHaveBeenCalled();
        } else {
          expect(
            f.managed
              .inspect()
              .contexts.find((context) => context.accountId === accountId)!
              .ready,
          ).toBe(false);
          await f.copier.copyEntry(f.eventId, intent);
          expect(
            entries.mock.calls.map(([request]) => request.accountId),
          ).toEqual(['03']);
        }
      }),
  );
  it('invalidates a follower on a fixture renderer-crash notification', async () =>
    fixture(async (f) => {
      await arm(f);
      const identity = f.managed
        .inspect()
        .contexts.find((context) => context.accountId === '02')!;
      const page = f.observed
        .context()
        .pages()
        .find((page) => page.url().endsWith(identity.contextId))!;
      // Exercises the lifecycle listener; this is a synthetic crash notification.
      (page as unknown as { emit(event: 'crash'): void }).emit('crash');
      const entries = vi.spyOn(MockVestAdapter.prototype, 'placeOrder');
      await f.copier.copyEntry(f.eventId, intent);
      expect(entries.mock.calls.map(([request]) => request.accountId)).toEqual([
        '03',
      ]);
    }));
  it('integrates accepted changes with the controller and isolates local lifecycle failure', async () =>
    fixture(async (f) => {
      await arm(f);
      const entry = f.journal.copier.leaderEvent(f.eventId)!;
      f.copier.acceptSyntheticLeaderEvent(entry);
      await f.copier.copyEntry(f.eventId, intent);
      const change = (
        sequence: number,
        kind: 'REDUCE' | 'STOP_CHANGED' | 'TARGET_CHANGED',
        value: string,
      ) =>
        f.copier.acceptSyntheticLeaderEvent(
          leaderEventSchema.parse({
            ...entry,
            providerEventId: `change-${sequence}`,
            sequence,
            kind,
            quantity: kind === 'REDUCE' ? value : '1',
            ...(kind === 'REDUCE' ? {} : { price: value }),
          }),
        ).eventId;
      const reduced = await f.copier.copyChange(change(2, 'REDUCE', '0.5'));
      expect(reduced.every((row) => row.state === 'VERIFIED')).toBe(true);
      const stopped = await f.copier.copyChange(
        change(3, 'STOP_CHANGED', '30350'),
      );
      expect(stopped.every((row) => row.state === 'VERIFIED')).toBe(true);
      await f.managed.exerciseFault('02', 'CLOSE_PAGE');
      const mutations = vi.spyOn(
        MockVestAdapter.prototype,
        'changeOwnedProtection',
      );
      const target = await f.copier.copyChange(
        change(4, 'TARGET_CHANGED', '30490'),
      );
      expect(target.find((row) => row.accountId === '03')?.state).toBe(
        'VERIFIED',
      );
      expect(
        mutations.mock.calls.map(([request]) => request.accountId),
      ).toEqual(['03']);
      await f.managed.exerciseFault('01', 'CLOSE_PAGE');
      expect(f.copier.status()).toBe('HALTED');
      const later = f.journal.copier.recordLeaderEvent(
        leaderEventSchema.parse({
          ...entry,
          providerEventId: 'change-5',
          sequence: 5,
          kind: 'STOP_CHANGED',
          price: '30360',
        }),
        { generation: randomUUID(), detectedAt: NOW },
      );
      await f.copier.copyChange(later.eventId).catch(() => []);
      expect(mutations).toHaveBeenCalledTimes(1);
    }));
  it('new browser ownership creates a new generation and returns to LOCKED', async () =>
    fixture(async (f) => {
      await arm(f);
      const generation = f.managed.inspect().generation;
      await f.managed.close();
      const restarted = await createManagedFixture(config, () => NOW);
      try {
        expect(restarted.inspect().generation).not.toBe(generation);
        expect(restarted.inspect().session).toBe('LOCKED');
      } finally {
        await restarted.close();
      }
    }));
});
