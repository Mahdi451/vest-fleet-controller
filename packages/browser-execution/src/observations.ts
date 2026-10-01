import { z } from 'zod';
import {
  D,
  decimal,
  isFresh,
  positive,
  sideSchema,
} from '../../core/src/index.ts';

// These are visible observations, never executable Account/OrderResult defaults.
// `side` describes the linked position's direction, including on exit/protection
// records. It is not an inferred BUY/SELL action; that mapping must be inspected.
const text = z.string().min(1);
const timestamp = z.number().int().nonnegative();
export const visibleAccountRefSchema = z
  .object({
    visibleId: text.nullable(),
    label: text.nullable(),
    product: text.nullable(),
  })
  .strict();
export type VisibleAccountRef = z.infer<typeof visibleAccountRefSchema>;
const amount = z
  .object({
    value: decimal.nullable(),
    precision: z.enum(['EXACT', 'ROUNDED', 'UNKNOWN']),
  })
  .strict();
const collection = <T extends z.ZodType>(row: T) =>
  z.object({ complete: z.boolean(), rows: z.array(row).nullable() }).strict();

export const visibleFillSchema = z
  .object({
    role: z.enum(['ENTRY', 'EXIT', 'UNKNOWN']),
    venuePositionId: text.nullable(),
    venueOrderId: text.nullable(),
    clientRequestId: text.nullable(),
    accountVisibleId: text.nullable(),
    market: text.nullable(),
    side: sideSchema.nullable(),
    status: z.enum([
      'FILLED',
      'PARTIALLY_FILLED',
      'PENDING',
      'REJECTED',
      'UNKNOWN',
    ]),
    requestedSize: amount,
    filledSize: amount,
    remainingSize: amount,
    averagePrice: amount,
    fees: amount,
    remainderCanceled: z.boolean().nullable(),
    venueTimestamp: timestamp.nullable(),
  })
  .strict();
export type VisibleFill = z.infer<typeof visibleFillSchema>;
export const visibleProtectionSchema = z
  .object({
    venueOrderId: text.nullable(),
    entryVenueOrderId: text.nullable(),
    accountVisibleId: text.nullable(),
    market: text.nullable(),
    type: z.enum(['STOP_LOSS', 'TAKE_PROFIT']),
    side: sideSchema.nullable(),
    quantity: amount,
    triggerPrice: amount,
    triggerBasis: text.nullable(),
    reduceOnly: z.boolean().nullable(),
    status: z.enum(['ACTIVE', 'FILLED', 'REJECTED', 'CANCELED', 'UNKNOWN']),
    persistsWithoutBrowser: z.boolean().nullable(),
    siblingCancellation: z.enum(['PROVEN', 'ABSENT', 'UNKNOWN']),
    siblingGroupId: text.nullable(),
  })
  .strict();
export const visibleIdentitySchema = z
  .object({
    contextId: text,
    pageId: text,
    uiRevision: text,
    session: z.enum(['AUTHENTICATED', 'LOGIN_REQUIRED', 'UNKNOWN']),
    account: visibleAccountRefSchema,
  })
  .strict();
export const visibleInventorySchema = z
  .object({
    contextId: text,
    pageId: text,
    uiRevision: text,
    observedAt: timestamp,
    complete: z.boolean(),
    accounts: z.array(visibleAccountRefSchema),
  })
  .strict();
export const visibleObservationSchema = visibleIdentitySchema
  .extend({
    observedAt: timestamp,
    // Local capture is not a venue update timestamp. No Date.now() substitution.
    venueUpdatedAt: timestamp.nullable(),
    balance: amount,
    equity: amount,
    drawdownFloor: amount,
    dailyLossRuleKnown: z.boolean(),
    dailyLossFloor: amount,
    quote: z
      .object({
        market: text.nullable(),
        price: amount,
        basis: text.nullable(),
        venueUpdatedAt: timestamp.nullable(),
      })
      .strict()
      .nullable(),
    positions: collection(
      z
        .object({
          venuePositionId: text.nullable(),
          entryVenueOrderId: text.nullable(),
          accountVisibleId: text.nullable(),
          market: text.nullable(),
          side: sideSchema.nullable(),
          quantity: amount,
          averagePrice: amount,
        })
        .strict(),
    ),
    openOrders: collection(
      z
        .object({ venueOrderId: text.nullable(), status: text.nullable() })
        .strict(),
    ),
    fills: collection(visibleFillSchema),
    protections: collection(visibleProtectionSchema),
    unresolvedAttempts: z.boolean().nullable(),
  })
  .strict();
