import { createHash } from 'node:crypto';
import { z } from 'zod';
import { D, nonnegative, positive, sideSchema } from '../../core/src/index.ts';

const id = z.string().regex(/^[A-Za-z0-9_:.\-]{1,100}$/);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const timestamp = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const amount = positive.transform((value) => new D(value).toFixed());
const zeroOrMore = nonnegative.transform((value) => new D(value).toFixed());
export const leaderStreamSchema = z
  .object({
    environment: z.literal('OFFLINE_FIXTURE'),
    evidence: z.literal('SYNTHETIC'),
    leaderAccountId: id,
    sourceId: id,
    symbol: z.literal('NDX'),
    baselineSequence: timestamp,
  })
  .strict();
export type LeaderStream = z.infer<typeof leaderStreamSchema>;
const economics = {
  side: sideSchema,
  quantity: amount,
  leverage: amount,
};
const leaderBase = {
  environment: z.literal('OFFLINE_FIXTURE'),
  evidence: z.literal('SYNTHETIC'),
  origin: z.literal('ACCEPTED_EVENT'),
  leaderAccountId: id,
  sourceId: id,
  providerEventId: id,
  entryRootId: id,
  symbol: z.literal('NDX'),
  sequence: timestamp.refine((value) => value > 0),
  occurredAt: timestamp,
  ...economics,
};
export const leaderEventSchema = z
  .discriminatedUnion('kind', [
    z.object({ ...leaderBase, kind: z.literal('ENTRY') }).strict(),
    z.object({ ...leaderBase, kind: z.literal('ADD') }).strict(),
    z.object({ ...leaderBase, kind: z.literal('REDUCE') }).strict(),
    z.object({ ...leaderBase, kind: z.literal('CLOSE') }).strict(),
    z
      .object({ ...leaderBase, kind: z.literal('STOP_CHANGED'), price: amount })
      .strict(),
    z
      .object({
        ...leaderBase,
        kind: z.literal('TARGET_CHANGED'),
        price: amount,
      })
      .strict(),
  ])
  .refine(
    (event) =>
      event.kind !== 'ENTRY' || event.entryRootId === event.providerEventId,
  );
export type LeaderEvent = z.infer<typeof leaderEventSchema>;
export const eventObservationSchema = z
  .object({ generation: z.string().uuid(), detectedAt: timestamp })
  .strict();
export type EventObservation = z.infer<typeof eventObservationSchema>;
export const followerPlanSchema = z
  .object({
    eventId: digest,
    followerAccountId: id,
    quantity: amount,
    leverage: amount,
  })
  .strict();
export type FollowerPlan = z.infer<typeof followerPlanSchema>;
export const dispositionSchema = z
  .object({
    eventId: digest,
    followerAccountId: id,
    reason: z.enum([
      'STOP_OUT',
      'MANUAL_CLOSE',
      'LIQUIDATED',
      'BREACHED',
      'OPERATOR_FLATTEN',
      'SKIPPED',
    ]),
    observedAt: timestamp,
  })
  .strict();
export type FollowerDisposition = z.infer<typeof dispositionSchema>;
const exitState = z.enum([
  'MISSING',
  'PENDING',
  'VERIFIED',
  'FAILED',
  'UNKNOWN',
  'NOT_REQUIRED',
]);
export const followerOutcomeSchema = z
  .object({
    submission: z.enum([
      'NOT_SENT',
      'SUBMITTING',
      'ACCEPTED',
      'REJECTED',
      'UNKNOWN',
    ]),
    fill: z.enum(['NONE', 'PENDING', 'PARTIAL', 'FILLED']),
    filledQuantity: zeroOrMore,
    fillPrice: amount.nullable(),
    stop: exitState,
    target: exitState,
    exposure: z.enum(['PRESENT', 'ABSENT', 'UNKNOWN']),
    reason: z.enum([
      'NONE',
      'ENTRY_REJECTED',
      'DISPATCH_REFUSED',
      'ACKNOWLEDGEMENT_LOST',
      'PROVIDER_UNCERTAIN',
      'SL_MISSING',
      'TP_MISSING',
      'ACCOUNT_UNAVAILABLE',
      'EXIT_VERIFIED',
    ]),
  })
  .strict()
  .superRefine((outcome, ctx) => {
    const filled = new D(outcome.filledQuantity).gt(0);
    if (
      filled !== ['PARTIAL', 'FILLED'].includes(outcome.fill) ||
      filled !== (outcome.fillPrice !== null) ||
      (['NOT_SENT', 'REJECTED'].includes(outcome.submission) && filled) ||
      (outcome.exposure === 'ABSENT' &&
        (outcome.stop === 'VERIFIED' || outcome.target === 'VERIFIED'))
    )
      ctx.addIssue({
        code: 'custom',
        message: 'INCONSISTENT_FOLLOWER_OUTCOME',
      });
  });
