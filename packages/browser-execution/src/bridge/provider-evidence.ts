import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  D,
  accountSchema,
  isFresh,
  nonnegative,
  positive,
  quoteSchema,
  rate,
  type Account,
  type Position,
  type ProtectionOrder,
  type ProtectionRequest,
} from '../../../core/src/index.ts';
import type {
  OrderRequest,
  OrderResult,
} from '../../../execution/src/adapter.ts';
import {
  leaderEventSchema,
  leaderStreamSchema,
} from '../../../execution/src/copier-events.ts';
import type { CopierRecords } from '../../../execution/src/copier-records.ts';

const id = z.string().regex(/^[A-Za-z0-9_:.\-]{1,100}$/);
const time = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const amount = nonnegative.transform((value) => new D(value).toFixed());
const scope = {
  environment: z.literal('OFFLINE_FIXTURE'),
  evidence: z.literal('SYNTHETIC'),
};
export const providerContextSchema = z
  .object({
    accountId: id,
    contextId: id,
    generation: z.string().uuid(),
    state: z.enum(['READY', 'STALE', 'DISCONNECTED', 'IDENTITY_UNCERTAIN']),
    identityVerifiedAt: time,
  })
  .strict();

/** Explicit fixture economics. No conversion from an unproven venue unit. */
export const providerMarketSchema = z
  .object({
    symbol: z.literal('NDX'),
    priceUnit: z.literal('INDEX_POINTS'),
    quantityUnit: z.literal('USD_PER_INDEX_POINT'),
    accountCurrency: z.literal('USD'),
    tickSize: positive,
    sizeStep: positive,
    minimumQuantity: positive,
    maximumQuantity: positive,
    maximumLeverage: positive,
    entryFeeRate: rate,
    exitFeeRate: rate,
    accountCost: nonnegative,
    slippagePointsPerSide: nonnegative,
    fundingRateAllowance: rate,
    drawdownModel: z.literal('FIXED'),
    protectionSemantics: z.literal('REDUCE_ONLY_FULL_POSITION'),
    capturedAt: time,
  })
  .strict()
  .refine((market) =>
    new D(market.minimumQuantity).lte(market.maximumQuantity),
  );

export const providerInventorySchema = z
  .object({
    ...scope,
    complete: z.literal(true),
    capturedAt: time,
    contexts: z.array(providerContextSchema).min(1).max(100),
    accounts: z.array(accountSchema).min(1).max(100),
    market: providerMarketSchema,
    quote: quoteSchema,
  })
  .strict();
export type ProviderInventory = z.infer<typeof providerInventorySchema>;
export type ProviderContext = z.infer<typeof providerContextSchema>;
export const providerBindingSchema = z
  .object({
    expectedAccountIds: z.array(id).min(1).max(100),
    contexts: z.array(providerContextSchema).min(1).max(100),
    maxAgeMs: z.number().int().positive().max(60000),
  })
  .strict();
export type ProviderBinding = z.infer<typeof providerBindingSchema>;

const refuse = (reason: string): never => {
  throw new Error(reason);
};
function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) return refuse('PROVIDER_EVIDENCE_INVALID');
  return result.data;
}
function fresh(timestamp: number, now: number, age: number) {
  if (!isFresh(timestamp, now, age)) refuse('PROVIDER_EVIDENCE_STALE');
}
function sameSet(actual: string[], expected: string[]) {
  if (
    new Set(actual).size !== actual.length ||
    actual.length !== expected.length ||
    actual.some((id) => !expected.includes(id))
  )
    refuse('PROVIDER_INVENTORY_UNPROVEN');
}
function checkedBinding(input: ProviderBinding): ProviderBinding {
  const binding = parse(providerBindingSchema, input);
  sameSet(
    binding.expectedAccountIds,
    binding.contexts.map((context) => context.accountId),
  );
  if (
    new Set(binding.contexts.map((context) => context.contextId)).size !==
    binding.contexts.length
  )
    refuse('PROVIDER_CONTEXT_UNPROVEN');
  return binding;
}
function checkedContext(
  context: ProviderContext,
  binding: ProviderBinding,
  now: number,
) {
  const expected = binding.contexts.find(
    (value) => value.accountId === context.accountId,
  );
  if (
    !expected ||
    context.state !== 'READY' ||
    expected.state !== 'READY' ||
    expected.contextId !== context.contextId ||
    expected.generation !== context.generation
  )
    refuse('PROVIDER_CONTEXT_UNPROVEN');
  fresh(context.identityVerifiedAt, now, binding.maxAgeMs);
}

