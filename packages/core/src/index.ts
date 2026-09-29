import { Decimal } from 'decimal.js';
import { z } from 'zod';

export const D = Decimal.clone({ precision: 40, rounding: Decimal.ROUND_DOWN });
export const decimal = z
  .string()
  .regex(/^-?\d+(\.\d+)?$/)
  .max(60);
export const positive = decimal.refine(
  (v) => new D(v).gt(0),
  'Must be positive',
);
export const nonnegative = decimal.refine(
  (v) => new D(v).gte(0),
  'Must be nonnegative',
);
export const rate = nonnegative.refine(
  (v) => new D(v).lte(1),
  'Rate must be <= 1',
);
export const sideSchema = z.enum(['LONG', 'SHORT']);
export const intentSchema = z
  .object({
    symbol: z.literal('NDX'), // Internal simulation symbol; no external mapping asserted.
    side: sideSchema,
    entryType: z.literal('MARKET'),
    stopDistancePoints: positive,
    takeProfitPoints: positive,
    riskMode: z.enum([
      'FIXED_NOTIONAL',
      'FIXED_DOLLAR',
      'PERCENT_DRAWDOWN',
      'MARGIN_PERCENT',
    ]),
    riskValue: positive,
    leverage: positive,
  })
  .strict()
  .refine(
    (v) =>
      !['PERCENT_DRAWDOWN', 'MARGIN_PERCENT'].includes(v.riskMode) ||
      new D(v.riskValue).lte(100),
    'Percentage must be <= 100',
  );
export type TradeIntent = z.infer<typeof intentSchema>;

export const positionSchema = z
  .object({
    symbol: z.literal('NDX'),
    side: sideSchema,
    quantity: positive,
    entryPrice: positive,
    leverage: positive,
    entryRequestId: z.string().min(1),
    protectionStatus: z.enum(['NONE', 'SUBMITTING', 'ACTIVE', 'FAILED']),
  })
  .strict();
export type Position = z.infer<typeof positionSchema>;
export const executionStateSchema = z.enum([
  'PREVIEWED',
  'ENTRY_SUBMITTING',
  'ENTRY_FILLED_UNPROTECTED',
  'PROTECTION_SUBMITTING',
  'PROTECTED',
  'EXITED',
  'REJECTED',
  'UNKNOWN',
  'HALTED',
]);
export type ExecutionState = z.infer<typeof executionStateSchema>;
export const protectionRequestSchema = z
  .object({
    requestId: z.string().min(1),
    masterTradeId: z.string().min(1),
    accountId: z.string().min(1),
    entryRequestId: z.string().min(1),
    symbol: z.literal('NDX'),
    positionSide: sideSchema,
    quantity: positive,
    type: z.enum(['STOP_LOSS', 'TAKE_PROFIT']),
    triggerPrice: positive,
    reduceOnly: z.literal(true),
  })
  .strict();
export type ProtectionRequest = z.infer<typeof protectionRequestSchema>;
export const protectionOrderSchema = protectionRequestSchema.extend({
  orderId: z.string().min(1),
  status: z.enum(['ACTIVE', 'FILLED', 'CANCELED', 'REJECTED']),
  filledSize: nonnegative,
  error: z.string().nullable(),
});
export type ProtectionOrder = z.infer<typeof protectionOrderSchema>;
export type ProtectionStatus = Position['protectionStatus'];

export const accountSchema = z
  .object({
    accountId: z.string().min(1),
    label: z.string().min(1),
    startingBalance: positive,
    balance: decimal,
    equity: decimal,
    realizedPnl: decimal,
    unrealizedPnl: decimal,
    drawdown: z
      .object({ mode: z.literal('FIXED'), floor: nonnegative })
      .strict(),
    dailyLossFloor: nonnegative.nullable(),
    remainingDrawdown: nonnegative,
    leverage: positive,
    positions: z.array(positionSchema).max(1),
    enabled: z.boolean(),
    status: z.enum(['ACTIVE', 'BREACHED']),
    executionStatus: z.enum(['IDLE', 'FILLED', 'REJECTED', 'UNKNOWN']),
    lastSyncTimestamp: z.number().int().nonnegative(),
    revision: z.number().int().nonnegative(),
    feeOverride: z
      .object({
        entryFeeRate: rate,
        exitFeeRate: rate,
        accountCost: nonnegative,
      })
      .strict()
      .nullable(),
  })
  .strict();
export type Account = z.infer<typeof accountSchema>;
export const quoteSchema = z
  .object({
    symbol: z.literal('NDX'),
    price: positive,
    timestamp: z.number().int().nonnegative(),
  })
  .strict();
export type Quote = z.infer<typeof quoteSchema>;

export const riskConfigSchema = z
  .object({
    entryFeeRate: rate,
    exitFeeRate: rate,
    slippagePointsPerSide: nonnegative,
    fundingRateAllowance: rate,
    accountCost: nonnegative,
    minimumRemainingDrawdownAfterStop: nonnegative,
    sizeStep: positive,
    maxLeverage: positive,
    maxDataAgeMs: z.number().int().positive(),
    maxPreviewAgeMs: z.number().int().positive(),
    maxPriceMovePoints: nonnegative,
  })
  .strict();
export type RiskConfig = z.infer<typeof riskConfigSchema>;

export function effectiveFloor(a: Account): Decimal {
  return D.max(a.drawdown.floor, a.dailyLossFloor ?? '0');
}
export function remainingDrawdown(a: Account): string {
  return D.max(0, new D(a.equity).minus(effectiveFloor(a))).toFixed();
}
export function direction(side: TradeIntent['side']): number {
  return side === 'LONG' ? 1 : -1;
}
export function isFresh(
  timestamp: number,
  now: number,
  maxAge: number,
): boolean {
  return timestamp <= now && now - timestamp <= maxAge;
}
export function markAccount(a: Account, price: string, now: number): Account {
  const pnl = a.positions.reduce(
    (sum, p) =>
      sum.plus(
        new D(price).minus(p.entryPrice).mul(p.quantity).mul(direction(p.side)),
      ),
    new D(0),
  );
  a.unrealizedPnl = pnl.toFixed();
  a.equity = new D(a.balance).plus(pnl).toFixed();
  a.remainingDrawdown = remainingDrawdown(a);
  if (new D(a.equity).lte(effectiveFloor(a))) a.status = 'BREACHED';
  a.lastSyncTimestamp = now;
  a.revision += 1;
  return a;
}
export function initialFleet(now: number): Account[] {
  return Array.from({ length: 10 }, (_, i) => {
    const id = String(i + 1).padStart(2, '0');
    return accountSchema.parse({
      accountId: id,
      label: `Account ${id}`,
      startingBalance: '500',
      balance: i === 0 ? '504.55' : '500',
      equity: i === 0 ? '504.55' : '500',
      realizedPnl: i === 0 ? '4.55' : '0',
      unrealizedPnl: '0',
      drawdown: { mode: 'FIXED', floor: '490' },
      dailyLossFloor: null,
      remainingDrawdown: i === 0 ? '14.55' : '10',
      leverage: '50',
      positions: [],
      enabled: true,
      status: 'ACTIVE',
      executionStatus: 'IDLE',
      lastSyncTimestamp: now,
      revision: 0,
      feeOverride: null,
    });
  });
}
