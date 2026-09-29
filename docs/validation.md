# Validation report

Date: 2026-09-29. Scope: local simulation-only implementation, including post-fill protection.

| Check                      | Result                                                                             |
| -------------------------- | ---------------------------------------------------------------------------------- |
| Node runtime               | 24.19.0                                                                            |
| pnpm                       | 11.25.0                                                                            |
| Frozen lockfile install    | Passed; all six workspace projects current                                         |
| TypeScript strict checking | Passed                                                                             |
| ESLint                     | Passed                                                                             |
| Prettier check             | Passed                                                                             |
| Vitest                     | **96 tests passed, 6 files passed**                                                |
| Preview CLI                | Passed; all ten independently sized accounts displayed                             |
| JSON preview               | Passed                                                                             |
| Partial-failure CLI        | Seven filled, account 08 rejected, 09–10 blocked                                   |
| Gap CLI                    | Ten filled, then ten permanently breached after adverse synthetic gap              |
| Retry CLI                  | Identical recorded outcome; no second entry                                        |
| SQLite audit inspection    | Submission/fill/close/price/flatten/connect events present; 54 events in retry run |

## Test coverage

Gross formulas; decimal input validation; independent account sizing; costs; reserve,
margin, leverage and freshness rejection; varied-buffer safety invariant; long/short
wins; full-fleet stop losses; gap breach; partial close accounting; funding and funding
breach; withdrawals; disabled-account handling; controller and adapter deduplication;
payload conflicts; partial failures; ambiguous responses; timeouts; price drift; opposing
fleet exposure; false fill acknowledgements; concurrency and emergency halt; journal
restart; incomplete submission recovery gate; secret-field exclusion; malformed adapter
account identity.

The CLI initially hit a sandbox IPC restriction in the `tsx` executable. Scripts now
use `node --import tsx`, which runs TypeScript without that CLI IPC server. The actual
preview and scenario commands then passed; no sandbox escalation was used.

## Example preview

Synthetic NDX price 30,400, long, 80-point stop/target, 40% all-in risk, 50x leverage,
with the explicit example cost assumptions:

| Accounts   | Buffer | All-in budget | Quantity ($/point) | Notional, rounded for display |
| ---------- | -----: | ------------: | -----------------: | ----------------------------: |
| 01         | $14.55 |         $5.82 |           0.067228 |                     $2,043.73 |
| 02–10 each | $10.00 |         $4.00 |           0.046205 |                     $1,404.63 |

These are reproducible simulation results, not live quotes or trading recommendations.

## Not validated / not delivered

- No Vest credentials, live orders, authenticated API calls or private endpoint probes.
- No verified Instant API/copy authorization, live market symbol or market specifications.
- No exchange paper environment, small real account or multi-account real validation.
- No live adapter or remotely authenticated controller service.
- No persistent simulator state recovery, service multi-process coordination, operator reconciliation or re-arm workflow preserving balances.
  Dashboard flatten coordination and explicit new-simulation reset are implemented.

Next technical step: persistent simulator/reconciliation recovery and an operator re-arm
workflow within the local dashboard. Live integration remains gated by the facts
register and the user's requested pre-integration review.

## Dashboard follow-up

Added HTTP integration tests for the ten-account fixture; Host/Origin/token checks;
input validation; request identity replay; execution and flatten/halt; changed-state
rejection; stop/target processing; explicit session reset; and unsafe margin exposure.
Margin-allocation tests cover independent sizing, both requested presets, costs, percentage
bounds and reserve rejection. Actual browser checks and screenshots exercise the UI.

Browser smoke validation passed on desktop (1512 px) and mobile (390 px): preview,
long entry, flatten/halt, explicit reset, 50x/25% rejection, short entry and synthetic
market movement. No page JavaScript errors or horizontal page overflow remained.
PNG captures in `docs/images/` are from the running application. The browser was an
isolated test dependency; running the dashboard adds no browser automation dependency.

## Hedge-guard follow-up — 2026-09-29

Design and test expectations were updated first. The red run demonstrated the old
behavior still blocked disabled opposite exposure and lacked the shared policy module.
After implementing the simulation-only rule pipeline, `pnpm check` passed all gates:
**62 tests in five files**, including 13 new hedge unit/integration cases.

`tests/hedge-guard.test.ts` verifies mandatory enablement, flat accounts, same-direction
LONG/SHORT copying, NQ/NDX aliases, disabled exposure ignored, enabled unselected exposure
detected, full conflict rejection before submission, exposure changing after preview and
between children, independent mock enforcement, flatten despite a pre-existing hedge,
and a test-only additive correlated-rule fixture. The fixture is not enabled in production.
The earlier execution test asserting disabled exposure blocked entries was intentionally
replaced to match the user's new requirement. Existing disabled-account flatten coverage
remains. No live integration was added or exercised.

## Post-fill protection refactor — 2026-09-29

`pnpm format` and `pnpm check` passed: formatting, ESLint, strict TypeScript and
**96 tests in six files**. This adds 34 tests to the previous 62-test baseline.
The full hedge-guard suite remains unchanged and passes. The only changed simulator
win expectation moves the target quote one point with actual adverse entry slippage:
LONG 30,481 / SHORT 30,319 instead of preview-based 30,480 / 30,320.

New protection coverage includes:

- LONG/SHORT actual-fill anchors, including the exact 30,450.25 example and slippage
  divergence from preview; raw entry has no protection.
- Durable state/request recording before side effects; no success before both exits.
- SL and TP rejection, cleanup failure, delayed protection and journal-write failure;
  halt later children and preserve uncertain outcomes even when cleanup is flat.
- Authoritative recovery after lost responses; fabricated acknowledgements, missing
  ledger, wrong position, altered protection identity/size/price and inactive orders.
- SL triggering during establishment, before TP can be installed.
- Both exit directions, sibling cancellation, stale-order identity, reduce-only schema
  rejection and remaining-quantity caps after partial closes.
- Idempotent protection retries, changed-payload conflicts, terminal orders not revived;
  controller restart replay does not resubmit entries or protection.
- Flatten with unprotected, partially protected and protected positions, including
  disabled accounts; active-order evidence prevents a false flat report.
- Legacy journal result refusal and a halted controller on upgrade.

CLI smoke checks passed for LONG win and SHORT loss. Both independently established
10 protected entries, triggered all exits, produced the expected P&L direction and
reported all accounts flat afterward. JSON preview contains estimated SL/TP fields
for all ten accounts. Dashboard HTTP integration tests pass with the shared controller;
the browser now displays protection status and execution state. Earlier browser
screenshots document the preceding UI release; they were not regenerated for this change.

Unresolved integration gates: verified destination tick/trigger rules, request-to-venue
order mapping, genuine server-side reduce-only guarantees, cancellation races, late
request resolution, subscriptions and durable operator recovery. No live adapter,
live trading or undocumented endpoint access was added.