export function normalizeProviderInventory(
  input: unknown,
  bindingInput: ProviderBinding,
  now: number,
): ProviderInventory {
  const binding = checkedBinding(bindingInput),
    inventory = parse(providerInventorySchema, input);
  sameSet(
    inventory.accounts.map((account) => account.accountId),
    binding.expectedAccountIds,
  );
  sameSet(
    inventory.contexts.map((context) => context.accountId),
    binding.expectedAccountIds,
  );
  if (
    new Set(inventory.contexts.map((context) => context.contextId)).size !==
    inventory.contexts.length
  )
    refuse('PROVIDER_CONTEXT_UNPROVEN');
  fresh(inventory.capturedAt, now, binding.maxAgeMs);
  fresh(inventory.market.capturedAt, now, binding.maxAgeMs);
  fresh(inventory.quote.timestamp, now, binding.maxAgeMs);
  inventory.contexts.forEach((context) =>
    checkedContext(context, binding, now),
  );
  inventory.accounts.forEach((account) =>
    fresh(account.lastSyncTimestamp, now, binding.maxAgeMs),
  );
  if (!new D(inventory.quote.price).mod(inventory.market.tickSize).isZero())
    refuse('PROVIDER_MARKET_UNPROVEN');
  for (const account of inventory.accounts) {
    if (new D(account.leverage).gt(inventory.market.maximumLeverage))
      refuse('PROVIDER_MARKET_UNPROVEN');
    for (const position of account.positions) {
      if (
        !new D(position.quantity).mod(inventory.market.sizeStep).isZero() ||
        new D(position.quantity).gt(inventory.market.maximumQuantity)
      )
        refuse('PROVIDER_MARKET_UNPROVEN');
    }
  }
  return inventory;
}

/** Remainder evidence must stay explicit; UNKNOWN never becomes terminal. */
export const providerEntryEvidenceSchema = z
  .object({
    ...scope,
    context: providerContextSchema,
    capturedAt: time,
    accountId: id,
    requestId: id,
    providerOrderId: id.nullable(),
    symbol: z.literal('NDX'),
    status: z.enum(['FILLED', 'PARTIALLY_FILLED', 'REJECTED', 'UNKNOWN']),
    requestedQuantity: positive,
    filledQuantity: amount,
    fillPrice: positive.nullable(),
    fees: nonnegative,
    remainder: z
      .object({
        state: z.enum(['OPEN', 'CANCELED', 'FILLED', 'UNKNOWN']),
        quantity: amount,
        noFutureExecution: z.boolean(),
      })
      .strict(),
    rejectionCode: z
      .string()
      .regex(/^[A-Z][A-Z0-9_]{0,79}$/)
      .nullable(),
  })
  .strict();
export type ProviderEntryEvidence = z.infer<typeof providerEntryEvidenceSchema>;
export const expectedEntrySchema = z
  .object({
    accountId: id,
    requestId: id,
    symbol: z.literal('NDX'),
    quantity: positive,
  })
  .strict();

export function normalizeProviderEntry(
  input: unknown,
  expectedInput: z.infer<typeof expectedEntrySchema>,
  bindingInput: ProviderBinding,
  now: number,
): { evidence: ProviderEntryEvidence; result: OrderResult } {
  const evidence = parse(providerEntryEvidenceSchema, input),
    expected = parse(expectedEntrySchema, expectedInput),
    binding = checkedBinding(bindingInput);
  checkedContext(evidence.context, binding, now);
  fresh(evidence.capturedAt, now, binding.maxAgeMs);
  const filled = new D(evidence.filledQuantity),
    total = new D(evidence.requestedQuantity),
    remainder = evidence.remainder;
  if (
    evidence.accountId !== expected.accountId ||
    evidence.context.accountId !== expected.accountId ||
    evidence.requestId !== expected.requestId ||
    evidence.symbol !== expected.symbol ||
    !total.eq(expected.quantity)
  )
    refuse('PROVIDER_ORDER_CORRELATION_FAILED');
  if (
    filled.gt(total) ||
    filled.gt(0) !== (evidence.fillPrice !== null) ||
    (filled.gt(0) && evidence.providerOrderId === null) ||
    (remainder.noFutureExecution &&
      (!['CANCELED', 'FILLED'].includes(remainder.state) ||
        remainder.quantity !== '0')) ||
    (!remainder.noFutureExecution &&
      ['CANCELED', 'FILLED'].includes(remainder.state))
  )
    refuse('PROVIDER_ORDER_FACTS_INCONSISTENT');
  if (
    (evidence.status === 'FILLED' &&
      (!filled.eq(total) ||
        !remainder.noFutureExecution ||
        remainder.state !== 'FILLED')) ||
    (evidence.status === 'PARTIALLY_FILLED' &&
      (!filled.gt(0) || !filled.lt(total))) ||
    (evidence.status === 'REJECTED' &&
      (filled.gt(0) ||
        !remainder.noFutureExecution ||
        remainder.state !== 'CANCELED')) ||
    (remainder.state === 'OPEN' &&
      !new D(remainder.quantity).eq(total.minus(filled)))
  )
    refuse('PROVIDER_ORDER_FACTS_INCONSISTENT');
  return {
    evidence,
    result: {
      accountId: evidence.accountId,
      requestId: evidence.requestId,
      status: evidence.status,
      filledSize: evidence.filledQuantity,
      entryPrice: evidence.fillPrice,
      fees: evidence.fees,
      remainderCanceled:
        remainder.noFutureExecution && remainder.state === 'CANCELED',
      error: evidence.rejectionCode,
    },
  };
}

