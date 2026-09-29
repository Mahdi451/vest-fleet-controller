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
planned stop. Final protection is anchored to actual fill. The existing two-sided
slippage allowance is retained conservatively: entry slippage shifts the anchor and
exit slippage still adds to stop loss. No extra size is credited back after entry.
This is conservative within configured slippage/holding assumptions, not a guaranteed
maximum loss across gaps, unprotected execution intervals or unlimited time.

| Mode             | Allocation                                                                                                          |
| ---------------- | ------------------------------------------------------------------------------------------------------------------- |
| MARGIN_PERCENT   | M = min(balance, equity) × input percent / 100; q = floor_step(M × leverage / (P+s)); calculate loss, then validate |
| FIXED_DOLLAR     | B = input risk dollars; q = floor_step(max(0, B−C) / K)                                                             |
| PERCENT_DRAWDOWN | B = remaining drawdown × input percent / 100; same quantity equation                                                |
| FIXED_NOTIONAL   | q = floor_step(input notional / P); calculate B = raw quantity × K + C, then validate                               |

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

## Preview estimates versus final protection

`stopDistancePoints` and `takeProfitPoints` remain authoritative intent. Risk previews
expose `estimatedStop` and `estimatedTarget` from the current quote; they are estimates,
not attached orders or promised fill levels. MARKET entry creates an unprotected
position. The controller reconciles the actual destination fill before calculating:

| Side  | Final STOP_LOSS           | Final TAKE_PROFIT       |
| ----- | ------------------------- | ----------------------- |
| LONG  | fill − stopDistancePoints | fill + takeProfitPoints |
| SHORT | fill + stopDistancePoints | fill − takeProfitPoints |

For LONG fill 30,450.25, stop distance 25 and target distance 50, final SL is
30,425.25 and TP is 30,500.25. `protectionPrices()` uses decimal arithmetic, with
positive-price validation. Reconciliation compares against these actual-fill levels,
never equality with the preview's estimated prices.

A CME/signal source may select LONG/SHORT, but its price does not anchor destination
protection. No signal feed is implemented here. Both separate exits must be reduce-only
and confirmed active before establishment succeeds. An unprotected filled position is
unsafe; failed protection causes immediate flatten attempt and circuit halt.

The simulator has no invented CME or Vest price tick. Decimal values are preserved
exactly; configured quantity rounding remains separate. A future live adapter must
verify destination tick size, precision and trigger rules, define conservative rounding,
and recheck risk after rounding. Entry fill/fee overruns outside the modeled envelope
already fail closed. Gaps and protection outages can exceed the modeled loss.

## Limitations

Only linear single-market exposure is modeled. No inverse contracts, options, portfolio
offsets, pyramiding or guaranteed stops. Funding scenarios are explicit; actual holding
time must be bounded/reassessed in a future service. Precision, mark-price basis,
fees, execution price protection and market hours remain live integration prerequisites.

## Margin allocation is not loss allocation

The dashboard defaults to MARGIN_PERCENT after the user clarified that 10x/75% means
75% equity as margin at 10x leverage. For $500, this gives approximately $3,750 exposure;
50x/25% gives approximately $6,250. A stop and modeled costs still determine the loss.
An 80-point stop at price 30,400 fails the $2-reserve check for a $500 account with a $490
floor under both presets. The larger-buffer first account can differ. Requested sizes
are displayed even when rejected; no automatic size reduction or stop adjustment occurs.
Entry fees must fit in addition to margin, so 100% allocation can fail the margin check.

## Mandatory cross-account hedge guard

Design update: 2026-09-29, following the user's explicit safety requirement.
`CROSS_ACCOUNT_HEDGE_GUARD = ENABLED` is mandatory, not a user-disableable risk setting.
All accounts in the current simulated fleet represent funded accounts.

| Existing fleet exposure                   | Proposed entry on another enabled account | Hedge decision                                               |
| ----------------------------------------- | ----------------------------------------- | ------------------------------------------------------------ |
| Enabled NQ/NDX LONG                       | NQ/NDX LONG                               | Allow through this guard                                     |
| Enabled NQ/NDX LONG                       | NQ/NDX SHORT                              | Reject                                                       |
| Enabled NQ/NDX SHORT                      | NQ/NDX SHORT                              | Allow through this guard                                     |
| Enabled NQ/NDX SHORT                      | NQ/NDX LONG                               | Reject                                                       |
| Enabled accounts all flat                 | LONG or SHORT                             | Allow through this guard                                     |
| Disabled account has opposite exposure    | Entry on an enabled account               | Ignore disabled exposure for this guard                      |
| Enabled NQ LONG                           | SPX SHORT                                 | No automatic correlation block; future policy extension only |
| Any exposure, including an existing hedge | Emergency flatten                         | Always permit the attempt                                    |

"Allow" here means the hedge guard passes. All account, cost, reserve, freshness,
leverage, margin and flat-destination checks still apply. Same-direction copying into
flat accounts is permitted by this application policy; adding to an existing position
is still rejected. This does not establish Vest's permission for copy trading.

The guard inspects every **enabled** account, including those not selected for the new
trade. It ignores disabled accounts exactly as requested; disabling does not close a
position or establish that Vest would ignore it. Unchecking a dashboard participation
box is not disabling an account. Emergency flatten includes both categories.

Pre-trade sequence: validate intent and snapshots → evaluate enabled-fleet exposure →
calculate per-account risk → preview → re-read the enabled fleet immediately before
**each** child → evaluate exposure again → submit. The mock adapter independently
rechecks its current book. An initial conflict rejects the fleet before any submission;
a newly introduced conflict during fan-out stops remaining dispatch and halts entries.
Already filled positions are reported explicitly, not silently undone.

`CROSS_ACCOUNT_HEDGE_GUARD` identifies rejections, with conflicting account/market/side
in preview diagnostics. The risk engine uses an additive `FleetExposureRule` interface:
the mandatory same-market rule always runs and future verified correlation rules can
add violations, never remove its violations. No correlation groups, statistical
thresholds or NQ/SPX equivalence are enabled. Rule-level NQ/NDX aliases are local display
normalization only; executable intents remain NDX-only and no Vest API symbol is certified.