export type VisibleObservation = z.infer<typeof visibleObservationSchema>;

function requireEvidence(condition: unknown, code: string): asserts condition {
  if (!condition) throw new Error(code);
}
const exact = (value: z.infer<typeof amount>) =>
  value.precision === 'EXACT' && value.value !== null;
export type ObservationFreshness = { now: number; maxAgeMs: number };
function assertAuthenticatedCapture(
  observation: VisibleObservation,
  policy: ObservationFreshness,
) {
  requireEvidence(
    Number.isSafeInteger(policy.now) &&
      Number.isSafeInteger(policy.maxAgeMs) &&
      policy.maxAgeMs > 0,
    'INVALID_EVIDENCE_BUDGET',
  );
  requireEvidence(
    observation.session === 'AUTHENTICATED',
    'MANUAL_REAUTHENTICATION_REQUIRED',
  );
  requireEvidence(
    isFresh(observation.observedAt, policy.now, policy.maxAgeMs),
    'STALE_CAPTURE',
  );
  requireEvidence(
    observation.venueUpdatedAt !== null &&
      isFresh(observation.venueUpdatedAt, policy.now, policy.maxAgeMs),
    'ACCOUNT_FRESHNESS_UNPROVEN',
  );
}
export function assertStableIdentity(
  actual: VisibleAccountRef,
  expected: VisibleAccountRef,
) {
  requireEvidence(
    expected.visibleId && expected.label && expected.product,
    'IDENTITY_UNAVAILABLE',
  );
  requireEvidence(
    actual.visibleId === expected.visibleId &&
      actual.label === expected.label &&
      actual.product === expected.product,
    'ACCOUNT_IDENTITY_MISMATCH',
  );
}

/** Evidence completeness only; this never authorizes entry or creates risk state. */
export function assertCurrentObservation(
  observation: VisibleObservation,
  expected: VisibleAccountRef,
  now: number,
  maxAgeMs: number,
) {
  assertStableIdentity(observation.account, expected);
  assertAuthenticatedCapture(observation, { now, maxAgeMs });
  requireEvidence(
    [observation.balance, observation.equity, observation.drawdownFloor].every(
      exact,
    ),
    'RISK_VALUES_UNAVAILABLE',
  );
  requireEvidence(
    observation.dailyLossRuleKnown &&
      (observation.dailyLossFloor.value === null ||
        exact(observation.dailyLossFloor)),
    'DAILY_LOSS_RULE_UNAVAILABLE',
  );
  requireEvidence(
    observation.quote &&
      observation.quote.market &&
      observation.quote.basis &&
      exact(observation.quote.price) &&
      positive.safeParse(observation.quote.price.value).success,
    'QUOTE_UNAVAILABLE',
  );
  requireEvidence(
    observation.quote.venueUpdatedAt !== null &&
      isFresh(observation.quote.venueUpdatedAt, now, maxAgeMs),
    'QUOTE_FRESHNESS_UNPROVEN',
  );
  requireEvidence(
    observation.positions.complete && observation.positions.rows !== null,
    'POSITIONS_UNAVAILABLE',
  );
  requireEvidence(
    observation.openOrders.complete && observation.openOrders.rows !== null,
    'OPEN_ORDERS_UNAVAILABLE',
  );
}

/** A caller must already have proven this venue order ID's link to its attempt.
 * Side/size/time resemblance and a local request ID cannot supply that link. */
