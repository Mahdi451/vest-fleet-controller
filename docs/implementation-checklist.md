# Vest Fleet implementation checklist

Build an independently implemented, private/local, event-driven Vest copier:
Account 01 leads; ready Accounts 02–10 execute independently and quickly. Preserve
risk and security controls without requiring one follower to finish before another
starts. Better Vest is behavioral reference only; do not copy its protected source.

This is the working checklist. [Fan-out design](fanout-adoption-plan.md) explains the
architecture; [proof reporting](functional-proof-goal.md) explains automated evidence.
This plan supersedes earlier strict sequential follower requirements.

## How we check off work

- `[x]` means implemented, relevant validation passed and the diff reviewed. For
  consequential changes, resolve independent review findings before checking off.
- `[ ]` means unfinished or not sufficiently proven. Partial work stays unchecked.
- Record evidence under each completed phase: files, exact commands/results, review
  outcome, date and remaining limits. Reopen affected items when requirements change.
- Run `pnpm verify:functional` at integrated milestones. Enable a gate's checks only
  after its actual acceptance cases exist and pass; a green unrelated suite is insufficient.
- Fixture results prove offline behavior only. Real provider evidence, human review
  and funded-test authorization remain separate. No checkbox or report arms trading.
- All current tests run in the background. No foreground windows, Vest charts, live
  trades, browser-profile changes or commits/pushes are side effects of this checklist.

## 0. Retained foundation

- [x] Existing per-account risk engine: sizing, drawdown reserve and leverage limits.
- [x] Existing enabled-account hedge guard for observed positions.
- [x] Durable execution journal and offline duplicate/lost-response recovery coverage.
- [x] Restricted inert build, security checks and local proof reporter.
- [x] Identify sequential bottlenecks and document the new fan-out architecture.
- [ ] Prove these foundations in the concurrent copier. Existing sequential tests
      and synthetic authority are not production fan-out proof.

Evidence: `risk.test.ts`, `hedge-guard.test.ts`, `offline-bridge.test.ts`,
`security-policy.test.ts`, `security-build.test.ts`, `verification-report.test.ts`.
Historical six-command pass: local report
`dist/functional-proof-0f2e9b45-ffa3-4e41-95b8-4b63bf5700a5/report.json`.
Its source predates this plan and the unfinished channel prototype; rerun before
claiming a current integrated pass. No live capability is proven.

Current supporting validation: seven focused suites passed 127 tests (risk, hedge guard,
offline bridge, journal history, security policy/build and report validator). The updated
39-gate catalog validates; synthetic green command results leave all five new fan-out
gates UNPROVEN and live LOCKED. This is not a new full verification report.

## 1. Event identity, journal and outcome model

- [x] Define normalized leader entry/add/reduce/close and TP/SL-change events with
      stable provider identity, account/symbol scope and observation generation.
- [x] Persist leader events and follower commands/attempts in the existing Journal.
      Bind immutable payload hashes; claim atomically before dispatch.
- [x] Separate entry certainty, fill state, stop state, target state and exposure
      PRESENT/ABSENT/UNKNOWN. Include intended side/quantity, fill price and reason.
- [x] Separate account-local blockers from global halt state; preserve historical rows.
- [x] Add per-event exit/skip dispositions so snapshots, reloads and reconciliation
      never reopen stopped/manual-closed/liquidated/breached/flattened/skipped followers.
- [x] Define explicit retry eligibility: conclusively rejected/not sent, no outstanding
      remainder or possible late fill. UNKNOWN is reconcile-only; retries are linked attempts.
- [x] Test duplicate/changed/reordered events, competing claims, SQLite restart at
      claim/send boundaries, retry eligibility and every no-reopen condition.

Evidence: `packages/execution/src/copier-events.ts`, `copier-records.ts`, additive
`journal.ts` integration and `tests/copier-records.test.ts`: 61 focused tests pass.
Type checking, lint and security checks pass; independent review findings resolved.
See [record-layer contracts and limits](copier-event-records.md).

