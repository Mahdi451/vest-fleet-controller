import {
  D,
  accountSchema,
  intentSchema,
  quoteSchema,
  riskConfigSchema,
  remainingDrawdown,
  effectiveFloor,
  isFresh,
  positive,
  nonnegative,
  direction,
  type Account,
  type TradeIntent,
  type Quote,
  type RiskConfig,
} from '../../core/src/index.ts';

export function dollarPerPoint(notional: string, price: string): string {
  return new D(nonnegative.parse(notional))
    .div(positive.parse(price))
    .toFixed();
}
export function stopRisk(
  notional: string,
  price: string,
  stop: string,
): string {
  return new D(dollarPerPoint(notional, price))
    .mul(positive.parse(stop))
    .toFixed();
}
export function notionalForRisk(
  risk: string,
  price: string,
  stop: string,
): string {
  return new D(nonnegative.parse(risk))
    .mul(positive.parse(price))
    .div(positive.parse(stop))
    .toFixed();
}
/** Exact simulator decimals. Venue tick size/rounding must be verified before live use. */
export function protectionPrices(fillPrice: string, intent: TradeIntent) {
  const fill = new D(positive.parse(fillPrice));
  const t = intentSchema.parse(intent);
  const sign = direction(t.side);
  return {
    stopPrice: positive.parse(
      fill.minus(new D(t.stopDistancePoints).mul(sign)).toFixed(),
    ),
    targetPrice: positive.parse(
      fill.plus(new D(t.takeProfitPoints).mul(sign)).toFixed(),
    ),
  };
}

export function costsFor(a: Account, c: RiskConfig) {
  return a.feeOverride ?? c;
}
export interface RiskPreview {
  accountId: string;
  approved: boolean;
  reasons: string[];
  availableDrawdown: string;
  budget: string;
  quantity: string;
  notional: string;
  dollarPerPoint: string;
  stopRisk: string;
  entryFee: string;
  exitFee: string;
  slippage: string;
  funding: string;
  accountCost: string;
  totalPlannedLoss: string;
  remainingAfterStop: string;
  marginRequired: string;
  estimatedStop: string;
  estimatedTarget: string;
}
export function sizeTrade(
  account: Account,
  intent: TradeIntent,
  quote: Quote,
  config: RiskConfig,
  now: number,
): RiskPreview {
  const a = accountSchema.parse(account),
    t = intentSchema.parse(intent);
  const q = quoteSchema.parse(quote),
    c = riskConfigSchema.parse(config);
  const reasons: string[] = [];
  const p = new D(q.price),
    stop = new D(t.stopDistancePoints),
    slip = new D(c.slippagePointsPerSide);
  const dd = new D(remainingDrawdown(a)),
    fee = costsFor(a, c),
    fixed = new D(fee.accountCost);
  if (!a.enabled) reasons.push('ACCOUNT_DISABLED');
  if (a.status !== 'ACTIVE' || new D(a.equity).lte(effectiveFloor(a)))
    reasons.push('ACCOUNT_BREACHED');
  if (a.executionStatus === 'UNKNOWN') reasons.push('UNRESOLVED_EXECUTION');
  if (a.positions.length > 0) reasons.push('EXISTING_POSITION');
  if (!isFresh(a.lastSyncTimestamp, now, c.maxDataAgeMs))
    reasons.push('STALE_ACCOUNT');
  if (!isFresh(q.timestamp, now, c.maxDataAgeMs)) reasons.push('STALE_QUOTE');
  if (new D(t.leverage).lt(1) || new D(t.leverage).gt(c.maxLeverage))
    reasons.push('LEVERAGE_LIMIT');
  if (
    (a.positions.length === 0 && !new D(a.unrealizedPnl).isZero()) ||
    !new D(a.balance).plus(a.unrealizedPnl).eq(a.equity) ||
    !new D(a.remainingDrawdown).eq(dd)
  )
    reasons.push('INCONSISTENT_ACCOUNT');
  const stopPrice = p.minus(stop.mul(direction(t.side)));
  const target = p.plus(new D(t.takeProfitPoints).mul(direction(t.side)));
  if (D.min(stopPrice, target).minus(slip).lte(0) || p.minus(slip).lte(0))
    reasons.push('INVALID_PROTECTION_PRICE');
  // Preview estimates only; final protection anchors to fill. Two slippage allowances
  // remain conservative for fill-relative stops. Rates are fractions; quantity is $/point.
  const entryBasis = p.plus(slip);
  const exitBasis = p.plus(stop).plus(slip.mul(2));
  const perUnit = stop
    .plus(slip.mul(2))
    .plus(entryBasis.mul(fee.entryFeeRate))
    .plus(exitBasis.mul(fee.exitFeeRate))
    .plus(exitBasis.mul(c.fundingRateAllowance));
  // Margin allocation is a requested exposure, never an implied loss budget.
  // Use the smaller balance/equity and adverse entry basis, then round down.
  const marginQuantity = D.max(0, D.min(a.balance, a.equity))
    .mul(t.riskValue)
    .div(100)
    .mul(t.leverage)
    .div(entryBasis);
  const budget =
    t.riskMode === 'PERCENT_DRAWDOWN'
      ? dd.mul(t.riskValue).div(100)
      : t.riskMode === 'FIXED_DOLLAR'
        ? new D(t.riskValue)
        : (t.riskMode === 'MARGIN_PERCENT'
            ? marginQuantity
            : new D(t.riskValue).div(p)
          )
            .mul(perUnit)
            .plus(fixed);
  const raw =
    t.riskMode === 'MARGIN_PERCENT'
      ? marginQuantity
      : t.riskMode === 'FIXED_NOTIONAL'
        ? new D(t.riskValue).div(p)
        : D.max(0, budget.minus(fixed)).div(perUnit);
  const qty = raw.div(c.sizeStep).floor().mul(c.sizeStep);
  const entryFee = qty.mul(entryBasis).mul(fee.entryFeeRate),
    exitFee = qty.mul(exitBasis).mul(fee.exitFeeRate);
  const funding = qty.mul(exitBasis).mul(c.fundingRateAllowance),
    slippage = qty.mul(slip).mul(2);
  const loss = qty
    .mul(stop)
    .plus(entryFee)
    .plus(exitFee)
    .plus(funding)
    .plus(slippage)
    .plus(fixed);
  const margin = qty.mul(entryBasis).div(t.leverage);
  if (qty.lte(0)) reasons.push('SIZE_BELOW_MINIMUM');
  if (
    dd.minus(loss).lt(c.minimumRemainingDrawdownAfterStop) ||
    dd.minus(loss).lte(0)
  )
    reasons.push('DRAWDOWN_RESERVE');
  if (margin.plus(entryFee).plus(fixed).gt(D.min(a.balance, a.equity)))
    reasons.push('INSUFFICIENT_MARGIN');
  if (
    ['FIXED_DOLLAR', 'PERCENT_DRAWDOWN'].includes(t.riskMode) &&
    loss.gt(budget)
  )
    reasons.push('RISK_BUDGET_EXCEEDED');
  return {
    accountId: a.accountId,
    approved: reasons.length === 0,
    reasons,
    availableDrawdown: dd.toFixed(),
    budget: budget.toFixed(),
    quantity: qty.toFixed(),
    notional: qty.mul(p).toFixed(),
    dollarPerPoint: qty.toFixed(),
    stopRisk: qty.mul(stop).toFixed(),
    entryFee: entryFee.toFixed(),
    exitFee: exitFee.toFixed(),
    slippage: slippage.toFixed(),
    funding: funding.toFixed(),
    accountCost: fixed.toFixed(),
    totalPlannedLoss: loss.toFixed(),
    remainingAfterStop: dd.minus(loss).toFixed(),
    marginRequired: margin.toFixed(),
    estimatedStop: stopPrice.toFixed(),
    estimatedTarget: target.toFixed(),
  };
}