const bootstrapSchema = z
  .object({
    ...scope,
    origin: z.literal('SNAPSHOT_BASELINE'),
    inventory: providerInventorySchema,
    stream: leaderStreamSchema,
  })
  .strict();
export const acceptedProviderEventSchema = z
  .object({
    ...scope,
    origin: z.literal('ACCEPTED_PROVIDER_EVENT'),
    context: providerContextSchema,
    capturedAt: time,
    event: leaderEventSchema,
  })
  .strict();

/** Snapshots establish the cursor only. Events exclusively enter via accept(). */
export class SyntheticProviderEventIntake {
  private stream: z.infer<typeof leaderStreamSchema> | null = null;
  private readonly binding: ProviderBinding;
  private readonly generation = randomUUID();
  constructor(
    private readonly records: CopierRecords,
    binding: ProviderBinding,
    private readonly now: () => number,
  ) {
    this.binding = checkedBinding(binding);
  }
  bootstrap(input: unknown): ProviderInventory {
    if (this.stream) return refuse('PROVIDER_BASELINE_ALREADY_SET');
    const boot = parse(bootstrapSchema, input),
      inventory = normalizeProviderInventory(
        boot.inventory,
        this.binding,
        this.now(),
      );
    if (!this.binding.expectedAccountIds.includes(boot.stream.leaderAccountId))
      refuse('PROVIDER_LEADER_UNPROVEN');
    this.records.registerLeaderStream(boot.stream);
    this.stream = boot.stream;
    return inventory;
  }
  accept(input: unknown) {
    if (!this.stream) return refuse('PROVIDER_BASELINE_REQUIRED');
    const frame = parse(acceptedProviderEventSchema, input),
      now = this.now();
    checkedContext(frame.context, this.binding, now);
    fresh(frame.capturedAt, now, this.binding.maxAgeMs);
    if (
      frame.context.accountId !== this.stream.leaderAccountId ||
      frame.event.leaderAccountId !== this.stream.leaderAccountId ||
      frame.event.sourceId !== this.stream.sourceId ||
      frame.event.symbol !== this.stream.symbol ||
      frame.event.occurredAt > frame.capturedAt
    )
      return refuse('PROVIDER_EVENT_CORRELATION_FAILED');
    return this.records.recordLeaderEvent(frame.event, {
      generation: this.generation,
      detectedAt: now,
    });
  }
}

/** Contract only: implementations cannot supply arbitrary routes or credentials. */
export interface ScopedProviderCapabilities {
  readonly environment: 'OFFLINE_FIXTURE';
  readAccounts(): Promise<Account[]>;
  readPositions(accountId: string): Promise<Position[]>;
  readOrders(accountId: string): Promise<ProtectionOrder[]>;
  submitEntry(order: OrderRequest): Promise<ProviderEntryEvidence>;
  submitStop(
    order: ProtectionRequest & { type: 'STOP_LOSS' },
  ): Promise<ProtectionOrder>;
  submitTarget(
    order: ProtectionRequest & { type: 'TAKE_PROFIT' },
  ): Promise<ProtectionOrder>;
  cancelOrder(accountId: string, orderId: string): Promise<void>;
  reducePosition(accountId: string, quantity: string): Promise<void>;
  flattenPosition(accountId: string): Promise<void>;
}

/** No connected implementation is available until reviewed venue evidence exists. */
export function createConnectedProvider(): never {
  return refuse('CONNECTED_PROVIDER_EVIDENCE_REQUIRED');
}
