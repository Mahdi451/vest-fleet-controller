import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import {
  CopierMutations,
  ownedRootId,
  ownedRootSchema,
  type OwnedRoot,
  type MutationPlan,
} from '../packages/execution/src/copier-mutations.ts';
const hash = 'a'.repeat(64),
  eventId = 'b'.repeat(64),
  generation = randomUUID();
function fixture() {
  const db = new DatabaseSync(':memory:');
  const store = new CopierMutations(db);
  const root: OwnedRoot = {
    rootId: ownedRootId(hash, '02'),
    rootKey: hash,
    entryEventId: eventId,
    accountId: '02',
    entryRequestId: 'entry-02',
    symbol: 'NDX',
    side: 'LONG',
    initialFollowerQuantity: '1',
    initialLeaderQuantity: '1',
    quantity: '1',
    basis: '30400',
    leverage: '10',
    providerRevision: 1,
    revision: 0,
    lastEconomicSequence: 1,
    certainty: 'PRESENT',
    closed: false,
    stopPrice: '30320',
    targetPrice: '30480',
    stopId: 'stop-02',
    targetId: 'target-02',
    updatedAt: 100,
  };
  store.createRoot(root);
  const plan: MutationPlan = {
    eventId: 'c'.repeat(64),
    rootId: root.rootId,
    rootKey: hash,
    accountId: '02',
    operation: 'REDUCE',
    sequence: 2,
    deltaQuantity: '0.5',
    price: null,
    ownerGeneration: generation,
    createdAt: 101,
  };
  return { db, store, root, plan };
}
describe('durable mutation journal boundaries', () => {
  it('replays stable economics but rejects changed payload and invalid plans', () => {
    const f = fixture();
    try {
      const row = f.store.claim(f.plan, 100, generation).record;
      expect(
        f.store.claim(
          { ...f.plan, ownerGeneration: randomUUID(), createdAt: 999 },
          100,
          generation,
        ).record,
      ).toEqual(row);
      expect(() =>
        f.store.claim({ ...f.plan, deltaQuantity: '0.6' }, 100, generation),
      ).toThrow('MUTATION_IDENTITY_CONFLICT');
      expect(() =>
        f.store.claim({ ...f.plan, rootId: hash }, 100, generation),
      ).toThrow('MUTATION_PLAN_INVALID');
    } finally {
      f.db.close();
    }
  });
  it('rejects illegal or stale transitions without changing the journal', () => {
    const f = fixture();
    try {
      const row = f.store.claim(f.plan, 100, generation).record;
      expect(() =>
        f.store.transition(row.mutationId, 'QUEUED', 'VERIFIED', 102),
      ).toThrow('MUTATION_STATE_CONFLICT');
      expect(() =>
        f.store.transition(row.mutationId, 'QUEUED', 'NOT_SENT', 99),
      ).toThrow('MUTATION_STATE_CONFLICT');
      f.store.transition(row.mutationId, 'QUEUED', 'NOT_SENT', 102, {
        reason: 'OWNERSHIP_UNPROVEN',
      });
      expect(() =>
        f.store.transition(row.mutationId, 'NOT_SENT', 'QUEUED', 103),
      ).toThrow('MUTATION_STATE_CONFLICT');
      expect(f.store.get(row.mutationId)?.state).toBe('NOT_SENT');
    } finally {
      f.db.close();
    }
  });
  it('cannot change root ownership, overwrite a revision, or reopen a closed root', () => {
    const f = fixture();
    try {
      expect(() =>
        f.store.createRoot({ ...f.root, entryRequestId: 'other' }),
      ).toThrow('MUTATION_IDENTITY_CONFLICT');
      expect(() =>
        f.store.updateRoot(f.root.rootId, 0, { accountId: '03' }),
      ).toThrow('MUTATION_ROOT_REFUSED');
      const closed = f.store.updateRoot(f.root.rootId, 0, {
        quantity: '0',
        basis: null,
        certainty: 'ABSENT',
        closed: true,
        stopPrice: null,
        targetPrice: null,
        stopId: null,
        targetId: null,
        updatedAt: 101,
      });
      expect(() =>
        f.store.updateRoot(f.root.rootId, 0, { updatedAt: 102 }),
      ).toThrow('MUTATION_REVISION_CONFLICT');
      expect(() =>
        f.store.updateRoot(f.root.rootId, closed.revision, {
          quantity: '1',
          basis: '30400',
          certainty: 'PRESENT',
          closed: false,
          updatedAt: 102,
        }),
      ).toThrow('MUTATION_ROOT_REFUSED');
    } finally {
      f.db.close();
    }
  });
  it('rejects exposure/basis contradictions including decimal zero', () => {
    const f = fixture();
    try {
      expect(
        ownedRootSchema.safeParse({ ...f.root, quantity: '0.0' }).success,
      ).toBe(false);
      expect(
        ownedRootSchema.safeParse({ ...f.root, basis: null }).success,
      ).toBe(false);
      expect(
        ownedRootSchema.safeParse({ ...f.root, certainty: 'ABSENT' }).success,
      ).toBe(false);
    } finally {
      f.db.close();
    }
  });
  it('detects modified persistent bytes before returning any mutation', () => {
    const f = fixture();
    try {
      const row = f.store.claim(f.plan, 100, generation).record;
      f.db.prepare('UPDATE copier_mutations SET record=? WHERE id=?').run(
        JSON.stringify({
          value: { ...row, deltaQuantity: '10' },
          hash: row.payloadHash,
        }),
        row.mutationId,
      );
      expect(() => f.store.get(row.mutationId)).toThrow(
        'MUTATION_STORAGE_INVALID',
      );
    } finally {
      f.db.close();
    }
  });
  it('supersedes only queued protection intents, preserving economic commands', () => {
    const f = fixture();
    try {
      const economic = f.store.claim(f.plan, 100, generation).record;
      const stop = f.store.claim(
        {
          ...f.plan,
          eventId: 'd'.repeat(64),
          operation: 'STOP_CHANGED',
          sequence: 3,
          deltaQuantity: null,
          price: '30330',
        },
        100,
        generation,
      ).record;
      const latest = f.store.claim(
        {
          ...f.plan,
          eventId: 'e'.repeat(64),
          operation: 'STOP_CHANGED',
          sequence: 4,
          deltaQuantity: null,
          price: '30340',
        },
        100,
        generation,
      ).record;
      expect(f.store.get(economic.mutationId)?.state).toBe('QUEUED');
      expect(f.store.get(stop.mutationId)?.state).toBe('SUPERSEDED');
      expect(latest.state).toBe('QUEUED');
    } finally {
      f.db.close();
    }
  });
});