export function assertUniqueTerminalFill(
  observation: VisibleObservation,
  expected: {
    account: VisibleAccountRef;
    venueOrderId: string | null;
    venuePositionId: string | null;
    role: 'ENTRY' | 'EXIT';
    market: string;
    side: 'LONG' | 'SHORT';
  },
  policy: ObservationFreshness,
): VisibleFill {
  assertStableIdentity(observation.account, expected.account);
  assertAuthenticatedCapture(observation, policy);
  requireEvidence(expected.venueOrderId, 'VENUE_CORRELATION_UNPROVEN');
  requireEvidence(
    observation.fills.complete && observation.fills.rows !== null,
    'FILL_HISTORY_UNAVAILABLE',
  );
  const matches = observation.fills.rows.filter(
    (row) => row.venueOrderId === expected.venueOrderId,
  );
  requireEvidence(matches.length === 1, 'FILL_CORRELATION_AMBIGUOUS');
  const fill = matches[0]!;
  requireEvidence(
    fill.accountVisibleId === expected.account.visibleId &&
      fill.market === expected.market &&
      fill.side === expected.side &&
      fill.role === expected.role &&
      expected.venuePositionId &&
      fill.venuePositionId === expected.venuePositionId,
    'FILL_IDENTITY_MISMATCH',
  );
  requireEvidence(
    [
      fill.requestedSize,
      fill.filledSize,
      fill.remainingSize,
      fill.averagePrice,
      fill.fees,
    ].every(exact) &&
      fill.venueTimestamp !== null &&
      fill.venueTimestamp <= observation.observedAt,
    'FILL_PRECISION_UNAVAILABLE',
  );
  const requested = new D(fill.requestedSize.value!);
  const filled = new D(fill.filledSize.value!);
  requireEvidence(
    requested.gt(0) &&
      filled.gt(0) &&
      filled.lte(requested) &&
      new D(fill.averagePrice.value!).gt(0) &&
      new D(fill.fees.value!).gte(0),
    'INVALID_FILL_VALUES',
  );
  requireEvidence(
    new D(fill.remainingSize.value!).eq(0) &&
      ((fill.status === 'FILLED' && filled.eq(requested)) ||
        (fill.status === 'PARTIALLY_FILLED' &&
          filled.lt(requested) &&
          fill.remainderCanceled === true)),
    'FILL_NOT_TERMINAL',
  );
  return fill;
}

/** Tests capability evidence, not a controller PROTECTED state. */
export function assertProtectionCapabilities(
  observation: VisibleObservation,
  fill: VisibleFill,
  expected: { stopPrice: string; targetPrice: string; triggerBasis: string },
  policy: ObservationFreshness,
) {
  assertAuthenticatedCapture(observation, policy);
  requireEvidence(
    fill.venueOrderId &&
      fill.accountVisibleId === observation.account.visibleId,
    'PROTECTION_ENTRY_UNPROVEN',
  );
  requireEvidence(fill.market && fill.side, 'PROTECTION_ENTRY_UNPROVEN');
  const terminal = assertUniqueTerminalFill(
    observation,
    {
      account: observation.account,
      venueOrderId: fill.venueOrderId,
      market: fill.market,
      side: fill.side,
      role: 'ENTRY',
      venuePositionId: fill.venuePositionId,
    },
    policy,
  );
  requireEvidence(
    exact(fill.filledSize) &&
      exact(fill.averagePrice) &&
      new D(fill.filledSize.value!).eq(terminal.filledSize.value!) &&
      new D(fill.averagePrice.value!).eq(terminal.averagePrice.value!),
    'PROTECTION_ENTRY_UNPROVEN',
  );
  requireEvidence(
    observation.positions.complete && observation.positions.rows !== null,
    'POSITIONS_UNAVAILABLE',
  );
  const positions = observation.positions.rows.filter(
    (position) => position.entryVenueOrderId === fill.venueOrderId,
  );
  requireEvidence(positions.length === 1, 'PROTECTION_POSITION_UNPROVEN');
  const position = positions[0]!;
  requireEvidence(
    position.venuePositionId === terminal.venuePositionId &&
      position.accountVisibleId === fill.accountVisibleId &&
      position.market === fill.market &&
      position.side === fill.side &&
      exact(position.quantity) &&
      exact(position.averagePrice) &&
      new D(position.quantity.value!).eq(terminal.filledSize.value!) &&
      new D(position.averagePrice.value!).eq(terminal.averagePrice.value!),
    'PROTECTION_POSITION_UNPROVEN',
  );
  requireEvidence(
    observation.protections.complete && observation.protections.rows !== null,
    'PROTECTION_BOOK_UNAVAILABLE',
  );
  const rows = observation.protections.rows.filter(
    (row) => row.entryVenueOrderId === fill.venueOrderId,
  );
  requireEvidence(
    rows.length === 2 &&
      new Set(rows.map((row) => row.type)).size === 2 &&
      new Set(rows.map((row) => row.venueOrderId)).size === 2,
    'PROTECTION_PAIR_UNPROVEN',
  );
  requireEvidence(
    rows[0]!.siblingGroupId &&
      rows[0]!.siblingGroupId === rows[1]!.siblingGroupId,
    'SIBLING_PAIR_UNPROVEN',
  );
  for (const row of rows) {
    requireEvidence(
      row.venueOrderId &&
        row.accountVisibleId === fill.accountVisibleId &&
        row.market === fill.market &&
        row.side === fill.side &&
        row.status === 'ACTIVE',
      'PROTECTION_IDENTITY_UNPROVEN',
    );
    requireEvidence(
      exact(row.quantity) &&
        exact(fill.filledSize) &&
        exact(row.triggerPrice) &&
        new D(row.quantity.value!).eq(fill.filledSize.value!) &&
        new D(row.triggerPrice.value!).eq(
          row.type === 'STOP_LOSS' ? expected.stopPrice : expected.targetPrice,
        ) &&
        row.triggerBasis === expected.triggerBasis,
      'PROTECTION_VALUES_UNPROVEN',
    );
    requireEvidence(row.reduceOnly === true, 'REDUCE_ONLY_UNPROVEN');
    requireEvidence(
      row.persistsWithoutBrowser === true,
      'PROTECTION_PERSISTENCE_UNPROVEN',
    );
    requireEvidence(
      row.siblingCancellation === 'PROVEN',
      'SIBLING_CANCELLATION_UNPROVEN',
    );
  }
  return rows;
}

