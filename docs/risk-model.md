# Risk model

All monetary values and prices cross domain boundaries as validated decimal strings.
Arithmetic uses decimal.js at 40-digit precision. Quantity rounds **down** to the
configured step; the step is not yet verified for Vest. UI rounding is display-only.

## Gross formulas

For a linear instrument with price P, notional N and stop distance S:

- Dollar per point = N / P.
- Stop-only loss = (N / P) × S.
- Notional for gross risk R = R × P / S.

P=30,400, R=$4 and S=60 gives $2,026.666… gross notional before costs.
Leverage controls required margin, not dollars per point for the same notional.

## Available buffer

Effective floor = max(fixed drawdown floor, supplied daily-loss floor if present).
Remaining drawdown = max(0, equity − effective floor).
Equity = cash balance + unrealized P&L. Fees and funding affect balance and realized
net P&L. Withdrawals reduce balance but are not trading losses.

The account's reported remaining drawdown must equal the recomputed value. Inconsistent
state fails closed. Unverified daily reset rules are not calculated automatically.

## All-in sizing

Let q be quantity ($/point), s slippage allowance per side, e entry fee rate, x exit
fee rate, f funding allowance for the whole planned holding period and C fixed
account-specific cost. Rates are fractions: 0.0025% = 0.000025.

Conservative per-unit loss coefficient:

`K = S + 2s + (P+s)e + (P+S+2s)x + (P+S+2s)f`

The fee/funding price bases are upper estimates covering either direction at the
planned stop. The mock anchors stop/target prices to the decision quote and applies
adverse slippage at both actual executions. This is conservative within the configured
slippage/holding assumptions, not a guaranteed maximum loss across gaps or unlimited time.

| Mode             | Allocation                                                                            |
| ---------------- | ------------------------------------------------------------------------------------- |
| FIXED_DOLLAR     | B = input risk dollars; q = floor_step(max(0, B−C) / K)                               |
| PERCENT_DRAWDOWN | B = remaining drawdown × input percent / 100; same quantity equation                  |
| FIXED_NOTIONAL   | q = floor_step(input notional / P); calculate B = raw quantity × K + C, then validate |

Planned total loss = qK + C. Display stop-only loss qS separately from entry fee,
exit fee, slippage, funding and fixed cost. Never credit favorable expected funding
against risk. Account-specific fee/cost overrides are supported.

Approve only if remaining drawdown − planned loss is **at least the reserve and greater
than zero**. Equality with the failure floor is unsafe even with a zero configured reserve.
Also require positive quantity, valid protection prices, active/enabled account, no
existing position, allowed leverage, fresh account/quote and sufficient free equity.
Initial margin estimate is q(P+s)/leverage, plus entry costs. Real maintenance margin
and venue liquidation behavior are not modeled and must be verified before live use.

Examples: 40% of $14.55 yields a $5.82 all-in budget; 40% of $10 yields $4. A $9 planned
loss with $10 available and $2 required reserve is rejected. The 40% input is a user
example/configurable policy, not a recommendation about trading risk.

## Limitations

Only linear single-market exposure is modeled. No inverse contracts, options, portfolio
offsets, pyramiding or guaranteed stops. Funding scenarios are explicit; actual holding
time must be bounded/reassessed in a future service. Precision, mark-price basis,
fees, execution price protection and market hours remain live integration prerequisites.
