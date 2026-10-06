import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { copierHash } from './copier-events.ts';
export const repairOperationSchema = z.enum([
  'RECONCILE',
  'ADD_STOP',
  'ADD_TARGET',
  'FLATTEN',
  'SKIP',
  'RETRY',
]);
export type RepairOperation = z.infer<typeof repairOperationSchema>;
const recordSchema = z
  .object({
    repairId: z.string().regex(/^[a-f0-9]{64}$/),
    attemptId: z.string().regex(/^[a-f0-9]{64}$/),
    operation: repairOperationSchema,
    payloadHash: z.string().regex(/^[a-f0-9]{64}$/),
    state: z.enum(['CLAIMED', 'DISPATCHING', 'VERIFIED', 'REFUSED', 'UNKNOWN']),
    createdAt: z.number().int().nonnegative(),
    updatedAt: z.number().int().nonnegative(),
    reason: z
      .string()
      .regex(/^[A-Z_]{1,80}$/)
      .nullable(),
  })
  .strict();
export type CopierRepairRecord = z.infer<typeof recordSchema>;
/** Additive durable repair claims. No credential or provider payload persistence. */
export class CopierRepairs {
  constructor(private readonly db: DatabaseSync) {
    try {
      db.exec(
        'CREATE TABLE IF NOT EXISTS copier_repairs(id TEXT PRIMARY KEY, record TEXT NOT NULL)',
      );
    } catch {
      throw new Error('REPAIR_STORAGE_FAILED');
    }
  }
  get(repairId: string): CopierRepairRecord | null {
    try {
      const row = this.db
        .prepare('SELECT record FROM copier_repairs WHERE id=?')
        .get(repairId);
      if (!row) return null;
      const record = recordSchema.parse(JSON.parse(String(row.record)));
      if (
        record.repairId !== repairId ||
        repairId !== copierHash([record.attemptId, record.operation])
      )
        throw new Error();
      return record;
    } catch {
      throw new Error('REPAIR_STORAGE_INVALID');
    }
  }
  claim(
    attemptId: string,
    operation: RepairOperation,
    payload: unknown,
    at: number,
  ) {
    const payloadHash = copierHash(payload),
      repairId = copierHash([attemptId, operation]);
    const record = recordSchema.parse({
      repairId,
      attemptId,
      operation,
      payloadHash,
      state: 'CLAIMED',
      createdAt: at,
      updatedAt: at,
      reason: null,
    });
    try {
      const inserted = this.db
        .prepare('INSERT OR IGNORE INTO copier_repairs(id,record) VALUES(?,?)')
        .run(repairId, JSON.stringify(record));
      const stored = this.get(repairId)!;
      if (stored.payloadHash !== payloadHash) throw new Error();
      return { fresh: inserted.changes === 1, record: stored };
    } catch {
      throw new Error('REPAIR_CLAIM_FAILED');
    }
  }
  update(
    repairId: string,
    expected: CopierRepairRecord['state'],
    next: CopierRepairRecord['state'],
    at: number,
    reason: string | null = null,
  ) {
    const previous = this.get(repairId);
    if (
      !previous ||
      previous.state !== expected ||
      !['CLAIMED', 'DISPATCHING'].includes(expected) ||
      at < previous.updatedAt ||
      (expected === 'DISPATCHING' && next === 'CLAIMED')
    )
      throw new Error('REPAIR_STATE_REFUSED');
    const parsed = recordSchema.safeParse({
      ...previous,
      state: next,
      updatedAt: at,
      reason,
    });
    if (!parsed.success) throw new Error('REPAIR_STATE_REFUSED');
    const record = parsed.data;
    let updated;
    try {
      updated = this.db
        .prepare('UPDATE copier_repairs SET record=? WHERE id=? AND record=?')
        .run(JSON.stringify(record), repairId, JSON.stringify(previous));
    } catch {
      throw new Error('REPAIR_STORAGE_FAILED');
    }
    if (updated.changes !== 1) throw new Error('REPAIR_STATE_CONFLICT');
    return record;
  }
}
