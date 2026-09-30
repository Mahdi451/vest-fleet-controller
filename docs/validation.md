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
| Vitest                     | **155 tests passed, 8 files passed**                                               |
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
- Funded API use is now explicitly unavailable in the official FAQ. Browser/copy permission, live market mapping and market specifications remain unverified.
- No exchange paper environment, small real account or multi-account real validation.
- No live adapter or remotely authenticated controller service.
- No distributed coordination or operator re-arm workflow preserving balances. Durable local simulator restore, exclusive owner lock and operator/periodic reconciliation are now implemented. Dashboard flatten and explicit new-simulation reset remain available.

Next technical step: a reviewed operator recovery/re-arm workflow for resolved outcomes, then verified live transport capabilities. Live integration remains gated by the facts
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
the browser now displays protection status and execution state. Screenshots were subsequently refreshed for this state; see the visual refresh below.

Unresolved integration gates: verified destination tick/trigger rules, request-to-venue
order mapping, genuine server-side reduce-only guarantees, cancellation races, late
request resolution, subscriptions and durable operator recovery. No live adapter,
live trading or undocumented endpoint access was added.

## Visual refresh — 2026-09-29

Four actual application screenshots were regenerated after the protection refactor:
preview, ten protected LONG positions, mobile protected positions and rejected 50x/25%
margin allocation. The browser capture exercised preview, entry, flatten, reset and
risk rejection, asserted ten ACTIVE protections, and detected no page errors or mobile
page overflow. No execution code changed. A precise SVG/PNG lifecycle diagram and a
separately labeled generated logo concept were added. Reproduction instructions are
in [visual asset notes](visuals.md).

## Simulator beta hardening — 2026-09-29

Formatting, ESLint, strict type checking and the full suite pass: **124 tests in seven
files**, 28 more than the previous 96-test baseline. Existing hedge, protection,
idempotency, circuit, flatten and accounting cases remain green.

New coverage includes LONG/SHORT terminal partial fills and exact protection quantity,
unconfirmed remainders, actual-fill fee/reserve reassessment, health freshness and stage
metrics, manual closes/quantity changes, missing SL/TP, orphan cancellation, inventory
loss, disconnect/reconnect, reconciliation timeout and audit/persistence failure.

Durability coverage includes real child-process SIGKILL after entry fill and after SL
activation, restoration and fail-closed cleanup, persisted entry/SL/TP deduplication,
configuration/schema rejection, exclusive-owner/stale locks, missing journal/snapshot
refusal, and HTTP dashboard restart with protected positions plus archived-session reset.
Health and authenticated reconciliation endpoints and periodic scans are also exercised.

No WebSocket/429/signing tests are claimed: those transports do not exist. No live
adapter, credentials, private endpoints or real orders were introduced. See the
[17-item audit](reliability-audit.md) for the precise remaining boundaries.

## Browser architecture change and fixture validation — 2026-09-29

The complete suite passes **155 tests in eight files**, including **31 browser/journal
cases** added to the 124-test baseline. Formatting, ESLint and strict TypeScript pass.
Playwright 1.62.1 is pinned as a development dependency. Chromium interacted with original
local fixtures only, with network requests blocked and no persistent profile or credentials.
The production simulator dashboard still uses MockVestAdapter.

Executed locally with the existing Chromium binary:

```sh
BROWSER_TEST_EXECUTABLE=/tmp/vest-visuals/chromium pnpm check
```

For a normal checkout, install Chromium using `pnpm exec playwright install chromium`,
then run `pnpm check` without that environment variable.

Coverage includes:

- LONG/SHORT actual-fill-relative SL/TP and full ten-account sequential execution with
  independent quantities; master retry replay without new clicks.
- Wrong selection, changed context after form preparation, changed account snapshot,
  form tampering, stale/missing/duplicate visible evidence and non-fixture rejection.
- SL/TP rejection, missing protection evidence, terminal and pending partial fills,
  lost submission response, drift before a later entry and drift detected after fill.
- Protection and cancel deduplication, conflicting fingerprints, durable-before-click
  write failure, manual close detection, concurrent-execute refusal and preserved hedge guard.
- Closed page and stalled action after fill; uncertainty/cleanup failure remains explicit.
- New browser context plus reopened disk journal after interruptions following entry
  and SL creation. Recover saved simulator books, flatten unsafe exposure, preserve halt,
  and verify no redispatched entry. These are browser-context recovery tests, not new
  process-kill tests; the prior real SIGKILL tests remain in the full suite.
- An unfinished durable browser action halts recovery even without a master trade row.

Public FAQ and terms were inspected read-only in Work Browser. The browser was signed
out; the actual funded account selector, cross-tab behavior and execution controls were
not tested. Passing local fixtures is not evidence of Vest permission or live compatibility.
No real or venue-hosted paper order was placed.
