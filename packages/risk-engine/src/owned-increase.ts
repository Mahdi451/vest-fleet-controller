import {
  D,
  accountSchema,
  quoteSchema,
  riskConfigSchema,
  remainingDrawdown,
  effectiveFloor,
  direction,
  isFresh,
  type Account,
  type Quote,
  type RiskConfig,
  positive,
  nonnegative,
} from '../../core/src/index.ts';
import { costsFor } from './index.ts';

/** Aggregate owned-position risk; never fabricates a flat account to reuse entry sizing. */
export function assessOwnedIncrease(
  account: Account,
  quote: Quote,
  config: RiskConfig,
  deltaQuantity: string,
  stopPrice: string,
  caps: { maxNotional: string; maxPlannedLoss: string },
  now: number,
) {
  const a = accountSchema.parse(account),
    q = quoteSchema.parse(quote),
    c = riskConfigSchema.parse(config);
  const delta = new D(nonnegative.parse(deltaQuantity)),
    stop = new D(positive.parse(stopPrice)),
    p = a.positions[0];
  if (!p || a.positions.length !== 1)
    throw new Error('OWNED_POSITION_REQUIRED');
  const fee = costsFor(a, c),
    slip = new D(c.slippagePointsPerSide),
    fill = new D(q.price).plus(slip.mul(direction(p.side)));
  const quantity = new D(p.quantity).plus(delta),
    basis = new D(p.entryPrice)
      .mul(p.quantity)
      .plus(fill.mul(delta))
      .div(quantity);
  const entryFee = delta.isZero()
    ? new D(0)
    : fill.mul(delta).mul(fee.entryFeeRate).plus(fee.accountCost);
  const exitBasis = D.max(q.price, basis, stop).plus(slip);
  const stopRisk = D.max(0, basis.minus(stop).mul(direction(p.side))).mul(
    quantity,
  );
  const totalPlannedLoss = stopRisk
    .plus(entryFee)
    .plus(exitBasis.mul(quantity).mul(fee.exitFeeRate))
    .plus(quantity.mul(slip).mul(2))
    .plus(exitBasis.mul(quantity).mul(c.fundingRateAllowance));
  const notional = quantity.mul(D.max(q.price, fill, basis)),
    margin = notional.div(p.leverage);
  const remainingAfterStop = new D(a.balance)
    .minus(effectiveFloor(a))
    .minus(totalPlannedLoss);
  const reasons: string[] = [];
  if (
    a.status !== 'ACTIVE' ||
    (!delta.isZero() && (!a.enabled || a.executionStatus === 'UNKNOWN'))
  )
    reasons.push('ACCOUNT_UNAVAILABLE');
  if (
    !isFresh(a.lastSyncTimestamp, now, c.maxDataAgeMs) ||
    !isFresh(q.timestamp, now, c.maxDataAgeMs)
  )
    reasons.push('STALE_EVIDENCE');
  if (
    !new D(a.balance).plus(a.unrealizedPnl).eq(a.equity) ||
    !new D(a.remainingDrawdown).eq(remainingDrawdown(a))
  )
    reasons.push('RISK_LIMIT');
  if (
    !delta.mod(c.sizeStep).isZero() ||
    new D(p.leverage).gt(c.maxLeverage) ||
    new D(p.leverage).lt(1) ||
    fill.lte(0)
  )
    reasons.push('RISK_LIMIT');
  if (
    notional.gt(positive.parse(caps.maxNotional)) ||
    totalPlannedLoss.gt(positive.parse(caps.maxPlannedLoss)) ||
    remainingAfterStop.lt(c.minimumRemainingDrawdownAfterStop) ||
    margin.gt(D.min(a.balance, a.equity).minus(entryFee))
  )
    reasons.push('RISK_LIMIT');
  return {
    approved: reasons.length === 0,
    reasons,
    quantity: quantity.toFixed(),
    basis: basis.toFixed(),
    fillPrice: fill.toFixed(),
    entryFee: entryFee.toFixed(),
    totalPlannedLoss: totalPlannedLoss.toFixed(),
    notional: notional.toFixed(),
    remainingAfterStop: remainingAfterStop.toFixed(),
  };
}
