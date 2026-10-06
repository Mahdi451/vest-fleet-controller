import {
  initializeRootReservations,
  reserveRoot,
  verifyRootReservation,
  releaseRoot,
} from './root-reservations.ts';
import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { positive } from '../../core/src/index.ts';
import { copierHash } from './copier-events.ts';
import { ownedRootSchema } from './copier-mutations.ts';
import {
  ownedMutationRequestSchema,
  ownedMutationReceiptSchema,
} from './owned-mutation-contract.ts';
const digest = z.string().regex(/^[a-f0-9]{64}$/),
  time = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const common = {
  actionId: z.string().uuid(),
  rootId: digest,
  expectedRootRevision: time,
};
export const ownedRepairIntentSchema = z.discriminatedUnion('operation', [
  z
    .object({ ...common, operation: z.literal('ADD_STOP'), price: positive })
    .strict(),
  z
    .object({ ...common, operation: z.literal('ADD_TARGET'), price: positive })
    .strict(),
  z.object({ ...common, operation: z.literal('FLATTEN') }).strict(),
]);
export type OwnedRepairIntent = z.infer<typeof ownedRepairIntentSchema>;
export function parseOwnedRepairIntent(input: unknown): OwnedRepairIntent {
  const parsed = ownedRepairIntentSchema.safeParse(input);
  if (!parsed.success) throw new Error('OWNED_REPAIR_INTENT_INVALID');
  return parsed.data;
}

export const ownedRepairId = (actionId: string) =>
  copierHash(['OWNED_OPERATOR_REPAIR_V1', actionId]);
const recordSchema = z
  .object({
    operationId: digest,
    intent: ownedRepairIntentSchema,
    payloadHash: digest,
    accountId: z.string().regex(/^[A-Za-z0-9_:.-]{1,100}$/),
    ownerGeneration: z.string().uuid(),
    state: z.enum([
      'QUEUED',
      'DISPATCHING',
      'VERIFIED',
      'REJECTED',
      'REFUSED',
      'UNKNOWN',
    ]),
    request: ownedMutationRequestSchema.nullable(),
    receipt: ownedMutationReceiptSchema.nullable(),
    reason: z
      .string()
      .regex(/^[A-Z_]{1,80}$/)
      .nullable(),
    createdAt: time,
    updatedAt: time,
    submitAt: time.nullable(),
    verifiedAt: time.nullable(),
    reservationRequired: z.literal(true).optional(),
  })
  .strict();
export type OwnedRepairRecord = z.infer<typeof recordSchema>;
const changesSchema = z
  .object({
    quantity: ownedRootSchema.shape.quantity,
    basis: ownedRootSchema.shape.basis,
    providerRevision: ownedRootSchema.shape.providerRevision,
    certainty: ownedRootSchema.shape.certainty,
    closed: ownedRootSchema.shape.closed,
    stopPrice: ownedRootSchema.shape.stopPrice,
    targetPrice: ownedRootSchema.shape.targetPrice,
    stopId: ownedRootSchema.shape.stopId,
    targetId: ownedRootSchema.shape.targetId,
  })
  .strict()
  .partial();
