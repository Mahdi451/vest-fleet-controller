import {
  initializeRootReservations,
  reserveRoot,
  verifyRootReservation,
  releaseRoot,
  rootReservation,
  assertRootIdle,
} from './root-reservations.ts';
import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { D, nonnegative, positive, sideSchema } from '../../core/src/index.ts';
import { copierHash } from './copier-events.ts';
import {
  ownedMutationRequestSchema,
  ownedMutationReceiptSchema,
} from './owned-mutation-contract.ts';
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const id = z.string().regex(/^[A-Za-z0-9_:.-]{1,100}$/);
const time = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const operation = z.enum([
  'ADD',
  'REDUCE',
  'CLOSE',
  'STOP_CHANGED',
  'TARGET_CHANGED',
]);
export const ownedRootSchema = z
  .object({
    rootId: digest,
    rootKey: digest,
    entryEventId: digest,
    accountId: id,
    entryRequestId: id,
    symbol: z.literal('NDX'),
    side: sideSchema,
    initialFollowerQuantity: positive,
    initialLeaderQuantity: positive,
    quantity: nonnegative,
    basis: positive.nullable(),
    leverage: positive,
    providerRevision: time,
    revision: time,
    lastEconomicSequence: time,
    certainty: z.enum(['PRESENT', 'ABSENT', 'UNKNOWN']),
    closed: z.boolean(),
    stopPrice: positive.nullable(),
    targetPrice: positive.nullable(),
    stopId: id.nullable(),
    targetId: id.nullable(),
    updatedAt: time,
  })
  .strict()
  .refine(
    (root) =>
      new D(root.quantity).isZero() === (root.basis === null) &&
      (root.certainty !== 'ABSENT' || new D(root.quantity).isZero()) &&
      (!root.closed ||
        (root.certainty === 'ABSENT' && new D(root.quantity).isZero())),
    'ROOT_EXPOSURE_INVALID',
  );
export type OwnedRoot = z.infer<typeof ownedRootSchema>;
export const mutationPlanSchema = z
  .object({
    eventId: digest,
    rootId: digest,
    rootKey: digest,
    accountId: id,
    operation,
    sequence: time.refine((v) => v > 0),
    deltaQuantity: positive.nullable(),
    price: positive.nullable(),
    ownerGeneration: z.string().uuid(),
    createdAt: time,
  })
  .strict();
export type MutationPlan = z.infer<typeof mutationPlanSchema>;
export const mutationRecordSchema = mutationPlanSchema
  .extend({
    mutationId: digest,
    payloadHash: digest,
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
    ]),
    request: ownedMutationRequestSchema.nullable(),
    receipt: ownedMutationReceiptSchema.nullable(),
    reason: z
      .string()
      .regex(/^[A-Z_]{1,80}$/)
      .nullable(),
    updatedAt: time,
    submitAt: time.nullable(),
    verifiedAt: time.nullable(),
    detectedAt: time,
    detectionGeneration: z.string().uuid(),
    verifiedGeneration: z.string().uuid().nullable(),
    reservationRequired: z.literal(true).optional(),
    reservedRootRevision: time.optional(),
  })
  .strict();
export type MutationRecord = z.infer<typeof mutationRecordSchema>;
const activationSchema = z
  .object({
    eventId: digest,
    rootKey: digest,
    followerAccountIds: z.array(id).min(1).max(9),
    ownerGeneration: z.string().uuid(),
    activatedAt: time,
  })
  .strict();
export type MutationActivation = z.infer<typeof activationSchema>;
export const ownedRootId = (rootKey: string, accountId: string) =>
  copierHash(['OWNED_ROOT_V1', rootKey, accountId]);
export const mutationId = (eventId: string, accountId: string) =>
  copierHash(['OWNED_MUTATION_V1', eventId, accountId]);
