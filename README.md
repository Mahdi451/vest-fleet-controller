# Vest Fleet Controller

**One trade intent. Independent account risk. Explicit execution outcomes.**

A local TypeScript tool for managing a fleet of Vest Capital accounts, previewing
risk-adjusted orders, and testing execution behavior before any supported live integration.
The initial fleet models **10 × $500 Instant funded accounts**.

> **Current release: simulation only.** Prices and accounts are synthetic. There is no
> live Vest adapter, authenticated market feed, dashboard, or credential setup.
> The code cannot send a live Vest trade.

## Contents

- [What the tool does](#what-the-tool-does)
- [Architecture](#architecture)
- [Quick start](#quick-start)
- [Trade previews](#trade-previews)
- [How account risk works](#how-account-risk-works)
- [Execution and failure handling](#execution-and-failure-handling)
- [Simulator scenarios](#simulator-scenarios)
- [Configuration](#configuration)
- [State, logs and restart behavior](#state-logs-and-restart-behavior)
- [Repository structure](#repository-structure)
- [Verification and development](#verification-and-development)
- [Roadmap and live integration gates](#roadmap-and-live-integration-gates)
- [Troubleshooting](#troubleshooting)
- [Further reading](#further-reading)

## What the tool does

Copying the same order size into every account assumes the accounts have the same
risk capacity. This tool calculates each account's order separately, using its own
equity, failure floor, costs and remaining buffer.

| Capability        | Current implementation                                                                    |
| ----------------- | ----------------------------------------------------------------------------------------- |
| Account inventory | Balance, equity, P&L, floor, buffer, leverage, positions, status and synchronization time |
| Trade intent      | Direction, market entry, stop/target distance, risk mode/value and leverage               |
| Risk sizing       | Fixed dollar budget, percentage of remaining drawdown, or fixed notional                  |
| Cost model        | Entry/exit fees, adverse slippage, funding allowance and account-specific costs           |
| Preview           | Per-account size, notional, estimated loss, remaining buffer and rejection reasons        |
| Execution         | Sequential mock dispatch with fresh validation before each child order                    |
| Reconciliation    | Compare acknowledgement, order ledger and protected position                              |
| Retry protection  | Deterministic child IDs and SQLite records written before submission                      |
| Emergency control | Block new entries, attempt flattening every account, then verify positions                |
| Simulation        | Ten independent accounts, price changes, stops/targets, costs, breaches and failures      |
| Observability     | Structured, allowlisted audit records and explicit unknown outcomes                       |

The account manager currently lives in the validated account model and mock adapter.
The CLI demonstrates the engine; it is not a continuously running trading service.

## Architecture

The core model and risk calculations have no Vest network dependency. Both the
simulator and any future permitted adapter must use the same trade intent and risk engine.

```mermaid
flowchart TD
    CLI["Preview and simulation CLI"] --> Controller["Fleet controller"]
    Controller --> Risk["Independent risk calculations"]
    Risk --> Core["Validated account and trade models"]
    Controller --> Journal["SQLite execution journal"]
    Controller --> Adapter["ExecutionAdapter interface"]
    Adapter --> Mock["MockVestAdapter: implemented"]
    Adapter -. "future; approval and verification required" .-> Live["Official API or native copier"]
    Mock --> Core
```

**Stack:** Node 24, TypeScript, pnpm, Zod, decimal.js, SQLite, Vitest, ESLint and
Prettier. The small workspace shares a root toolchain and uses direct TypeScript
imports between packages. React/Vite and a local HTTP service are later milestones.

## Quick start

### Prerequisites

- Node.js **24.x**; initial validation used **24.19.0**.
- pnpm **11.25.0**, matching `packageManager` in `package.json`.
- A terminal in the project directory. No Vest login or API key is required.

Clone the private repository with your authenticated GitHub account:

```sh
git clone https://github.com/Mahdi451/vest-fleet-controller.git
cd vest-fleet-controller
```

If you have the downloaded archive, extract it and enter `vest-fleet-controller/`.
It contains a `history.bundle`; the archive's `RESTORE.txt` explains how to restore
Git history when needed. If you have a repository checkout, use its root directory.

### Install, verify and preview

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm preview
```

`pnpm check` runs strict TypeScript checking, ESLint, formatting checks and tests.
`pnpm preview` calculates orders but does not submit even mock entries.

### Run an isolated simulation

```sh
pnpm simulate --scenario win
pnpm simulate --scenario partial-failure
pnpm simulate --scenario retry
```

Every CLI invocation creates a **new simulated fleet** and a separate local journal.
Running another command does not resume the previous simulation's balances or positions.

## Trade previews

A `TradeIntent` expresses the desired trade before per-account sizing:

```ts
{
  symbol: 'NDX',
  side: 'LONG',
  entryType: 'MARKET',
  stopDistancePoints: '80',
  takeProfitPoints: '80',
  riskMode: 'PERCENT_DRAWDOWN',
  riskValue: '40',
  leverage: '50'
}
```

`NQ` is the familiar display label. **`NDX` is an internal simulation symbol**;
`NDX-USD-PERP` has not been verified as the correct supported Capital API mapping.
This model represents a linear perpetual derivative, not a CME futures contract.

### Examples

```sh
# Short, $4 all-in risk, 60-point stop and 80-point target
pnpm preview --price 30400 --side SHORT --stop 60 --target 80 --mode FIXED_DOLLAR --risk 4

# $3,000 requested notional per account; unsafe accounts can be rejected
pnpm preview --mode FIXED_NOTIONAL --risk 3000

# A smaller percentage of each account's own remaining drawdown
pnpm preview --mode PERCENT_DRAWDOWN --risk 20

# Full machine-readable preview, including cost breakdown and rejection reasons
pnpm preview --json

# Use another assumption profile
pnpm preview --config config/example.yaml
```

| Option       | Default               | Meaning                                                                  |
| ------------ | --------------------- | ------------------------------------------------------------------------ |
| `--price`    | `30400`               | Synthetic quote; never fetched from a live feed                          |
| `--side`     | `LONG`                | `LONG` or `SHORT`                                                        |
| `--stop`     | `80`                  | Stop distance in index points                                            |
| `--target`   | `80`                  | Take-profit distance in index points                                     |
| `--mode`     | `PERCENT_DRAWDOWN`    | `FIXED_DOLLAR`, `PERCENT_DRAWDOWN` or `FIXED_NOTIONAL`                   |
| `--risk`     | `40`                  | Dollars, percent or notional according to mode; `40` means 40%, not 0.4% |
| `--leverage` | `50`                  | Requested leverage, checked against configuration and margin             |
| `--config`   | `config/example.yaml` | YAML cost and safety assumptions                                         |
| `--json`     | off                   | Full preview JSON; simulation commands also print subsequent results     |
| `--scenario` | `win`                 | Scenario applied by `simulate`                                           |

### Example output

At synthetic price **30,400**, long, 80-point stop/target, 40% all-in risk and the
example cost configuration:

| Accounts    | Balance | Floor | Buffer | All-in budget | Quantity / $ per point | Notional* |
| ----------- | ------: | ----: | -----: | ------------: | ---------------------: | --------: |
| 01          | $504.55 |  $490 | $14.55 |         $5.82 |               0.067228 | $2,043.73 |
| 02–10, each | $500.00 |  $490 | $10.00 |         $4.00 |               0.046205 | $1,404.63 |

\* Notional is rounded for display. Calculations retain decimal precision. These
are reproducible simulation examples, not current quotes or suggested trade sizes.

## How account risk works

### Start with the available buffer

```text
Effective floor = max(fixed drawdown floor, supplied daily-loss floor)
Equity = balance + unrealized P&L
Remaining drawdown = max(0, equity − effective floor)
```

The mock uses the observed $490 fixed floor. A supplied daily-loss floor can make
risk stricter; automatic daily-limit resets are not implemented because the applicable
Instant rules and reset semantics are unverified.

### Convert risk into position size

For price P, notional N and stop distance S:

```text
Dollars per point = N / P
Gross stop loss = (N / P) × S
Notional for gross risk R = R × P / S
```

For P=30,400, R=$4 and S=60, the gross formula gives approximately **$2,026.67**.
That is before costs. The executable sizing calculation reserves costs inside the
risk budget, so its approved notional is smaller.

| Mode                   | Calculation                                                                     |
| ---------------------- | ------------------------------------------------------------------------------- |
| Fixed dollar           | Input is the total planned loss budget, including costs                         |
| Percentage of drawdown | Budget = that account's buffer × percentage / 100                               |
| Fixed notional         | Convert requested notional to quantity, then validate its total loss and margin |

Stop distance is required in all modes. Leverage changes estimated margin requirements;
it does not change dollars per point when notional stays the same.

### Include costs before approval

```mermaid
flowchart TD
    Input["Intent, quote and account snapshot"] --> Valid{"Fresh, active, enabled and flat?"}
    Valid -->|No| Reject["Reject with a reason"]
    Valid -->|Yes| Size["Calculate quantity and round down"]
    Size --> Loss["Stop loss + fees + slippage + funding + fixed costs"]
    Loss --> Reserve{"Enough margin and remaining reserve?"}
    Reserve -->|No| Reject
    Reserve -->|Yes| Approve["Approve account preview"]
```

The default reserve is **$2 after the planned loss**. A $9 loss budget against a $10
buffer is rejected: it would leave only $1. Reaching the failure floor is rejected even
if the configured reserve is zero. Quantities always round down to the configured step.

A 40% budget against a $10 buffer allocates up to $4 to stop loss and costs, leaving
approximately $6 under the modeled assumptions. It does not guarantee that a gap,
unbounded funding charge or future venue failure cannot lose more.

See [the full risk model](docs/risk-model.md) for the cost coefficient, rounding,
account overrides and margin assumptions.

## Execution and failure handling

The controller stores a preview, then rechecks each participating account before
submitting its independently sized child order. Dispatch is sequential in this release.
A child may not grow beyond the preview quantity.

```mermaid
stateDiagram-v2
    [*] --> Previewed
    Previewed --> Rejected: invalid or stale
    Previewed --> Submitting: journal before dispatch
    Submitting --> Filled: ledger and protected position match
    Submitting --> Rejected: confirmed rejection and flat state
    Submitting --> Unknown: timeout or conflicting evidence
    Unknown --> Filled: immediate reconciliation succeeds
    Unknown --> Halted: outcome unresolved
    Filled --> Flat: close and verify
```

An account rejected during preview is skipped. An unexpected failure on a previously
approved account halts the remaining dispatch. Existing successful fills are not
silently rolled back; their simulated stop/target protection remains active.

| Example event                                        | Controller behavior                                                      |
| ---------------------------------------------------- | ------------------------------------------------------------------------ |
| Accounts 01–07 fill, 08 rejects                      | Record seven fills and the rejection; do not send entries to 09–10       |
| Response times out                                   | Keep outcome unknown; block further entries; do not automatically resend |
| Response is ambiguous, but ledger and position agree | Reconcile to filled without a second entry                               |
| Same master ID and same preview are retried          | Return the recorded result without resubmission                          |
| Same master ID is reused for another preview         | Reject the identity conflict                                             |
| Price or account state changes after preview         | Revalidate; reject if the preview is no longer safe                      |
| Another account holds the opposite direction         | Block new opposing exposure, including when that account is disabled     |
| A response names the wrong account                   | Preserve the requested identity, mark unknown and halt                   |

A historical `FILLED` result is not a current-position query. An exact replay can
still return the original fill after that position has been closed.

### Emergency flatten

`FleetController.flattenAll()` latches the entry circuit, includes disabled accounts,
attempts every account, and reads positions afterward. An account with an unresolved
submission remains `UNKNOWN` even if its current position snapshot is empty.

**Current limitation:** if execution is already in progress, flatten latches the halt
but returns `EXECUTION_IN_PROGRESS_RETRY_FLATTEN`. It must be called again after the
bounded operation completes. A queued emergency workflow is required before a live
service or dashboard can claim reliable single-action emergency handling.

There is no standalone interactive flatten CLI yet. Scenario commands exercise the
controller's flatten operation at the end of the run.

## Simulator scenarios

Run `pnpm simulate --scenario <name>`. All scenarios use the same domain and risk logic.

| Scenario          | What happens                                              | What it demonstrates                                 |
| ----------------- | --------------------------------------------------------- | ---------------------------------------------------- |
| `win`             | Price moves to the target                                 | All-account favorable exit and net accounting        |
| `loss`            | Price moves to the stop                                   | Planned loss and configured execution costs          |
| `partial-failure` | Account 08 rejects                                        | Partial success and halted remaining dispatch        |
| `ambiguous`       | Account 10 fills but returns an uncertain acknowledgement | Reconciliation without duplicate entry               |
| `timeout`         | Account 09 returns an unresolved timeout                  | Unknown state and blocked account 10                 |
| `disabled`        | Account 10 is disabled before preview                     | Nine participating accounts                          |
| `gap`             | Price jumps adversely by five stop distances              | Loss can exceed the planned stop and breach accounts |
| `retry`           | The same master request is executed twice                 | Recorded replay without increasing exposure          |

After execution, each scenario applies its price move and calls emergency flatten.
This is a finite demonstration, not an interactive session. The tests additionally
exercise partial closes, signed funding, withdrawals, stale snapshots, true hanging
adapter calls and controller restart against an existing journal.

Funding settlement and profit withdrawals are available through the mock's programmatic
methods. Funding is explicitly applied as a scenario rate and duration; it does not
accrue automatically with wall-clock time. Withdrawals debit gross profit and calculate
the supplied share, while retaining the assumed fixed floor.

## Configuration

`config/example.yaml` contains **simulation assumptions**, not an official Vest fee schedule.
All decimal fields must be quoted strings; time limits are integer milliseconds.

| Setting                             | Example      | Meaning                                                               |
| ----------------------------------- | ------------ | --------------------------------------------------------------------- |
| `entryFeeRate`                      | `'0.000025'` | 0.0025% entry fee; user-observed, not officially verified             |
| `exitFeeRate`                       | `'0.000025'` | 0.0025% exit fee; user-observed, not officially verified              |
| `slippagePointsPerSide`             | `'1'`        | Adverse index points allowed at each execution                        |
| `fundingRateAllowance`              | `'0.0001'`   | Conservative funding fraction for the entire planned holding period   |
| `accountCost`                       | `'0'`        | Additional fixed cost per entry                                       |
| `minimumRemainingDrawdownAfterStop` | `'2'`        | Required remaining dollar buffer after planned loss                   |
| `sizeStep`                          | `'0.000001'` | Simulation quantity increment; actual market specification unverified |
| `maxLeverage`                       | `'50'`       | Configured leverage ceiling                                           |
| `maxDataAgeMs`                      | `5000`       | Maximum accepted account/quote age                                    |
| `maxPreviewAgeMs`                   | `5000`       | Maximum accepted preview age                                          |
| `maxPriceMovePoints`                | `'5'`        | Maximum quote movement from the preview before rejection              |

Account-specific fee and fixed-cost overrides are supported in the Account model.
Increasing fees or funding allowance reduces size for a fixed all-in budget. It does
not increase the allowed loss to preserve an earlier size.

## State, logs and restart behavior

| Data                           | Storage                    | Survives process exit? |
| ------------------------------ | -------------------------- | ---------------------- |
| Account balances and positions | Mock adapter memory        | No                     |
| Mock order ledger              | Mock adapter memory        | No                     |
| Preview objects                | Controller memory          | No                     |
| Master/child execution records | `.runtime/<run-id>.sqlite` | Yes                    |
| Structured audit events        | Same SQLite database       | Yes                    |
| Configured assumptions         | YAML and source control    | Yes                    |

SQLite records the child as submitting/unknown **before** invoking the adapter.
An unfinished master or unknown child halts a new controller using that journal.
There is no automatic recovery or circuit-reset workflow in this release.

Audit records include timestamp, trade/account/request IDs, direction, requested and
filled quantity, protection levels, fees, status, error code, adapter and latency.
Simulator mutation events also cover price changes, funding, withdrawals and closes.
The logger uses an allowlist and fixed error codes instead of raw request or exception dumps.

The repository ignores runtime databases, `.env` files, logs, keys, dependencies and
build output. No credentials are needed, collected or committed. `.env.example` contains
comments only. A private repository is still not a place to store credentials.

## Repository structure

| Location                               | Responsibility                                                        |
| -------------------------------------- | --------------------------------------------------------------------- |
| `apps/controller/src/cli.ts`           | Command parsing, preview output and scenario execution                |
| `packages/core/src/index.ts`           | Decimal primitives, schemas, account state and initial fleet          |
| `packages/risk-engine/src/index.ts`    | Pure sizing, cost estimates and safety checks                         |
| `packages/execution/src/adapter.ts`    | Execution interface and response validation                           |
| `packages/execution/src/controller.ts` | Preview, dispatch, reconciliation and emergency control               |
| `packages/execution/src/journal.ts`    | SQLite identity records, circuit state and audit                      |
| `packages/simulator/src/index.ts`      | Mock adapter, fills, price/funding updates and withdrawals            |
| `tests/risk.test.ts`                   | Formulas, sizing and risk boundaries                                  |
| `tests/simulator.test.ts`              | Position accounting and simulator behavior                            |
| `tests/execution.test.ts`              | Failures, retry protection, reconciliation and restart cases          |
| `config/example.yaml`                  | Cost and safety assumptions                                           |
| `docs/`                                | Evidence register, architecture, risk/execution models and validation |

There is no empty dashboard or live-adapter shell. Add those packages when the relevant
milestone begins. Keep `main` simple; use `feature/*` when a change benefits from isolation.

## Verification and development

The initial implementation passed **40 tests in three files**, strict TypeScript checks,
ESLint and formatting checks. See [validation results](docs/validation.md) for the tested
runtime, CLI checks and limits. This is a dated validation result, not a live CI badge.

```sh
pnpm test          # Run the test suite
pnpm typecheck     # Check strict TypeScript types
pnpm lint          # Run ESLint
pnpm format        # Apply formatting
pnpm format:check  # Check formatting without changing files
pnpm check         # Run all validation gates
```

Useful invariants to preserve when extending the tool:

1. A retry cannot add another position.
2. Unknown execution is never interpreted as success or safely flat.
3. Every child is sized from its own account state.
4. Approved planned loss leaves the configured buffer under modeled assumptions.
5. Fees, funding and withdrawals are accounted for once.
6. Breached accounts never become active again merely because price recovers.
7. Journal-write failure cannot be ignored to continue submitting orders.

## Roadmap and live integration gates

| Milestone            | Status                                         | Next requirement                                                                  |
| -------------------- | ---------------------------------------------- | --------------------------------------------------------------------------------- |
| M0: research         | Evidence register exists; key facts unresolved | Verify current Instant rules and supported execution                              |
| M1: core             | Implemented                                    | Extend only with verified rule/instrument metadata                                |
| M2: simulator        | Initial version implemented                    | Persist simulator snapshots and deterministic recovery                            |
| M3: controller       | Initial version implemented                    | Operator reconciliation and queued emergency handling                             |
| M4: dashboard        | Planned                                        | Local fleet table, previews and prominent emergency controls                      |
| M5: Vest integration | Deliberately blocked                           | Officially documented or explicitly permitted execution path                      |
| M6: validation       | Unit/integration/simulator stages only         | Paper environment if available, then separately authorized staged real validation |

Possible future adapters are `VestOfficialApiAdapter` and `VestNativeCopierAdapter`.
A native copier must support the required independent follower sizing before it can
claim the same risk guarantees. Unsupported capabilities must fail explicitly.

Before implementing either adapter, verify funded-account limits, Instant inclusion,
automation/copy permissions, native copier status, authentication, symbol and market
increments, drawdown/daily limits, costs, funding, payouts, leverage, hedging restrictions,
termination rules, rate limits and server-side order protection/retry behavior.

Do not use undocumented/private endpoints for live execution or assume the standard
Vest exchange API supports Capital accounts. Account observations belong in the
[evidence register](docs/vest-facts.md), with their uncertainty preserved.

Other current limits: one synthetic market, one net position per account, no order book,
no partial entry fills, no maintenance-margin liquidation model, no trading calendar,
no multi-process coordination, no pyramiding/reversal and no live market data.

## Troubleshooting

| Symptom                                           | Meaning / next action                                                                         |
| ------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `COMMAND_FAILED`                                  | Check option names, allowed modes and quoted decimal values in YAML; run `pnpm check`         |
| `DRAWDOWN_RESERVE`                                | Planned loss leaves too little buffer; reduce risk or omit that account                       |
| `INSUFFICIENT_MARGIN`                             | Estimated margin plus entry costs exceeds available cash/equity                               |
| `STALE_ACCOUNT`, `STALE_QUOTE`, `PREVIEW_EXPIRED` | Obtain fresh state and a new preview; do not blindly resend                                   |
| `EXISTING_POSITION`                               | Initial implementation requires a flat destination account                                    |
| `OPPOSING_FLEET_POSITION`                         | Another account has opposite-direction exposure, even if disabled                             |
| `IDEMPOTENCY_CONFLICT`                            | An existing master/request ID was reused with a different payload                             |
| `UNKNOWN` or `RECONCILIATION_REQUIRED`            | Preserve the journal and reconcile the outcome; do not retry entry                            |
| `EXECUTION_IN_PROGRESS_RETRY_FLATTEN`             | Entry halt is latched; call flatten after the active operation completes                      |
| A new CLI run shows starting balances             | Expected: each command starts an isolated simulation                                          |
| A stop loses more than expected                   | The current synthetic quote can gap through the stop; fills are not guaranteed at the trigger |

The CLI uses Node's `--import tsx` loader so it does not depend on the separate `tsx`
CLI's IPC listener. Use the documented pnpm scripts in restricted execution environments.

## Further reading

- [Combined project specification and milestones](docs/project-plan.md)
- [Vest facts: confirmed, likely, unverified and contradicted](docs/vest-facts.md)
- [Architecture and major assumptions](docs/architecture.md)
- [Detailed risk calculations](docs/risk-model.md)
- [Execution and reliability model](docs/execution-model.md)
- [Simulator behavior and boundaries](docs/simulator.md)
- [Initial validation report](docs/validation.md)
