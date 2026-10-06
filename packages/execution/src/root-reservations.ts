import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { copierHash } from './copier-events.ts';
const digest = z.string().regex(/^[a-f0-9]{64}$/),
  time = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const reservationSchema = z
  .object({
    rootId: digest,
    commandId: digest,
    kind: z.enum(['LEADER_EVENT', 'OPERATOR_REPAIR']),
    ownerGeneration: z.string().uuid(),
    rootRevision: time,
    at: time,
  })
  .strict();
export type RootReservation = z.infer<typeof reservationSchema>;
export function initializeRootReservations(db: DatabaseSync) {
  try {
    db.exec(
      'CREATE TABLE IF NOT EXISTS copier_root_reservations(root_id TEXT PRIMARY KEY,record TEXT NOT NULL)',
    );
  } catch {
    throw new Error('ROOT_RESERVATION_STORAGE_FAILED');
  }
}
function decoded(raw: unknown) {
  const encoded = JSON.parse(String(raw));
  if (!encoded.value || encoded.hash !== copierHash(encoded.value))
    throw new Error();
  return encoded.value;
}
export function rootReservation(
  db: DatabaseSync,
  rootId: string,
): RootReservation | null {
  try {
    const row = db
      .prepare('SELECT record FROM copier_root_reservations WHERE root_id=?')
      .get(rootId);
    if (!row) return null;
    const value = reservationSchema.parse(decoded(row.record));
    if (value.rootId !== rootId) throw new Error();
    return value;
  } catch {
    throw new Error('ROOT_RESERVATION_STORAGE_INVALID');
  }
}
const pendingHeader = z
  .object({
    state: z.enum([
      'QUEUED',
      'DISPATCHING',
      'VERIFIED',
      'PARTIAL',
      'REJECTED',
      'UNKNOWN',
      'SUPERSEDED',
      'NOT_SENT',
      'SKIPPED',
      'REFUSED',
    ]),
    ownerGeneration: z.string().uuid(),
  })
  .passthrough();
function legacyPending(db: DatabaseSync, rootId: string, commandId: string) {
  for (const [table, idField] of [
    ['copier_mutations', 'mutationId'],
    ['copier_owned_repairs', 'operationId'],
  ] as const) {
    if (
      !db
        .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?")
        .get(table)
    )
      continue;
    const rows = db
      .prepare(
        table === 'copier_mutations'
          ? 'SELECT record FROM copier_mutations'
          : 'SELECT record FROM copier_owned_repairs',
      )
      .all();
    for (const row of rows) {
      const value = pendingHeader.parse(decoded(row.record));
      const id = digest.parse(value[idField]);
      const root =
        table === 'copier_mutations'
          ? digest.parse(value.rootId)
          : z.object({ rootId: digest }).passthrough().parse(value.intent)
              .rootId;
      if (
        root === rootId &&
        id !== commandId &&
        ['DISPATCHING', 'UNKNOWN'].includes(value.state)
      )
        return true;
    }
  }
  return false;
}
function transactionRequired(db: DatabaseSync) {
  if (!db.isTransaction)
    throw new Error('ROOT_RESERVATION_TRANSACTION_REQUIRED');
}
/** Read-only reconciliation may commit only while no command owns the root. */
export function assertRootIdle(db: DatabaseSync, rootId: string) {
  transactionRequired(db);
  try {
    if (rootReservation(db, rootId) || legacyPending(db, rootId, ''))
      throw new Error('ROOT_RESERVATION_BUSY');
  } catch (error) {
    if (
      error instanceof Error &&
      /^ROOT_RESERVATION_[A-Z_]+$/.test(error.message)
    )
      throw error;
    throw new Error('ROOT_RESERVATION_STORAGE_INVALID');
  }
}
export function reserveRoot(db: DatabaseSync, input: RootReservation) {
  transactionRequired(db);
  try {
    const value = reservationSchema.parse(input),
      old = rootReservation(db, value.rootId);
    if (old) {
      if (copierHash(old) === copierHash(value)) return old;
      throw new Error(
        old.commandId === value.commandId
          ? 'ROOT_RESERVATION_IDENTITY_CONFLICT'
          : 'ROOT_RESERVATION_BUSY',
      );
    }
    const row = db
      .prepare('SELECT record FROM copier_owned_roots WHERE id=?')
      .get(value.rootId);
    if (!row) throw new Error();
    const root = z
      .object({
        rootId: digest,
        revision: time,
        certainty: z.enum(['PRESENT', 'ABSENT', 'UNKNOWN']),
        closed: z.boolean(),
      })
      .passthrough()
      .parse(decoded(row.record));
    if (root.rootId !== value.rootId) throw new Error();
    if (root.revision !== value.rootRevision)
      throw new Error('ROOT_RESERVATION_STALE_REVISION');
    if (
      root.certainty !== 'PRESENT' ||
      root.closed ||
      legacyPending(db, value.rootId, value.commandId)
    )
      throw new Error('ROOT_RESERVATION_BUSY');
    db.prepare('INSERT INTO copier_root_reservations VALUES(?,?)').run(
      value.rootId,
      JSON.stringify({ value, hash: copierHash(value) }),
    );
    return value;
  } catch (error) {
    if (
      error instanceof Error &&
      /^ROOT_RESERVATION_[A-Z_]+$/.test(error.message)
    )
      throw error;
    throw new Error('ROOT_RESERVATION_STORAGE_INVALID');
  }
}
export function verifyRootReservation(
  db: DatabaseSync,
  expected: Omit<RootReservation, 'at'>,
) {
  const old = rootReservation(db, expected.rootId);
  if (
    !old ||
    Object.entries(expected).some(
      ([key, value]) => old[key as keyof RootReservation] !== value,
    )
  )
    throw new Error('ROOT_RESERVATION_STORAGE_INVALID');
  return old;
}
export function releaseRoot(
  db: DatabaseSync,
  expected: Omit<RootReservation, 'at'>,
) {
  transactionRequired(db);
  verifyRootReservation(db, expected);
  const result = db
    .prepare('DELETE FROM copier_root_reservations WHERE root_id=?')
    .run(expected.rootId);
  if (result.changes !== 1) throw new Error('ROOT_RESERVATION_STORAGE_INVALID');
}