/** Reassess stop loss from actual execution; entry fees are already debited from after.balance. */
export function assessFilledRisk(
  after: Account,
  intent: TradeIntent,
  config: RiskConfig,
  entryFees: string,
  plannedLoss: string,
) {
  const a = accountSchema.parse(after),
    t = intentSchema.parse(intent),
    c = riskConfigSchema.parse(config);
  const p = a.positions[0];
  if (!p) throw new Error('NO_FILLED_POSITION');
  const q = new D(p.quantity),
    fill = new D(p.entryPrice),
    slip = new D(c.slippagePointsPerSide);
  const costs = costsFor(a, c);
  const exitBasis = fill.plus(t.stopDistancePoints).plus(slip);
  const futureLoss = q
    .mul(new D(t.stopDistancePoints).plus(slip))
    .plus(q.mul(exitBasis).mul(costs.exitFeeRate))
    .plus(q.mul(exitBasis).mul(c.fundingRateAllowance));
  const totalLoss = futureLoss.plus(nonnegative.parse(entryFees));
  const remaining = new D(a.balance).minus(futureLoss).minus(effectiveFloor(a));
  const margin = q.mul(fill).div(t.leverage);
  const approved =
    a.status === 'ACTIVE' &&
    p.side === t.side &&
    p.symbol === t.symbol &&
    new D(p.leverage).eq(t.leverage) &&
    new D(a.equity).eq(new D(a.balance).plus(a.unrealizedPnl)) &&
    new D(a.remainingDrawdown).eq(remainingDrawdown(a)) &&
    new D(a.equity).gt(effectiveFloor(a)) &&
    totalLoss.lte(nonnegative.parse(plannedLoss)) &&
    remaining.gte(c.minimumRemainingDrawdownAfterStop) &&
    remaining.gt(0) &&
    margin.lte(D.min(a.balance, a.equity));
  return {
    approved,
    totalLoss: totalLoss.toFixed(),
    remainingAfterStop: remaining.toFixed(),
  };
}
