import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { Journal } from '../packages/execution/src/journal.ts';
import { OfflineFanoutController } from '../packages/execution/src/fanout-controller.ts';
import { leaderEventSchema } from '../packages/execution/src/copier-events.ts';
import { MockVestAdapter } from '../packages/simulator/src/index.ts';
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
    2000,
  );
  journal.copier.registerLeaderStream({
    environment: 'OFFLINE_FIXTURE',
    evidence: 'SYNTHETIC',
    leaderAccountId: '01',
    sourceId: 'preparation-recovery',
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
  let sequence = 0;
  const leaderEntry = () => {
    const providerEventId = randomUUID();
    return leaderEventSchema.parse({
      environment: 'OFFLINE_FIXTURE',
      evidence: 'SYNTHETIC',
      origin: 'ACCEPTED_EVENT',
      leaderAccountId: '01',
      sourceId: 'preparation-recovery',
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
  };
  const event = leaderEntry();
  const entryId = copier.acceptSyntheticLeaderEvent(event).eventId;
  await copier.copyEntry(entryId, intent);
  const add = copier.acceptSyntheticLeaderEvent(
    leaderEventSchema.parse({
      ...event,
      providerEventId: randomUUID(),
      sequence: ++sequence,
      kind: 'ADD',
      quantity: '0.25',
    }),
  ).eventId;
  await copier.copyChange(add);
  const closeEvent = () =>
    copier.acceptSyntheticLeaderEvent(
      leaderEventSchema.parse({
        ...event,
        providerEventId: randomUUID(),
        sequence: ++sequence,
        kind: 'CLOSE',
      }),
    ).eventId;
  const newEntry = () =>
    copier.acceptSyntheticLeaderEvent(leaderEntry()).eventId;
  const holdPreparation = () => {
    let release!: () => void, started!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const reached = new Promise<void>((resolve) => {
      started = resolve;
    });
    const original = adapter.getQuote.bind(adapter);
    vi.spyOn(adapter, 'getQuote').mockImplementationOnce(async () => {
      const quote = await original();
      started();
      await gate;
      return quote;
    });
    const pending = copier.prepare(intent);
    // Attach the rejection assertion before triggering competing work.
    const refused = expect(pending).rejects.toThrow(
      'READINESS_PREPARATION_CHANGED',
    );
    return { reached, release, refused };
  };
  return {
    journal,
    adapter,
    copier,
    newEntry,
    closeEvent,
    holdPreparation,
    async close() {
      await adapter.disconnect();
      journal.close();
      vi.restoreAllMocks();
    },
  };
}
describe('prepared follower evidence follows account changes', () => {
  it('automatically refreshes readiness after a completed close at the same clock time', async () => {
    const f = await fixture();
    try {
      await f.copier.prepare(intent);
      await f.copier.copyChange(f.closeEvent());
      const rows = await f.copier.copyEntry(f.newEntry(), intent);
      expect(
        rows.every(
          (row) =>
            row.attempt?.outcome.stop === 'VERIFIED' &&
            row.attempt.outcome.target === 'VERIFIED',
        ),
      ).toBe(true);
    } finally {
      await f.close();
    }
  });
  it('an older pending prepare cannot republish evidence after a close completes', async () => {
    const f = await fixture(),
      hold = f.holdPreparation();
    try {
      await hold.reached;
      await f.copier.copyChange(f.closeEvent());
      hold.release();
      await hold.refused;
      const rows = await f.copier.copyEntry(f.newEntry(), intent);
      expect(rows.every((row) => row.attempt?.outcome.fill === 'FILLED')).toBe(
        true,
      );
      expect(f.copier.status()).toBe('ARMED');
    } finally {
      hold.release();
      await f.close();
    }
  });
  it('context invalidation and restoration reject pending preparation even with unchanged economics', async () => {
    const f = await fixture(),
      hold = f.holdPreparation();
    try {
      await hold.reached;
      f.copier.invalidateContext('02');
      await f.copier.restoreContext('02');
      hold.release();
      await hold.refused;
      await expect(f.copier.prepare(intent)).resolves.toMatchObject({
        source: 'LOCAL_FIXTURE',
      });
      expect(f.copier.status()).toBe('ARMED');
    } finally {
      hold.release();
      await f.close();
    }
  });
  it('an UNKNOWN operator result invalidates pending readiness without revoking valid other followers', async () => {
    const f = await fixture(),
      hold = f.holdPreparation();
    try {
      await hold.reached;
      const root = f.journal.mutations
        .roots()
        .find((row) => row.accountId === '02')!;
      f.adapter.injectOwnedMutationFault('02', 'UNKNOWN_AFTER');
      const result = await f.copier.repairOwnedRoot({
        actionId: randomUUID(),
        rootId: root.rootId,
        expectedRootRevision: root.revision,
        operation: 'FLATTEN',
      });
      expect(result.state).toBe('UNKNOWN');
      hold.release();
      await hold.refused;
      expect(f.copier.status()).toBe('ARMED');
      expect(f.journal.mutations.reservation(root.rootId)?.commandId).toBe(
        result.operationId,
      );
    } finally {
      hold.release();
      await f.close();
    }
  });
});
