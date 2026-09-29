# Simulator behavior

Each new run starts Account 01 at $504.55 and Accounts 02–10 at $500, with $490 fixed
floors. Account snapshots are defensive copies. Account IDs are unique and balances
diverge naturally with quantity, fills, fees, withdrawals and disabled state.

| Operation         | Behavior                                                                                                         |
| ----------------- | ---------------------------------------------------------------------------------------------------------------- |
| Market entry      | Re-runs the shared risk engine, checks account/fleet safety and deduplicates request ID                          |
| Fill              | Current synthetic quote plus adverse per-side slippage; charges entry fee and fixed account cost                 |
| Leverage          | Per-order leverage recorded; estimated initial margin checked by risk engine                                     |
| Protection        | Stop/target attached atomically in the mock, anchored to decision quote                                          |
| Market update     | Mark unrealized P&L and equity, detect breach and stop/target crossing                                           |
| Stop/target       | Close at current synthetic market price plus adverse slippage, not a guaranteed trigger price                    |
| Partial close     | Realize proportional P&L and exit fee, preserve the remainder and protection                                     |
| Funding           | Explicit signed hourly-rate × hours scenario; positive rates debit longs and credit shorts                       |
| Breach            | Equity at/below effective floor permanently marks breached; open positions close at current simulated price      |
| Withdrawal        | Flat active account only, within realized profit and reserve; debit gross and report explicit split's net payout |
| Emergency flatten | Controller attempts all accounts, including disabled, and rechecks positions                                     |

Available CLI scenarios: `win`, `loss`, `partial-failure`, `ambiguous`, `timeout`,
`disabled`, `gap`, `retry`. Each uses the same TradeIntent and risk engine.

The test suite additionally exercises funding, partial closes, profit withdrawal,
price movement between children, adapter timeout, journal restart, stale state and
cross-account opposing positions. A failure in one account does not modify another
account's balance. Circuit-breaker policy may prevent later accounts from participating.

## Model boundaries

- This is a deterministic quote-driven simulator, not a backtest engine or Vest replica.
- It models one net position per account and one synthetic linear market.
- Equity uses the supplied synthetic quote; bid/ask spread is represented only through
  configured slippage. There is no order book, queue, liquidity/partial entry fill model,
  maintenance-margin liquidation formula, trading calendar or real market feed.
- There is no automatic funding clock or Vest payout API. Withdrawal semantics are
  assumptions for experimentation, not promises about current Vest rules.
- Stops are atomic only inside the mock. Live protection capabilities must be verified.
- A price gap or funding charge beyond the configured allowance can breach an account.
- The adapter's account/order state is in memory. A controller can reopen its SQLite
  journal against the same adapter; a new CLI invocation is a new isolated simulation.
- Full replayable simulator persistence and UI emergency recovery remain later work.
