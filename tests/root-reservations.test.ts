import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import {
  CopierMutations,
  ownedRootId,
  type OwnedRoot,
} from '../packages/execution/src/copier-mutations.ts';
import { CopierOwnedRepairs } from '../packages/execution/src/copier-owned-repairs.ts';
import { ownedMutationRequestSchema } from '../packages/execution/src/owned-mutation-contract.ts';
import { copierHash } from '../packages/execution/src/copier-events.ts';
import {
  reserveRoot,
  releaseRoot,
  rootReservation,
  type RootReservation,
} from '../packages/execution/src/root-reservations.ts';

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'root-reservation-'));
  const path = join(directory, 'journal.sqlite');
  const db = new DatabaseSync(path),
    peer = new DatabaseSync(path);
  const store = new CopierMutations(db),
    repairs = new CopierOwnedRepairs(db);
  const root: OwnedRoot = {
    rootId: ownedRootId('a'.repeat(64), '02'),
    rootKey: 'a'.repeat(64),
    entryEventId: 'b'.repeat(64),
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
    stopPrice: null,
    targetPrice: null,
    stopId: null,
    targetId: null,
    updatedAt: 100,
  };
  store.createRoot(root);
  const reservation: RootReservation = {
    rootId: root.rootId,
    commandId: 'c'.repeat(64),
    kind: 'LEADER_EVENT',
    ownerGeneration: randomUUID(),
    rootRevision: 0,
    at: 101,
  };
  const transaction = <T>(connection: DatabaseSync, run: () => T): T => {
    connection.exec('BEGIN IMMEDIATE');
    try {
      const value = run();
      connection.exec('COMMIT');
      return value;
    } catch (error) {
      connection.exec('ROLLBACK');
      throw error;
    }
  };
  return {
    db,
    peer,
    store,
    repairs,
    root,
    reservation,
    transaction,
    close() {
      db.close();
      peer.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

describe('shared root dispatch reservations', () => {
  it('requires a transaction and admits only one owner across separate SQLite connections', () => {
    const f = fixture();
    try {
      expect(() => reserveRoot(f.db, f.reservation)).toThrow(
        'TRANSACTION_REQUIRED',
      );
      f.transaction(f.db, () => reserveRoot(f.db, f.reservation));
      expect(() =>
        f.transaction(f.peer, () =>
          reserveRoot(f.peer, {
            ...f.reservation,
            kind: 'OPERATOR_REPAIR',
            commandId: 'd'.repeat(64),
            ownerGeneration: randomUUID(),
          }),
        ),
      ).toThrow('ROOT_RESERVATION_BUSY');
      expect(rootReservation(f.peer, f.root.rootId)).toEqual(f.reservation);
      expect(() =>
        f.transaction(f.peer, () =>
          releaseRoot(f.peer, {
            ...f.reservation,
            ownerGeneration: randomUUID(),
          }),
        ),
      ).toThrow('ROOT_RESERVATION_STORAGE_INVALID');
      expect(rootReservation(f.db, f.root.rootId)).toEqual(f.reservation);
      f.transaction(f.peer, () => releaseRoot(f.peer, f.reservation));
      expect(rootReservation(f.db, f.root.rootId)).toBeNull();
    } finally {
      f.close();
    }
  });
  it('compares the current root revision inside dispatch admission', () => {
    const f = fixture();
    try {
      f.store.updateRoot(f.root.rootId, 0, { updatedAt: 101 });
      expect(() =>
        f.transaction(f.peer, () => reserveRoot(f.peer, f.reservation)),
      ).toThrow('ROOT_RESERVATION_STALE_REVISION');
      expect(rootReservation(f.db, f.root.rootId)).toBeNull();
    } finally {
      f.close();
    }
  });
  it.each(['copier_mutations', 'copier_owned_repairs'] as const)(
    'blocks legacy UNKNOWN rows in %s even without reservation metadata',
    (table) => {
      const f = fixture();
      try {
        const legacy =
          table === 'copier_mutations'
            ? {
                state: 'UNKNOWN',
                ownerGeneration: randomUUID(),
                mutationId: 'e'.repeat(64),
                rootId: f.root.rootId,
              }
            : {
                state: 'UNKNOWN',
                ownerGeneration: randomUUID(),
                operationId: 'e'.repeat(64),
                intent: { rootId: f.root.rootId },
              };
        f.db
          .prepare(`INSERT INTO ${table}(id,record) VALUES(?,?)`)
          .run(
            'e'.repeat(64),
            JSON.stringify({ value: legacy, hash: copierHash(legacy) }),
          );
        expect(() =>
          f.transaction(f.peer, () => reserveRoot(f.peer, f.reservation)),
        ).toThrow('ROOT_RESERVATION_BUSY');
        expect(rootReservation(f.db, f.root.rootId)).toBeNull();
      } finally {
        f.close();
      }
    },
  );
  it('rolls back the projection and reservation release if terminal record persistence fails', () => {
    const f = fixture();
    try {
      const row = f.repairs.claim(
        {
          actionId: randomUUID(),
          rootId: f.root.rootId,
          expectedRootRevision: 0,
          operation: 'FLATTEN',
        },
        '02',
        f.reservation.ownerGeneration,
        101,
      ).record;
      const request = ownedMutationRequestSchema.parse({
        environment: 'OFFLINE_FIXTURE' as const,
        evidence: 'SYNTHETIC' as const,
        requestId: row.operationId,
        eventId: f.root.entryEventId,
        rootKey: f.root.rootKey,
        accountId: '02',
        entryRequestId: f.root.entryRequestId,
        symbol: 'NDX' as const,
        side: 'LONG' as const,
        sequence: 1,
        operation: 'CLOSE' as const,
        expectedRevision: 1,
        expectedQuantity: '1',
        expectedBasis: '30400',
        leverage: '10',
        maxNotional: '100000',
        maxPlannedLoss: '10000',
        operator: {
          operationId: row.operationId,
          expectedRootRevision: 0,
          action: 'FLATTEN' as const,
        },
      });
      f.repairs.transition(
        row.operationId,
        'QUEUED',
        'DISPATCHING',
        102,
        request,
      );
      const reservation = rootReservation(f.db, f.root.rootId);
      f.db.exec(
        "CREATE TRIGGER prevent_repair_write BEFORE UPDATE ON copier_owned_repairs BEGIN SELECT RAISE(ABORT,'TEST_WRITE_FAILURE'); END",
      );
      const identity = {
        environment: request.environment,
        evidence: request.evidence,
        requestId: request.requestId,
        eventId: request.eventId,
        rootKey: request.rootKey,
        accountId: request.accountId,
        entryRequestId: request.entryRequestId,
        symbol: request.symbol,
        side: request.side,
        sequence: request.sequence,
        operator: request.operator,
        operation: request.operation,
      };
      const facts = { quantity: '1', basis: '30400', revision: 1 };
      const receipt = {
        ...identity,
        requestHash: copierHash(request),
        status: 'REJECTED' as const,
        noFutureExecution: true,
        before: facts,
        after: facts,
        executedQuantity: '0',
        fees: '0',
        protection: [],
        stop: null,
        target: null,
        reason: 'SIMULATED_REJECTION' as const,
      };
      expect(() =>
        f.repairs.settle(
          row.operationId,
          'DISPATCHING',
          'REJECTED',
          103,
          receipt,
          0,
          {},
        ),
      ).toThrow('OWNED_REPAIR_STORAGE_FAILED');
      expect(f.store.root(f.root.rootId)).toEqual(f.root);
      expect(f.repairs.get(row.operationId)?.state).toBe('DISPATCHING');
      expect(rootReservation(f.peer, f.root.rootId)).toEqual(reservation);
      f.db.exec('DROP TRIGGER prevent_repair_write');
      f.repairs.settle(
        row.operationId,
        'DISPATCHING',
        'UNKNOWN',
        103,
        null,
        0,
        { certainty: 'UNKNOWN' },
      );
      const restarted = new CopierOwnedRepairs(f.peer);
      expect(restarted.get(row.operationId)?.state).toBe('UNKNOWN');
      const savedReservation = f.db
        .prepare('SELECT record FROM copier_root_reservations WHERE root_id=?')
        .get(f.root.rootId)!;
      f.db
        .prepare('DELETE FROM copier_root_reservations WHERE root_id=?')
        .run(f.root.rootId);
      expect(() => restarted.get(row.operationId)).toThrow(
        'OWNED_REPAIR_STORAGE_INVALID',
      );
      f.db
        .prepare('INSERT INTO copier_root_reservations VALUES(?,?)')
        .run(f.root.rootId, String(savedReservation.record));
      expect(rootReservation(f.peer, f.root.rootId)).toEqual(reservation);
      restarted.settle(
        row.operationId,
        'UNKNOWN',
        'REJECTED',
        104,
        receipt,
        1,
        { certainty: 'PRESENT' },
      );
      expect(rootReservation(f.db, f.root.rootId)).toBeNull();
    } finally {
      f.close();
    }
  });
  it('rejects corrupted reservation bytes across connections', () => {
    const f = fixture();
    try {
      f.transaction(f.db, () => reserveRoot(f.db, f.reservation));
      f.db.prepare('UPDATE copier_root_reservations SET record=?').run('{}');
      expect(() => rootReservation(f.peer, f.root.rootId)).toThrow(
        'ROOT_RESERVATION_STORAGE_INVALID',
      );
    } finally {
      f.close();
    }
  });
});
