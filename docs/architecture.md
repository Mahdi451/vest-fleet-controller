# Architecture

Status: initial implementation, simulation-only. Decision date: 2026-09-29.

The domain and risk engine contain no Vest transport knowledge. A `TradeIntent`
describes direction, market entry, stop/target distances, risk allocation and leverage.
The controller retrieves per-account state, calculates a preview, and independently
revalidates each child before dispatch through an `ExecutionAdapter`.

```mermaid
flowchart TD
  UI[CLI and local dashboard] --> Fleet[Fleet controller]
  Fleet --> Risk[Pure risk engine]
  Risk --> Domain[Validated domain types]
  Fleet --> Journal[SQLite journal and audit]
  Fleet --> Port[ExecutionAdapter]
  Port --> Mock[MockVestAdapter]
  Port -. future gated implementation .-> Official[Official API or native copier]
  Mock --> Domain
```

Node 24, TypeScript, pnpm, Zod, decimal.js, Vitest, ESLint and Prettier provide a
small reproducible toolchain. SQLite uses Node's built-in API. The first local dashboard
uses Node HTTP plus plain browser JavaScript/CSS, avoiding an extra frontend build step.
The user requested leverage/allocation controls after the CLI delivery. React/Vite remains
an optional later UI implementation, not a dependency for running the current dashboard.

## Component ownership

| Component       | Current responsibility                                                                 | Later extension                                                             |
| --------------- | -------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| Account manager | Validated account snapshots; adapter inventory, enable state, fixed floor              | Durable fleet metadata and explicit sync service                            |
| Risk engine     | Decimal formulas, all-in loss, size rounding, reserve, freshness, margin               | Verified instrument and account rule policies                               |
| Controller      | Selection, preview, sequential fan-out, idempotency, reconciliation, circuit halt      | Recovery UI, bounded concurrency only after rate-limit verification         |
| Adapter         | Simulation-only capability contract                                                    | Official supported transport or native copier                               |
| Simulator       | Independent accounts, protected fills, costs, funding scenarios, withdrawal and breach | Deterministic event replay, persistent simulator snapshots, liquidity model |
| Journal         | Durable master/child attempts and allowlisted audit events                             | Schema migrations, recovery reconciliation service                          |
| Dashboard       | Local simulation controls                                                              | Price, fleet table, master controls, per-account preview, prominent flatten |

## Major assumptions and decisions

1. Fixed $490 floors, Instant fees, and 95% withdrawal share are observations, not
   verified current rules. The share is an explicit withdrawal parameter.
2. Fixed-dollar and drawdown budget inputs represent all-in planned loss. Margin-percent
   inputs allocate min(balance, equity) as margin, multiplied by leverage for exposure. The original gross sizing formulas
   remain separate tested functions. No hidden leverage multiplier changes P&L.
3. The internal product is a linear synthetic `NDX`, one unit = $1/point. No external
   symbol, quantity step, contract multiplier or liquidation formula is certified.
4. All new entries require flat accounts. Same-direction additions and reversals are
   rejected; partial closes are supported by the mock. Opposite fleet positions are
   blocked conservatively pending verification of Vest's hedging rules.
5. Daily-loss floor may be supplied, and the stricter floor wins. Automatic daily
   reset logic is deferred because Instant applicability and baseline are unresolved.
6. Sequential dispatch simplifies the initial safety model and allows revalidation
   between children. First unexpected failure halts further dispatch. This deliberately
   does not produce every possible error in a single ten-account run; independent
   scenarios test reject, timeout and ambiguous-after-fill responses.
7. Breach is permanent in a simulation run. Equity at or below the effective floor
   breaches and closes positions at the current simulated price plus adverse slippage.
8. Simulator state is in memory; audit and deduplication records are durable. Restarting
   the adapter is a new simulation, not resuming the same account reality.
9. Circuit halts have no automatic reset. There is no live credential or execution mode
   flag that can turn this prototype into a funded-account trader.
10. Leverage is checked as a configurable ceiling and margin requirement; venue-specific
    liquidation, maintenance margin, funding schedules and server protective orders are M5 gates.

## Future adapter contract

Future implementations may be named `VestOfficialApiAdapter` and
`VestNativeCopierAdapter`. Both must provide verified account scoping, market metadata,
authoritative reconciliation, protection status, request identity and emergency close
semantics. A native copier may not support independent follower sizing: if so it cannot
claim compatibility with this controller's risk guarantees. Capability negotiation and
explicit refusal are preferable to silently weakening the risk model.

Methods for cancellation, explicit leverage changes and subscriptions should be added
when a supported implementation needs them. Current market entries are immediately
filled/rejected/unknown; fake no-op cancellation methods would imply safety that is absent.

## Local dashboard boundary

`apps/dashboard/server.ts` binds only to 127.0.0.1. Requests require the exact Host;
provided Origins must match. Mutations require a process-specific token and JSON body,
with Zod validation and a 16 KiB body limit. No CORS, no live transport, no remote login.
Static files are allowlisted and served with a restrictive content security policy.

Mutations are serialized or rejected while busy. Flatten latches the controller halt
immediately, waits for the active bounded operation, then closes and reconciles accounts.
Preview refresh updates the **synthetic** quote; no real market freshness is implied.
Previews expire after the configured five seconds and are invalidated by UI changes.
The client preserves request identity during execution and blocks new entries on lost
responses. Session IDs prevent old browser requests from trading after a simulator reset.

Dashboard sessions retain balances in memory until reset/exit. Each new session gets a
new SQLite journal. There is no persistent simulator restore or re-arm of a halted session.