export type FollowerOutcome = z.infer<typeof followerOutcomeSchema>;
export const terminalProofSchema = z
  .object({
    evidence: z.literal('SYNTHETIC'),
    attemptId: digest,
    payloadHash: digest,
    accountId: id,
    result: z.enum(['NOT_SENT', 'REJECTED', 'FILLED', 'EXITED']),
    providerOrderId: id.nullable(),
    noFutureExecution: z.literal(true),
    remainingQuantity: zeroOrMore.refine((value) => value === '0'),
    observedAt: timestamp,
  })
  .strict()
  .refine((proof) =>
    proof.result === 'NOT_SENT'
      ? proof.providerOrderId === null
      : proof.providerOrderId !== null,
  );
export type TerminalProof = z.infer<typeof terminalProofSchema>;
export const attemptObservationSchema = z
  .object({
    observationId: id,
    observedAt: timestamp,
    outcome: followerOutcomeSchema,
    terminal: terminalProofSchema.nullable(),
  })
  .strict();
export type AttemptObservation = z.infer<typeof attemptObservationSchema>;
export const followerCommandSchema = z
  .object({
    commandId: digest,
    eventId: digest,
    rootKey: digest,
    followerAccountId: id,
    symbol: z.literal('NDX'),
    side: sideSchema,
    operation: z.enum([
      'ENTRY',
      'ADD',
      'REDUCE',
      'CLOSE',
      'STOP_CHANGED',
      'TARGET_CHANGED',
    ]),
    quantity: amount,
    leverage: amount,
    price: amount.nullable(),
    payloadHash: digest,
  })
  .strict();
export type FollowerCommand = z.infer<typeof followerCommandSchema>;
export const followerAttemptSchema = z
  .object({
    attemptId: digest,
    commandId: digest,
    number: z.number().int().positive(),
    previousAttemptId: digest.nullable(),
    ownerGeneration: z.string().uuid(),
    claimedAt: timestamp,
    dispatchStartedAt: timestamp.nullable(),
    revision: timestamp,
    outcome: followerOutcomeSchema,
    terminal: terminalProofSchema.nullable(),
  })
  .strict();
export type FollowerAttempt = z.infer<typeof followerAttemptSchema>;
export const globalFailureSchema = z.enum([
  'EVENT_IDENTITY_CORRUPT',
  'JOURNAL_INTEGRITY_LOST',
  'AUTHENTICATION_LOST',
  'LEADER_IDENTITY_UNCERTAIN',
  'ACCOUNT_MAPPING_CORRUPT',
  'CHANNEL_INTEGRITY_LOST',
  'UNSAFE_FLEET_EXPOSURE',
]);
export type CopierGlobalFailure = z.infer<typeof globalFailureSchema>;

export function copierHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
export const leaderEventId = (event: LeaderEvent) =>
  copierHash([
    'LEADER_EVENT_V1',
    event.leaderAccountId,
    event.sourceId,
    event.providerEventId,
  ]);
export const leaderStreamId = (
  stream: Pick<LeaderStream, 'leaderAccountId' | 'sourceId' | 'symbol'>,
) =>
  copierHash([
    'LEADER_STREAM_V1',
    stream.leaderAccountId,
    stream.sourceId,
    stream.symbol,
  ]);
export const leaderRootKey = (event: LeaderEvent) =>
  copierHash([
    'LEADER_ROOT_V1',
    event.leaderAccountId,
    event.sourceId,
    event.symbol,
    event.entryRootId,
  ]);
export const followerCommandId = (eventId: string, accountId: string) =>
  copierHash(['FOLLOWER_COMMAND_V1', eventId, accountId]);
export const followerAttemptId = (commandId: string, number: number) =>
  copierHash(['FOLLOWER_ATTEMPT_V1', commandId, number]);
