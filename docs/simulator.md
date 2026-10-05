# Simulator behavior

Each new run starts Account 01 at $504.55 and Accounts 02–10 at $500, with $490 fixed
floors. Account snapshots are defensive copies. Account IDs are unique and balances
diverge naturally with quantity, fills, fees and disabled state.

| Operation         | Behavior                                                                                                    |
| ----------------- | ----------------------------------------------------------------------------------------------------------- |
| Market entry      | Re-runs the shared risk engine, checks account/fleet safety and deduplicates request ID                     |
| Fill              | Current synthetic quote plus adverse per-side slippage; charges entry fee and fixed account cost            |
| Leverage          | Per-order leverage recorded; estimated initial margin checked by risk engine                                |
| Protection        | Separate SL/TP calls after entry fill; reduce-only orders anchored to actual fill                           |
| Market update     | Mark equity, detect breach and evaluate ACTIVE protection orders                                            |
| Stop/target       | Close at current synthetic market price plus adverse slippage, not a guaranteed trigger price               |
| Partial close     | Realize proportional P&L and exit fee, preserve the remainder and protection                                |
| Funding           | Explicit signed hourly-rate × hours scenario; positive rates debit longs and credit shorts                  |
| Breach            | Equity at/below effective floor permanently marks breached; open positions close at current simulated price |
| Emergency flatten | Cancel active protection and close all accounts, including disabled; verify both books                      |

Available CLI scenarios: `win`, `loss`, `partial-failure`, `ambiguous`, `timeout`,
`disabled`, `gap`, `retry`. Each uses the same TradeIntent and risk engine.

The test suite additionally exercises funding, partial closes,
price movement between children, adapter timeout, journal restart, stale state and
same-market opposing positions across enabled accounts. Disabled exposure is ignored
by the entry guard, while flatten still includes disabled accounts. A failure in one account does not modify another
account's balance. Circuit-breaker policy may prevent later accounts from participating.

## Model boundaries

- This is a deterministic quote-driven simulator, not a backtest engine or Vest replica.
- It models one net position per account and one synthetic linear market.
- Equity uses the supplied synthetic quote; bid/ask spread is represented only through
  configured slippage. There is no order book, queue, liquidity or incremental fill-stream model,
  maintenance-margin liquidation formula, trading calendar or real market feed.
- There is no automatic funding clock. Capital/payment operations are outside this
  tool's scope; the former payout simulation has been removed. Historical journal
  rows remain intact for audit purposes.
- Entry and protection are separate calls. Raw entry has `protectionStatus: NONE`;
  market updates cannot trigger protection that has not been created. SL and TP must
  both be active for `PROTECTED` establishment. Gaps can occur during this interval.
- Sibling cancellation is local simulation behavior; no venue-native OCO is assumed.
  Full closes cancel siblings; reduce-only exits cap size after partial manual closes.
  Orders linked to an older entry cannot reverse or close a newer position.
- A price gap or funding charge beyond the configured allowance can breach an account.
- Dashboard snapshots persist account/order state and deduplication in SQLite. Startup
  restores that session halted and reconciles it. Each CLI invocation remains isolated.
- Snapshot recovery is not full deterministic event replay. Operator re-arm, external
  event-stream recovery and distributed ownership remain later work.

## Hedge policy scenarios

The simulator and controller share `evaluateFleetExposure`. Unit and integration cases in
`tests/hedge-guard.test.ts` cover same-direction copying, opposite same-market rejection,
flat destinations, disabled-source exclusion, enabled unselected positions, exposure
introduced after preview or between fills, and emergency flatten of an existing hedge.
A test-only generic-market rule demonstrates future NQ/SPX correlation extensibility;
SPX is not an executable simulator market and no correlated rule is enabled by default.

## Post-fill protection scenarios

`tests/protection.test.ts` exercises LONG/SHORT slippage, fractional fill anchors,
SL/TP rejection, lost responses, delayed calls, forged acknowledgements, mismatched
reconciliation, journal failure, immediate stop exit before TP establishment, sibling
cancellation, duplicate requests and flatten with absent/partial/full protection.
`injectProtectionFault(accountId, type, fault)` supplies deterministic rejection,
timeout-before-create and ambiguous-after-create scenarios to simulator tests.

With default quote 30,400 and one-point slippage, LONG fills at 30,401 and its 80-point
TP triggers at 30,481; SHORT fills at 30,399 and TP triggers at 30,319. CLI win/loss
scenarios now move relative to actual fill, rather than the preview quote. The trigger
is not the exit fill: adverse exit slippage and market gaps still apply.

## Durable beta scenarios

`PARTIAL_FILL` fills half the requested quantity, rounded down to the configured step,
and confirms the remainder canceled. `PARTIAL_FILL_PENDING` deliberately leaves the
remainder unconfirmed; the controller attempts flatten and halts. These fault modes
exercise terminal-versus-pending policy, not a liquidity model.

Snapshots include version, configuration, quote, accounts, entry ledger, protective
orders and request fingerprints. Fault-injection settings are not persisted. Every
simulator audit event first checkpoints its current state, including intermediate
unsafe states; price-update completion checkpoints refreshed flat accounts too.
Restore validates schema, identity references and exact configuration compatibility.
Missing/corrupt state is never silently replaced when execution history exists.

Real process-kill tests terminate between entry and protection or after SL activation,
then reopen SQLite and reconcile. Interrupted exposure is cleaned up and later accounts
remain flat. Protected-session restart preserves positions and orders with entries halted.