/** Proves only the current complete book is flat; it is not proof of a prior close. */
export function assertCurrentBookShowsFlat(
  observation: VisibleObservation,
  expected: VisibleAccountRef,
  policy: ObservationFreshness,
) {
  assertStableIdentity(observation.account, expected);
  assertAuthenticatedCapture(observation, policy);
  requireEvidence(
    observation.positions.complete && observation.positions.rows !== null,
    'POSITIONS_UNAVAILABLE',
  );
  requireEvidence(
    observation.openOrders.complete && observation.openOrders.rows !== null,
    'OPEN_ORDERS_UNAVAILABLE',
  );
  requireEvidence(
    observation.protections.complete && observation.protections.rows !== null,
    'PROTECTION_BOOK_UNAVAILABLE',
  );
  requireEvidence(
    observation.fills.complete &&
      observation.fills.rows !== null &&
      observation.unresolvedAttempts === false &&
      observation.fills.rows.every(
        (fill) =>
          !['PENDING', 'UNKNOWN'].includes(fill.status) &&
          (fill.status !== 'PARTIALLY_FILLED' ||
            (fill.remainderCanceled === true &&
              exact(fill.remainingSize) &&
              new D(fill.remainingSize.value!).eq(0))),
      ),
    'RECONCILIATION_UNAVAILABLE',
  );
  requireEvidence(
    observation.positions.rows.length === 0 &&
      observation.openOrders.rows.length === 0 &&
      observation.protections.rows.every((row) =>
        ['CANCELED', 'FILLED', 'REJECTED'].includes(row.status),
      ),
    'FLATNESS_UNPROVEN',
  );
}

/** Requires an independently proven venue exit link, plus a complete current flat book.
 * Row disappearance cannot substitute for a terminal exit record. */
export function assertReconciledClose(
  observation: VisibleObservation,
  expected: {
    account: VisibleAccountRef;
    venueOrderId: string | null;
    venuePositionId: string | null;
    market: string;
    side: 'LONG' | 'SHORT';
    exitedQuantity: string;
  },
  policy: ObservationFreshness,
) {
  assertCurrentBookShowsFlat(observation, expected.account, policy);
  const exit = assertUniqueTerminalFill(
    observation,
    { ...expected, role: 'EXIT' },
    policy,
  );
  requireEvidence(
    positive.safeParse(expected.exitedQuantity).success &&
      new D(exit.filledSize.value!).eq(expected.exitedQuantity),
    'CLOSE_QUANTITY_UNPROVEN',
  );
  return exit;
}
