import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { Journal } from '../packages/execution/src/journal.ts';
import { OfflineFanoutController } from '../packages/execution/src/fanout-controller.ts';
import { leaderEventSchema } from '../packages/execution/src/copier-events.ts';
import type { OwnedRepairIntent } from '../packages/execution/src/copier-owned-repairs.ts';
import { MockVestAdapter } from '../packages/simulator/src/index.ts';
import { config, intent, NOW } from './helpers.ts';

const marker = 'synthetic-secret_329dc78511454c279b35d54f58719174';
async function fixture(
  run: (f: {
    journal: Journal;
    copier: OfflineFanoutController;
    adapter: MockVestAdapter;
    root: () => NonNullable<ReturnType<Journal['mutations']['root']>>;
    directory: string;
  }) => Promise<void>,
) {
  const directory = mkdtempSync(join(tmpdir(), 'offline-boundary-secret-'));
  const journal = new Journal(join(directory, 'journal.sqlite'));
  const adapter = new MockVestAdapter(config, () => NOW, undefined, '30400');
  await adapter.connect();
  const copier = new OfflineFanoutController(
    adapter,
    config,
    journal,
    () => NOW,
    100,
  );
  try {
    journal.copier.registerLeaderStream({
      environment: 'OFFLINE_FIXTURE',
      evidence: 'SYNTHETIC',
      leaderAccountId: '01',
      sourceId: 'secret-boundary',
      symbol: 'NDX',
      baselineSequence: 0,
    });
    await copier.arm({
      environment: 'OFFLINE_FIXTURE',
      evidence: 'SYNTHETIC',
      leaderAccountId: '01',
      followerAccountIds: ['02'],
      symbol: 'NDX',
      maxLeverage: '50',
      maxNotionalPerAccount: '100000',
      maxPlannedLossPerAccount: '10000',
      expiresAt: NOW + 10000,
    });
    const providerEventId = randomUUID();
    const entry = leaderEventSchema.parse({
      environment: 'OFFLINE_FIXTURE',
      evidence: 'SYNTHETIC',
      origin: 'ACCEPTED_EVENT',
      leaderAccountId: '01',
      sourceId: 'secret-boundary',
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
    const eventId = copier.acceptSyntheticLeaderEvent(entry).eventId;
    await copier.copyEntry(eventId, intent);
    const add = copier.acceptSyntheticLeaderEvent(
      leaderEventSchema.parse({
        ...entry,
        providerEventId: randomUUID(),
        sequence: 2,
        kind: 'ADD',
        quantity: '0.25',
      }),
    ).eventId;
    await copier.copyChange(add);
    await run({
      journal,
      copier,
      adapter,
      root: () => journal.mutations.roots()[0]!,
      directory,
    });
    for (const name of readdirSync(directory))
      expect(
        readFileSync(join(directory, name)).toString('latin1'),
      ).not.toContain(marker);
  } finally {
    await adapter.disconnect();
    journal.close();
    vi.restoreAllMocks();
    rmSync(directory, { recursive: true, force: true });
  }
}
function clean(...values: unknown[]) {
  for (const value of values)
    expect(
      typeof value === 'string' ? value : JSON.stringify(value),
    ).not.toContain(marker);
}

describe('new offline boundaries reject synthetic secret leakage', () => {
  it.each(['quote', 'account'] as const)(
    'sanitizes malformed %s evidence at the readiness boundary',
    async (boundary) =>
      fixture(async (f) => {
        let error: unknown;
        if (boundary === 'quote') {
          vi.spyOn(f.adapter, 'getQuote').mockResolvedValueOnce({
            [marker]: marker,
          } as unknown as Awaited<ReturnType<typeof f.adapter.getQuote>>);
        } else {
          f.copier.invalidateContext('02');
          vi.spyOn(f.adapter, 'getAccountState').mockResolvedValueOnce({
            [marker]: marker,
          } as unknown as Awaited<
            ReturnType<typeof f.adapter.getAccountState>
          >);
        }
        try {
          if (boundary === 'quote') await f.copier.prepare(intent);
          else await f.copier.restoreContext('02');
        } catch (value) {
          error = value;
        }
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toBe(
          boundary === 'quote'
            ? 'READINESS_QUOTE_INVALID'
            : 'COPIER_SYSTEM_FAILURE',
        );
        clean(String(error), f.journal.events(), f.journal.mutations.roots());
        expect(f.copier.status()).toBe(
          boundary === 'quote' ? 'ARMED' : 'HALTED',
        );
      }),
  );
  it.each(['controller', 'journal'] as const)(
    'sanitizes malformed operator input at the %s boundary before effects',
    async (boundary) =>
      fixture(async (f) => {
        const root = f.root();
        const malformed = {
          actionId: randomUUID(),
          rootId: root.rootId,
          expectedRootRevision: root.revision,
          operation: 'FLATTEN',
          [marker]: marker,
        } as unknown as OwnedRepairIntent;
        const submit = vi.spyOn(f.adapter, 'closeOwnedPosition');
        let error: unknown;
        try {
          if (boundary === 'controller')
            await f.copier.repairOwnedRoot(malformed);
          else f.journal.ownedRepairs.claim(malformed, '02', randomUUID(), NOW);
        } catch (value) {
          error = value;
        }
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toBe('OWNED_REPAIR_INTENT_INVALID');
        expect(submit).not.toHaveBeenCalled();
        expect(f.journal.ownedRepairs.records()).toEqual([]);
        clean(String(error), f.journal.events(), f.journal.mutations.roots());
      }),
  );
  it('never retains malformed reconciliation receipts after a lost acknowledgement', async () =>
    fixture(async (f) => {
      const root = f.root(),
        original = f.adapter.closeOwnedPosition.bind(f.adapter);
      const submit = vi
        .spyOn(f.adapter, 'closeOwnedPosition')
        .mockImplementationOnce(async (request) => {
          await original(request);
          throw new Error(marker);
        });
      const row = await f.copier.repairOwnedRoot({
        actionId: randomUUID(),
        rootId: root.rootId,
        expectedRootRevision: root.revision,
        operation: 'FLATTEN',
      });
      expect(row.state).toBe('UNKNOWN');
      const receipt = await f.adapter.readOwnedMutation(row.operationId);
      vi.spyOn(f.adapter, 'readOwnedMutation').mockResolvedValueOnce({
        ...receipt,
        [marker]: marker,
      } as unknown as NonNullable<typeof receipt>);
      await expect(
        f.copier.reconcileOwnedRepair(row.operationId),
      ).rejects.toThrow();
      expect(f.copier.status()).toBe('HALTED');
      clean(
        f.journal.ownedRepairs.records(),
        f.journal.mutations.roots(),
        f.journal.events(),
        f.copier.snapshot(root.entryEventId),
      );
      expect(f.journal.mutations.reservation(root.rootId)?.commandId).toBe(
        row.operationId,
      );
      expect(submit).toHaveBeenCalledTimes(1);
      expect((await f.copier.reconcileOwnedRepair(row.operationId)).state).toBe(
        'VERIFIED',
      );
      expect(submit).toHaveBeenCalledTimes(1);
    }));
});