Completed here means synthetic record-layer behavior, not a live provider event source
or dispatch capability. Account-local/global separation applies to the new records;
the legacy controller remains unchanged. `OFF-EVENTS` now has regression evidence;
`OFF-DRIFT` stays unproven until the concurrent dispatcher obeys these records.
Integrated verification (2026-10-05): `pnpm verify:functional` passed all six checks,
including the full offline regression suite. Current report:
`dist/functional-proof-02c4a5d5-6098-46a4-a62b-28f1fc2ba155/report.json`.
The source fingerprints match, `OFF-EVENTS` passes, and live remains LOCKED with
`functional=false`. The initial integrated run exposed eager table creation breaking
strict legacy recovery; lazy schema activation fixed it, and all 79 focused copier,
legacy-adoption and dashboard-command tests passed before the integrated rerun.

## 2. Independent follower fan-out

- [ ] Extract the existing single-account lifecycle from `FleetController.execute()`;
      reuse risk/protection logic with one execution owner.
- [ ] Replace the shared account loop/bridge queue with independent account lanes.
      Keep conflicting operations ordered within each account.
- [ ] Start all ready follower commands without awaiting another follower's fill
      or protection. Collect and publish each outcome as it changes.
- [ ] Isolate rejection, missing protection and uncertain acknowledgement when
      account scope and communication integrity remain trustworthy.
- [ ] Stop new submissions globally for auth/leader identity/mapping/channel/journal
      corruption or unsafe fleet exposure. Already dispatched trades remain tracked;
      halting cannot pretend to retract a submitted order.
- [ ] Reserve pending/UNKNOWN exposure atomically and include it in the hedge guard.
- [ ] Test a blocked follower while later followers submit; independent rejection,
      UNKNOWN and protection failure; opposing concurrent events; global revocation
      before dispatch; and durable replay with zero duplicate entries.

Main files: `execution/src/controller.ts`, `journal.ts`, `risk-engine/src/exposure.ts`,
`browser-execution/src/bridge/adapter.ts`, coordinator replacement. Gate: `OFF-FANOUT`.

## 3. Arming, readiness and secure local channel

- [ ] Start LOCKED after controller/browser/worker restart. Use memory-only session
      authority binding leader/followers, symbols, leverage/allocation/risk ceilings.
- [ ] Maintain fresh account-bound readiness and precomputed risk/quantity approvals.
      Changed identity, symbol, client generation or evidence invalidates readiness.
- [ ] Recheck the armed envelope and evidence immediately before actual dispatch;
      queued commands cannot outlive revocation. No per-follower confirmation while armed.
- [ ] Authenticate controller/browser peers and reject replay, tampering, wrong
      generation and unknown operations without exposing credentials.
- [ ] Replace the unfinished single-flight channel prototype with concurrency-safe
      account lanes; never share mutable account selection across follower contexts.
- [ ] Define account-local context loss versus global authentication/integrity loss.
      Retain narrowly scoped, freshly verified recovery where identity is certain.
- [ ] Test restart, expiry, navigation/login/context changes, stale evidence,
      queued/in-flight revocation, spoof/replay and isolated context failures.

Main files: `execution/src/offline-authority.ts`, bridge protocol/channel/adapter,
new readiness/session module. Gates: `OFF-READINESS`, `OFF-CHANNEL`, `VEST-LIFECYCLE`.

## 4. Original Vest integration and prepared contexts

- [ ] Establish a background observation approach respecting the no-chart constraint;
      any necessary relaxation must be explicitly agreed before using it.
- [ ] Verify stable account IDs, complete inventory, account product/risk rules,
      balance/equity/drawdown and fresh positions/orders. Missing facts remain unknown.
- [ ] Verify venue symbols, units, tick/size steps, limits, fees and client revision.
- [ ] Prepare and verify account-bound follower contexts without third-party extensions.
- [ ] Implement only `readAccounts`, `readPositions`, `readOrders`, `submitEntry`,
      `submitStop`, `submitTarget`, `cancelOrder`, `reducePosition`, `flattenPosition`.
- [ ] Correlate request/order/fill IDs; verify partial-fill terminal remainders,
      stop/target quantities, reduce-only behavior, cancellation and closing outcomes.
- [ ] Map authentic leader events without manufacturing entries from initial positions;
      implement scoped reduction/close and TP/SL propagation without reopening followers.
- [ ] Prefer native scoped page functions with no credential capture. Any necessary
      read-only credential helper requires reviewed memory-only, exact GET-only scope.
- [ ] Prove account/symbol isolation, provider evidence normalization and context
      readiness in fixtures, then authenticated observations when separately authorized.

