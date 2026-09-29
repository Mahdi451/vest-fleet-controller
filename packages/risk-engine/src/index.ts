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
  stop: string;
  target: string;
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
  // Upper bounds cover both directions; rates are decimal fractions. Quantity is $/point.
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
    stop: stopPrice.toFixed(),
    target: target.toFixed(),
  };
}
