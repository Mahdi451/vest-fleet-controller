import { z } from 'zod';
import {
  D,
  nonnegative,
  positive,
  protectionOrderSchema,
  sideSchema,
} from '../../core/src/index.ts';

const id = z.string().regex(/^[A-Za-z0-9_:.-]{1,100}$/);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const integer = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const identity = {
  environment: z.literal('OFFLINE_FIXTURE'),
  evidence: z.literal('SYNTHETIC'),
  requestId: hash,
  eventId: hash,
  rootKey: hash,
  accountId: id,
  entryRequestId: id,
  symbol: z.literal('NDX'),
  side: sideSchema,
  sequence: integer.refine((value) => value > 0),
};
const base = {
  ...identity,
  expectedRevision: integer,
  expectedQuantity: positive,
  expectedBasis: positive,
  leverage: positive,
  maxNotional: positive,
  maxPlannedLoss: positive,
};
export const ownedMutationRequestSchema = z.discriminatedUnion('operation', [
  z
    .object({ ...base, operation: z.literal('ADD'), deltaQuantity: positive })
    .strict(),
  z
    .object({
      ...base,
      operation: z.literal('REDUCE'),
      deltaQuantity: positive,
    })
    .strict(),
  z.object({ ...base, operation: z.literal('CLOSE') }).strict(),
  z
    .object({ ...base, operation: z.literal('STOP_CHANGED'), price: positive })
    .strict(),
  z
    .object({
      ...base,
      operation: z.literal('TARGET_CHANGED'),
      price: positive,
    })
    .strict(),
]);
export type OwnedMutationRequest = z.infer<typeof ownedMutationRequestSchema>;
const positionFacts = z
  .object({
    quantity: nonnegative,
    basis: positive.nullable(),
    revision: integer,
  })
  .strict();
const exitFacts = protectionOrderSchema.extend({
  error: z
    .string()
    .regex(/^[A-Z_]{1,80}$/)
    .nullable(),
});
export const ownedMutationReceiptSchema = z
  .object({
    ...identity,
    operation: z.enum([
      'ADD',
      'REDUCE',
      'CLOSE',
      'STOP_CHANGED',
      'TARGET_CHANGED',
    ]),
    requestHash: hash,
    status: z.enum(['VERIFIED', 'REJECTED', 'UNKNOWN', 'PARTIAL']),
    noFutureExecution: z.boolean(),
    before: positionFacts,
    after: positionFacts,
    executedQuantity: nonnegative,
    fees: nonnegative,
    protection: z.array(exitFacts),
    stop: exitFacts.nullable(),
    target: exitFacts.nullable(),
    reason: z.enum([
      'NONE',
      'OWNERSHIP_CHANGED',
      'ACCOUNT_UNAVAILABLE',
      'STALE_EVIDENCE',
      'RISK_LIMIT',
      'INVALID_QUANTITY',
      'PROTECTION_UNPROVEN',
      'INVALID_PROTECTION',
      'SIMULATED_REJECTION',
      'PROVIDER_UNCERTAIN',
      'PARTIAL_REDUCTION',
    ]),
  })
  .strict()
  .superRefine((receipt, ctx) => {
    if (
      (receipt.status === 'UNKNOWN' && receipt.noFutureExecution) ||
      (receipt.status !== 'UNKNOWN' && !receipt.noFutureExecution) ||
      new D(receipt.before.quantity).isZero() !==
        (receipt.before.basis === null) ||
      new D(receipt.after.quantity).isZero() !==
        (receipt.after.basis === null) ||
      (receipt.status === 'REJECTED' &&
        (!new D(receipt.executedQuantity).isZero() ||
          !new D(receipt.fees).isZero() ||
          !new D(receipt.before.quantity).eq(receipt.after.quantity) ||
          receipt.before.revision !== receipt.after.revision ||
          (receipt.before.basis === null
            ? receipt.after.basis !== null
            : receipt.after.basis === null ||
              !new D(receipt.before.basis).eq(receipt.after.basis)))) ||
      (receipt.status === 'PARTIAL' &&
        (receipt.operation !== 'REDUCE' ||
          !new D(receipt.executedQuantity).gt(0) ||
          !new D(receipt.before.quantity)
            .minus(receipt.after.quantity)
            .eq(receipt.executedQuantity) ||
          !new D(receipt.after.quantity).gt(0) ||
          receipt.after.revision <= receipt.before.revision))
    )
      ctx.addIssue({ code: 'custom', message: 'INVALID_MUTATION_RECEIPT' });
  });
export type OwnedMutationReceipt = z.infer<typeof ownedMutationReceiptSchema>;
export interface OwnedMutationCapabilities {
  addOwnedPosition(
    request: OwnedMutationRequest & { operation: 'ADD' },
  ): Promise<OwnedMutationReceipt>;
  reduceOwnedPosition(
    request: OwnedMutationRequest & { operation: 'REDUCE' },
  ): Promise<OwnedMutationReceipt>;
  closeOwnedPosition(
    request: OwnedMutationRequest & { operation: 'CLOSE' },
  ): Promise<OwnedMutationReceipt>;
  changeOwnedProtection(
    request: OwnedMutationRequest & {
      operation: 'STOP_CHANGED' | 'TARGET_CHANGED';
    },
  ): Promise<OwnedMutationReceipt>;
  readOwnedMutation(requestId: string): Promise<OwnedMutationReceipt | null>;
}