Main files: bridge/provider evidence modules and original Vest adapter. Gates:
`VEST-INTEGRATION`, inventory/freshness/market/account-scope/order-evidence/copier gates.

## 5. Visibility, latency and safe repairs

- [ ] Publish incremental, journal-backed follower updates through the local dashboard.
- [ ] Show side/quantity, fill status/price, independent SL/TP status, reason and exposure.
      Show global lock separately from an individual follower needing repair.
- [ ] Add account-specific Add Stop, Add Target, Flatten, Reconcile and Skip. Offer
      Retry only with verified terminal rejection/non-submission evidence, never UNKNOWN.
- [ ] Make repairs authenticated/idempotent and conflict-safe with active account work;
      verify current identity, exposure and existing exits before mutation.
- [ ] Record event detection, actual dispatch, acknowledgement, fill and protection
      observations using explicit clock/source provenance.
- [ ] Calculate leader→submit, leader→fill, submit→fill, fill→protection, fleet submit
      spread and fastest/slowest followers. Missing metrics remain missing, not zero.
- [ ] Test mixed outcomes, incremental updates, repair races, reconnect without resend,
      retry refusal and metric calculations. Inspect the synthetic UI in the background.

Main files: `apps/dashboard/server.ts`, `public/app.js`, `index.html`, `style.css`,
execution/journal measurement fields. Gates: `OFF-REPAIRS`, `OFF-LATENCY`.

## 6. Connected security and release candidate

- [ ] Enforce exact approved origins/methods/routes/payloads and permissions at runtime
      and build time. Unknown endpoints fail closed; no arbitrary network interface.
- [ ] Exclude update/remote-code/configuration, telemetry/analytics, promo/donation,
      capital/payment/account-management features and unnecessary dependencies.
- [ ] Test synthetic credential canaries across errors/logs/files/SQLite/browser
      storage/dashboard/network sinks. Never collect real secrets for tests.
- [ ] Validate isolated local-only browser profile, lifecycle locking and whole-profile
      network behavior; document remaining official-page and local-host trust.
- [ ] Verify required desktop platforms, dependency/license provenance and applicable
      Vest transport/execution terms. Independently review the exact candidate artifact.
- [ ] Document manual recovery and manual build/update/load procedures.
- [ ] Remove obsolete sequential coordinator/shared-browser paths only after replacement
      coverage; update README/rendered documentation while retaining the logo.
- [ ] Run all relevant checks and `pnpm verify:functional`; inspect the diff and resolve
      required independent review findings. No fixture result approves live trading.

Main files: security policies/checks/build, credential-canary tests, profile/runtime
boundary, README and recovery docs. Gates: `OFF-SECRETS`, Vest security/profile/platform
gates and human security/originality/terms/recovery reviews.

## 7. Separately authorized real proof

- [ ] Obtain explicit approval of the exact minimal one-account account/market/risk/build
      trial after prerequisite evidence and review. No authorization is implied by access.
- [ ] Prove entry, actual fill, stop/target persistence, reduction/close, sibling
      cancellation and failure/restart recovery without blind resubmission.
- [ ] Obtain separate approval of the exact concurrent-fleet trial and limits.
- [ ] Prove rapid independent submissions, isolated follower issues, global stops,
      duplicate prevention, hedge safety and no reopening after follower exits.
- [ ] Measure actual Vest latency; retain sanitized local evidence and explicit gaps.
- [ ] Approve the tested artifact for manual local loading. Product completion requires
      all necessary evidence, completed reviews and release approval.

Gates: `APPROVE-ONE-ACCOUNT`, live entry/protection/close/failures, `APPROVE-FLEET`,
`LIVE-FLEET`, `LIVE-DRIFT`, `REVIEW-RELEASE`. Funded tests stay outside ordinary regression.

## Progress log

| Date       | Completed work                                  | Evidence / limits                                                              |
| ---------- | ----------------------------------------------- | ------------------------------------------------------------------------------ |
| 2026-10-05 | Fan-out inspection and this implementation plan | Document checks, 39-gate validation and 127 focused tests; old runtime remains |
| 2026-10-05 | Retained offline foundation                     | Historical local report above; concurrent and authenticated proof pending      |

Next implementation checkpoint: **Phase 1 — event identity, journal and outcomes**,
followed by **Phase 2 — fan-out**. Update this checklist as each verified item closes.