/** Separate remaining-exposure projection; immutable entry fills are never resized. */
export class CopierMutations {
  constructor(private db: DatabaseSync) {
    try {
      initializeRootReservations(db);
      db.exec(
        'CREATE TABLE IF NOT EXISTS copier_owned_roots(id TEXT PRIMARY KEY, record TEXT NOT NULL); CREATE TABLE IF NOT EXISTS copier_mutations(id TEXT PRIMARY KEY, record TEXT NOT NULL); CREATE TABLE IF NOT EXISTS copier_mutation_activations(id TEXT PRIMARY KEY, record TEXT NOT NULL)',
      );
    } catch {
      throw new Error('MUTATION_STORAGE_FAILED');
    }
  }
  activation(eventId: string): MutationActivation | null {
    try {
      const row = this.db
        .prepare('SELECT record FROM copier_mutation_activations WHERE id=?')
        .get(eventId);
      if (!row) return null;
      const value = this.decode(activationSchema, row.record);
      if (
        value.eventId !== eventId ||
        new Set(value.followerAccountIds).size !==
          value.followerAccountIds.length
      )
        throw new Error();
      return value;
    } catch {
      throw new Error('MUTATION_STORAGE_INVALID');
    }
  }
  activations() {
    try {
      return this.db
        .prepare('SELECT id FROM copier_mutation_activations ORDER BY rowid')
        .all()
        .map((row) => this.activation(String(row.id))!);
    } catch {
      throw new Error('MUTATION_STORAGE_INVALID');
    }
  }
  activate(input: MutationActivation) {
    const activation = activationSchema.parse(input);
    if (
      new Set(activation.followerAccountIds).size !==
      activation.followerAccountIds.length
    )
      throw new Error('MUTATION_PLAN_INVALID');
    return this.transaction(() => {
      const old = this.activation(activation.eventId);
      if (old) {
        if (
          old.rootKey !== activation.rootKey ||
          copierHash([...old.followerAccountIds].sort()) !==
            copierHash([...activation.followerAccountIds].sort())
        )
          throw new Error('MUTATION_IDENTITY_CONFLICT');
        return { fresh: false, activation: old };
      }
      this.db
        .prepare('INSERT INTO copier_mutation_activations VALUES(?,?)')
        .run(activation.eventId, this.encoded(activation));
      return { fresh: true, activation };
    });
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
        /* failure remains closed */
      }
      if (
        error instanceof Error &&
        /^(MUTATION|ROOT_RESERVATION)_[A-Z_]+$/.test(error.message)
      )
        throw error;
      throw new Error('MUTATION_STORAGE_FAILED');
    }
  }
  private decode<T>(schema: z.ZodType<T>, raw: unknown): T {
    try {
      const envelope = JSON.parse(String(raw));
      const value = schema.parse(envelope.value);
      if (copierHash(value) !== envelope.hash) throw new Error();
      return value;
    } catch {
      throw new Error('MUTATION_STORAGE_INVALID');
    }
  }
  private encoded(value: unknown) {
    return JSON.stringify({ value, hash: copierHash(value) });
  }
  root(rootId: string): OwnedRoot | null {
    try {
      const row = this.db
        .prepare('SELECT record FROM copier_owned_roots WHERE id=?')
        .get(rootId);
      if (!row) return null;
      const root = this.decode(ownedRootSchema, row.record);
      if (
        root.rootId !== rootId ||
        rootId !== ownedRootId(root.rootKey, root.accountId)
      )
        throw new Error();
      return root;
    } catch {
      throw new Error('MUTATION_STORAGE_INVALID');
    }
  }
  roots(): OwnedRoot[] {
    try {
      return this.db
        .prepare('SELECT id FROM copier_owned_roots ORDER BY id')
        .all()
        .map((row) => this.root(String(row.id))!);
    } catch {
      throw new Error('MUTATION_STORAGE_INVALID');
    }
  }
  createRoot(input: OwnedRoot) {
    const root = ownedRootSchema.parse(input);
    if (root.rootId !== ownedRootId(root.rootKey, root.accountId))
      throw new Error('MUTATION_ROOT_REFUSED');
    return this.transaction(() => {
      const old = this.root(root.rootId);
      if (old) {
        for (const field of [
          'rootKey',
          'entryEventId',
          'accountId',
          'entryRequestId',
          'symbol',
          'side',
          'initialFollowerQuantity',
          'initialLeaderQuantity',
        ] as const)
          if (old[field] !== root[field])
            throw new Error('MUTATION_IDENTITY_CONFLICT');
        return old;
      }
      this.db
        .prepare('INSERT INTO copier_owned_roots VALUES(?,?)')
        .run(root.rootId, this.encoded(root));
      return root;
    });
  }
  updateRoot(
    rootId: string,
    expectedRevision: number,
    changes: Partial<OwnedRoot>,
  ) {
    return this.transaction(() =>
      this.writeRoot(rootId, expectedRevision, changes),
    );
  }
  reconcileIdleRoot(
    rootId: string,
    expectedRevision: number,
    changes: Partial<OwnedRoot> | null,
  ) {
    return this.transaction(() => {
      assertRootIdle(this.db, rootId);
      const current = this.root(rootId);
      if (!current || current.revision !== expectedRevision)
        throw new Error('MUTATION_REVISION_CONFLICT');
      return changes
        ? this.writeRoot(rootId, expectedRevision, changes)
        : current;
    });
  }
  private writeRoot(
    rootId: string,
    expectedRevision: number,
    changes: Partial<OwnedRoot>,
  ) {
    const old = this.root(rootId);
    if (!old || old.revision !== expectedRevision)
      throw new Error('MUTATION_REVISION_CONFLICT');
    const root = ownedRootSchema.parse({
      ...old,
      ...changes,
      revision: old.revision + 1,
    });
    if (
      root.rootId !== old.rootId ||
      root.rootKey !== old.rootKey ||
      root.accountId !== old.accountId ||
      root.entryRequestId !== old.entryRequestId ||
      root.entryEventId !== old.entryEventId ||
      root.symbol !== old.symbol ||
      root.side !== old.side ||
      root.initialFollowerQuantity !== old.initialFollowerQuantity ||
      root.initialLeaderQuantity !== old.initialLeaderQuantity ||
      (old.closed && !root.closed) ||
      root.updatedAt < old.updatedAt ||
      root.providerRevision < old.providerRevision
    )
      throw new Error('MUTATION_ROOT_REFUSED');
    this.db
      .prepare('UPDATE copier_owned_roots SET record=? WHERE id=?')
      .run(this.encoded(root), rootId);
    return root;
  }
  get(key: string): MutationRecord | null {
    try {
      const row = this.db
        .prepare('SELECT record FROM copier_mutations WHERE id=?')
        .get(key);
      if (!row) return null;
      const record = this.decode(mutationRecordSchema, row.record);
      return this.checkRecord(record, key);
    } catch {
      throw new Error('MUTATION_STORAGE_INVALID');
    }
  }
  private checkRecord(record: MutationRecord, key: string) {
    const {
      mutationId: keyIn,
      payloadHash,
      state,
      request,
      receipt,
      submitAt,
      verifiedAt,
      verifiedGeneration,
    } = record;
    const plan = mutationPlanSchema.strip().parse(record);
    if (
      keyIn !== key ||
      key !== mutationId(record.eventId, record.accountId) ||
      payloadHash !== copierHash(plan) ||
      (state === 'DISPATCHING' && !request) ||
      (verifiedAt !== null && verifiedAt < (submitAt ?? record.createdAt)) ||
      (submitAt !== null && submitAt < record.createdAt) ||
      record.updatedAt < record.createdAt ||
      (request &&
        (request.requestId !== key ||
          request.eventId !== record.eventId ||
          request.rootKey !== record.rootKey ||
          request.accountId !== record.accountId ||
          request.operation !== record.operation ||
          request.sequence !== record.sequence)) ||
      (receipt &&
        (!request ||
          receipt.requestId !== key ||
          receipt.requestHash !== copierHash(request) ||
          receipt.eventId !== record.eventId ||
          receipt.accountId !== record.accountId ||
          receipt.operation !== record.operation)) ||
      (['DISPATCHING', 'UNKNOWN', 'VERIFIED', 'PARTIAL', 'REJECTED'].includes(
        state,
      ) &&
        (!request || submitAt === null)) ||
      (['VERIFIED', 'PARTIAL'].includes(state) &&
        (!receipt ||
          receipt.status !== state ||
          verifiedAt === null ||
          verifiedGeneration === null)) ||
      (state === 'REJECTED' && receipt?.status !== 'REJECTED')
    )
      throw new Error();
    if (
      record.reservationRequired &&
      ['DISPATCHING', 'UNKNOWN'].includes(state)
    )
      verifyRootReservation(this.db, {
        rootId: record.rootId,
        commandId: record.mutationId,
        kind: 'LEADER_EVENT',
        ownerGeneration: record.ownerGeneration,
        rootRevision: record.reservedRootRevision!,
      });
    return record;
  }
  reservation(rootId: string) {
    return rootReservation(this.db, rootId);
  }
  records(rootId?: string): MutationRecord[] {
    try {
      return this.db
        .prepare('SELECT id FROM copier_mutations ORDER BY rowid')
        .all()
        .map((row) => this.get(String(row.id))!)
        .filter((row) => rootId === undefined || row.rootId === rootId);
    } catch {
      throw new Error('MUTATION_STORAGE_INVALID');
    }
  }
  claim(input: MutationPlan, detectedAt: number, detectionGeneration: string) {
    const plan = mutationPlanSchema.parse(input),
      key = mutationId(plan.eventId, plan.accountId);
    if (
      plan.rootId !== ownedRootId(plan.rootKey, plan.accountId) ||
      (['ADD', 'REDUCE'].includes(plan.operation)
        ? plan.price !== null
        : plan.deltaQuantity !== null ||
          (plan.operation === 'CLOSE'
            ? plan.price !== null
            : plan.price === null))
    )
      throw new Error('MUTATION_PLAN_INVALID');
    return this.transaction(() => {
      const old = this.get(key);
      if (old) {
        // Invocation generation/time may change on replay; economics may not.
        const stable = (row: MutationPlan) => ({
          ...row,
          ownerGeneration: '',
          createdAt: 0,
        });
        if (
          copierHash(stable(mutationPlanSchema.strip().parse(old))) !==
          copierHash(stable(plan))
        )
          throw new Error('MUTATION_IDENTITY_CONFLICT');
        return { fresh: false, record: old };
      }
      const record = mutationRecordSchema.parse({
        ...plan,
        mutationId: key,
        payloadHash: copierHash(plan),
        state: 'QUEUED',
        request: null,
        receipt: null,
        reason: null,
        updatedAt: plan.createdAt,
        submitAt: null,
        verifiedAt: null,
        detectedAt,
        detectionGeneration,
        verifiedGeneration: null,
      });
      if (['STOP_CHANGED', 'TARGET_CHANGED'].includes(plan.operation))
        for (const prior of this.records(plan.rootId)) {
          if (
            prior.operation === plan.operation &&
            prior.sequence < plan.sequence &&
            prior.state === 'QUEUED'
          )
            this.writeRecord({
              ...prior,
              state: 'SUPERSEDED',
              reason: 'NEWER_PROTECTION_INTENT',
              updatedAt: plan.createdAt,
            });
        }
      this.checkRecord(record, key);
      this.db
        .prepare('INSERT INTO copier_mutations VALUES(?,?)')
        .run(key, this.encoded(record));
      return { fresh: true, record };
    });
  }
  private assertTransition(
    old: MutationRecord,
    next: MutationRecord['state'],
    at: number,
  ) {
    const allowed: Record<MutationRecord['state'], MutationRecord['state'][]> =
      {
        QUEUED: ['DISPATCHING', 'SUPERSEDED', 'NOT_SENT', 'SKIPPED'],
        DISPATCHING: ['VERIFIED', 'PARTIAL', 'REJECTED', 'UNKNOWN'],
        UNKNOWN: ['UNKNOWN', 'VERIFIED', 'PARTIAL', 'REJECTED'],
        VERIFIED: [],
        PARTIAL: [],
        REJECTED: [],
        SUPERSEDED: [],
        NOT_SENT: [],
        SKIPPED: [],
      };
    if (at < old.updatedAt || !allowed[old.state].includes(next))
      throw new Error('MUTATION_STATE_CONFLICT');
  }
  private writeRecord(record: MutationRecord) {
    const parsed = this.checkRecord(
      mutationRecordSchema.parse(record),
      record.mutationId,
    );
    this.db
      .prepare('UPDATE copier_mutations SET record=? WHERE id=?')
      .run(this.encoded(parsed), parsed.mutationId);
    return parsed;
  }
  transition(
    key: string,
    expected: MutationRecord['state'],
    next: MutationRecord['state'],
    at: number,
    options: Partial<
      Pick<
        MutationRecord,
        | 'request'
        | 'receipt'
        | 'reason'
        | 'submitAt'
        | 'verifiedAt'
        | 'reservedRootRevision'
      >
    > = {},
  ) {
    return this.transaction(() => {
      const old = this.get(key);
      if (!old || old.state !== expected || at < old.updatedAt)
        throw new Error('MUTATION_STATE_CONFLICT');
      this.assertTransition(old, next, at);
      if (next === 'DISPATCHING') {
        if (options.reservedRootRevision === undefined)
          throw new Error('MUTATION_PLAN_INVALID');
        reserveRoot(this.db, {
          rootId: old.rootId,
          commandId: old.mutationId,
          kind: 'LEADER_EVENT',
          ownerGeneration: old.ownerGeneration,
          rootRevision: options.reservedRootRevision,
          at,
        });
      }
      return this.writeRecord({
        ...old,
        ...options,
        ...(next === 'DISPATCHING'
          ? { reservationRequired: true as const }
          : {}),
        state: next,
        updatedAt: at,
      });
    });
  }
  settle(
    key: string,
    expected: MutationRecord['state'],
    next: MutationRecord['state'],
    at: number,
    receipt: MutationRecord['receipt'],
    changes: Partial<OwnedRoot>,
    reason: string | null = null,
    verifiedGeneration: string | null = null,
  ) {
    return this.transaction(() => {
      const old = this.get(key);
      if (!old || old.state !== expected)
        throw new Error('MUTATION_STATE_CONFLICT');
      this.assertTransition(old, next, at);
      const root = this.root(old.rootId);
      if (!root) throw new Error('MUTATION_STORAGE_INVALID');
      this.writeRoot(root.rootId, root.revision, { ...changes, updatedAt: at });
      if (old.reservationRequired && next !== 'UNKNOWN')
        releaseRoot(this.db, {
          rootId: old.rootId,
          commandId: old.mutationId,
          kind: 'LEADER_EVENT',
          ownerGeneration: old.ownerGeneration,
          rootRevision: old.reservedRootRevision!,
        });
      return this.writeRecord({
        ...old,
        state: next,
        receipt,
        reason,
        updatedAt: at,
        verifiedAt: next === 'VERIFIED' || next === 'PARTIAL' ? at : null,
        verifiedGeneration,
      });
    });
  }
}