export type OwnedRepairRootChanges = z.infer<typeof changesSchema>;
/** Durable operator origin, separate from accepted leader events. */
export class CopierOwnedRepairs {
  constructor(private db: DatabaseSync) {
    try {
      initializeRootReservations(db);
      db.exec(
        'CREATE TABLE IF NOT EXISTS copier_owned_repairs(id TEXT PRIMARY KEY,record TEXT NOT NULL)',
      );
    } catch {
      throw new Error('OWNED_REPAIR_STORAGE_FAILED');
    }
  }
  private transaction<T>(run: () => T): T {
    try {
      this.db.exec('BEGIN IMMEDIATE');
      const result = run();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        /* remains closed */
      }
      if (
        error instanceof Error &&
        /^(OWNED_REPAIR|ROOT_RESERVATION)_[A-Z_]+$/.test(error.message)
      )
        throw error;
      throw new Error('OWNED_REPAIR_STORAGE_FAILED');
    }
  }
  private encode(value: unknown) {
    return JSON.stringify({ value, hash: copierHash(value) });
  }
  private decode<T>(schema: z.ZodType<T>, raw: unknown): T {
    const envelope = JSON.parse(String(raw));
    const value = schema.parse(envelope.value);
    if (copierHash(value) !== envelope.hash)
      throw new Error('OWNED_REPAIR_STORAGE_INVALID');
    return value;
  }
  private checked(input: OwnedRepairRecord) {
    const record = recordSchema.parse(input),
      request = record.request,
      receipt = record.receipt;
    if (
      record.operationId !== ownedRepairId(record.intent.actionId) ||
      record.payloadHash !== copierHash(record.intent) ||
      record.updatedAt < record.createdAt ||
      (['DISPATCHING', 'UNKNOWN', 'VERIFIED', 'REJECTED'].includes(
        record.state,
      ) &&
        (!request || record.submitAt === null)) ||
      (request &&
        (request.requestId !== record.operationId ||
          request.accountId !== record.accountId ||
          request.operator?.operationId !== record.operationId ||
          request.operator?.expectedRootRevision !==
            record.intent.expectedRootRevision ||
          request.operator?.action !== record.intent.operation)) ||
      (receipt &&
        (!request ||
          receipt.requestId !== record.operationId ||
          receipt.requestHash !== copierHash(request) ||
          copierHash(receipt.operator) !== copierHash(request.operator))) ||
      (record.state === 'VERIFIED' &&
        (!receipt ||
          receipt.status !== 'VERIFIED' ||
          record.verifiedAt === null)) ||
      (record.state === 'REJECTED' && receipt?.status !== 'REJECTED')
    )
      throw new Error('OWNED_REPAIR_STORAGE_INVALID');
    if (
      record.reservationRequired &&
      ['DISPATCHING', 'UNKNOWN'].includes(record.state)
    )
      verifyRootReservation(this.db, {
        rootId: record.intent.rootId,
        commandId: record.operationId,
        kind: 'OPERATOR_REPAIR',
        ownerGeneration: record.ownerGeneration,
        rootRevision: record.intent.expectedRootRevision,
      });
    return record;
  }
  get(operationId: string): OwnedRepairRecord | null {
    try {
      const row = this.db
        .prepare('SELECT record FROM copier_owned_repairs WHERE id=?')
        .get(operationId);
      if (!row) return null;
      const record = this.checked(this.decode(recordSchema, row.record));
      if (record.operationId !== operationId) throw new Error();
      return record;
    } catch {
      throw new Error('OWNED_REPAIR_STORAGE_INVALID');
    }
  }
  records(rootId?: string) {
    try {
      return this.db
        .prepare('SELECT id FROM copier_owned_repairs ORDER BY rowid')
        .all()
        .map((row) => this.get(String(row.id))!)
        .filter((row) => rootId === undefined || row.intent.rootId === rootId);
    } catch {
      throw new Error('OWNED_REPAIR_STORAGE_INVALID');
    }
  }
  replay(input: OwnedRepairIntent) {
    const intent = parseOwnedRepairIntent(input),
      old = this.get(ownedRepairId(intent.actionId));
    if (old && old.payloadHash !== copierHash(intent))
      throw new Error('OWNED_REPAIR_IDENTITY_CONFLICT');
    return old;
  }
  claim(
    input: OwnedRepairIntent,
    accountId: string,
    generation: string,
    at: number,
  ) {
    const intent = parseOwnedRepairIntent(input);
    return this.transaction(() => {
      const old = this.replay(intent);
      if (old) return { fresh: false, record: old };
      const record = this.checked({
        operationId: ownedRepairId(intent.actionId),
        intent,
        payloadHash: copierHash(intent),
        accountId,
        ownerGeneration: generation,
        state: 'QUEUED',
        request: null,
        receipt: null,
        reason: null,
        createdAt: at,
        updatedAt: at,
        submitAt: null,
        verifiedAt: null,
      });
      this.db
        .prepare('INSERT INTO copier_owned_repairs VALUES(?,?)')
        .run(record.operationId, this.encode(record));
      return { fresh: true, record };
    });
  }
  private write(record: OwnedRepairRecord) {
    const value = this.checked(record);
    this.db
      .prepare('UPDATE copier_owned_repairs SET record=? WHERE id=?')
      .run(this.encode(value), value.operationId);
    return value;
  }
  private transitionAllowed(
    old: OwnedRepairRecord,
    next: OwnedRepairRecord['state'],
    at: number,
  ) {
    const allowed: Record<
      OwnedRepairRecord['state'],
      OwnedRepairRecord['state'][]
    > = {
      QUEUED: ['DISPATCHING', 'REFUSED'],
      DISPATCHING: ['VERIFIED', 'REJECTED', 'UNKNOWN'],
      UNKNOWN: ['VERIFIED', 'REJECTED', 'UNKNOWN'],
      VERIFIED: [],
      REJECTED: [],
      REFUSED: [],
    };
    if (at < old.updatedAt || !allowed[old.state].includes(next))
      throw new Error('OWNED_REPAIR_STATE_CONFLICT');
  }
  transition(
    operationId: string,
    expected: OwnedRepairRecord['state'],
    next: OwnedRepairRecord['state'],
    at: number,
    request: OwnedRepairRecord['request'] = null,
    reason: string | null = null,
  ) {
    return this.transaction(() => {
      const old = this.get(operationId);
      if (!old || old.state !== expected)
        throw new Error('OWNED_REPAIR_STATE_CONFLICT');
      this.transitionAllowed(old, next, at);
      if (next === 'DISPATCHING')
        reserveRoot(this.db, {
          rootId: old.intent.rootId,
          commandId: old.operationId,
          kind: 'OPERATOR_REPAIR',
          ownerGeneration: old.ownerGeneration,
          rootRevision: old.intent.expectedRootRevision,
          at,
        });
      return this.write({
        ...old,
        state: next,
        ...(next === 'DISPATCHING'
          ? { reservationRequired: true as const }
          : {}),
        request: request ?? old.request,
        reason,
        updatedAt: at,
        submitAt: next === 'DISPATCHING' ? at : old.submitAt,
      });
    });
  }
  settle(
    operationId: string,
    expected: OwnedRepairRecord['state'],
    next: OwnedRepairRecord['state'],
    at: number,
    receipt: OwnedRepairRecord['receipt'],
    rootRevision: number,
    changes: OwnedRepairRootChanges,
    reason: string | null = null,
  ) {
    return this.transaction(() => {
      const old = this.get(operationId);
      if (!old || old.state !== expected)
        throw new Error('OWNED_REPAIR_STATE_CONFLICT');
      this.transitionAllowed(old, next, at);
      const row = this.db
        .prepare('SELECT record FROM copier_owned_roots WHERE id=?')
        .get(old.intent.rootId);
      if (!row) throw new Error('OWNED_REPAIR_STORAGE_INVALID');
      const root = this.decode(ownedRootSchema, row.record);
      if (
        root.rootId !== old.intent.rootId ||
        root.revision !== rootRevision ||
        root.accountId !== old.accountId ||
        at < root.updatedAt
      )
        throw new Error('OWNED_REPAIR_REVISION_CONFLICT');
      const updated = ownedRootSchema.parse({
        ...root,
        ...changesSchema.parse(changes),
        revision: root.revision + 1,
        updatedAt: at,
      });
      if (
        (root.closed && !updated.closed) ||
        updated.providerRevision < root.providerRevision
      )
        throw new Error('OWNED_REPAIR_REVISION_CONFLICT');
      this.db
        .prepare('UPDATE copier_owned_roots SET record=? WHERE id=?')
        .run(this.encode(updated), updated.rootId);
      if (old.reservationRequired && next !== 'UNKNOWN')
        releaseRoot(this.db, {
          rootId: old.intent.rootId,
          commandId: old.operationId,
          kind: 'OPERATOR_REPAIR',
          ownerGeneration: old.ownerGeneration,
          rootRevision: old.intent.expectedRootRevision,
        });
      return this.write({
        ...old,
        state: next,
        receipt,
        reason,
        updatedAt: at,
        verifiedAt: next === 'VERIFIED' ? at : null,
      });
    });
  }
}
