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
- [x] Prove retained risk, hedge and journal foundations in the synthetic concurrent
      coordinator (Phase 2). Authenticated production proof remains pending.

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

- [x] Extract the existing single-account lifecycle from `FleetController.execute()`;
      reuse risk/protection logic with one execution owner.
- [x] Replace the shared account loop/bridge queue with independent account lanes.
      Keep conflicting operations ordered within each account.
- [x] Start all ready follower commands without awaiting another follower's fill
      or protection. Collect and publish each outcome as it changes.
- [x] Isolate rejection, missing protection and uncertain acknowledgement when
      account scope and communication integrity remain trustworthy.
- [x] Stop new submissions globally for auth/leader identity/mapping/channel/journal
      corruption or unsafe fleet exposure. Already dispatched trades remain tracked;
      halting cannot pretend to retract a submitted order.
- [x] Reserve pending/UNKNOWN exposure atomically and include it in the hedge guard.
- [x] Test a blocked follower while later followers submit; independent rejection,
      UNKNOWN and protection failure; opposing concurrent events; global revocation
      before dispatch; and durable replay with zero duplicate entries.

Evidence: shared `account-lifecycle.ts`, new synthetic `fanout-controller.ts`, durable
batches/reservations in `copier-records.ts`, and explicitly account-bound bridge lanes.
`fanout-controller.test.ts` and `copier-exposure.test.ts` pass 40 tests; six focused
suites pass 175 tests including legacy lifecycle/authority/bridge coverage. Independent
review found no blocking issue. See [offline contracts and limits](offline-fanout.md).

Completion at this checkpoint is offline and ENTRY-only. Dashboard/CLI then retained
the legacy sequential simulator; real Vest contexts and the authenticated concurrent
channel were still pending. Phase 5 adds a separate synthetic copier page.
`OFF-FANOUT` gains regression coverage but remains BLOCKED by `OFF-READINESS`.
Production arming must add clock-rollback detection and require complete verified
fleet evidence. No live trading authority is introduced.

Integrated verification (2026-10-05): `pnpm verify:functional` passes all six checks,
with matching source fingerprints. Report:
`dist/functional-proof-0c1b9b95-a276-431d-9937-505572da4e67/report.json`.
`OFF-FANOUT` is BLOCKED on readiness; live remains LOCKED and `functional=false`.

## 3. Arming, readiness and secure local channel (offline contracts)

- [x] Start LOCKED after controller/browser/worker restart. Use memory-only session
      authority binding leader/followers, symbols, leverage/allocation/risk ceilings.
- [x] Maintain fresh account-bound readiness and precomputed risk/quantity approvals.
      Changed identity, symbol, client generation or evidence invalidates readiness.
- [x] Recheck the armed envelope and evidence immediately before actual dispatch;
      queued commands cannot outlive revocation. No per-follower confirmation while armed.
- [x] Authenticate controller/browser peers and reject replay, tampering, wrong
      generation and unknown operations without exposing credentials.
- [x] Replace the unfinished single-flight channel prototype with concurrency-safe
      account lanes; never share mutable account selection across follower contexts.
- [x] Define account-local context loss versus global authentication/integrity loss.
      Retain narrowly scoped, freshly verified recovery where identity is certain.
- [x] Test restart, expiry, navigation/login/context changes, stale evidence,
      queued/in-flight revocation, spoof/replay and isolated context failures.

Evidence: memory-only `fanout-readiness.ts` integrated with the synthetic coordinator;
concurrent `authenticated-channel.ts` and account-bound bridge adapter. Tests cover
prepared capability binding, account revisions, local context loss/restoration,
expiry/revocation/rollback, concurrent protected followers, replay/tampering, swapped
responses and channel bounds. See [contracts and limits](offline-readiness-channel.md).

These checks prove synthetic `LOCAL_FIXTURE` account contexts and trusted in-memory
peer provisioning only. Real browser restart/login/navigation notifications, authenticated
peer provisioning and Vest context attestation are Phase 4 work. The channel deliberately
quarantines globally on capacity exhaustion. `VEST-LIFECYCLE` remains unproven; no real
connection or live authority has been added.

Validation: 79 targeted fan-out/readiness/channel tests pass; type checking, lint and
security checks pass. Independent review findings resolved: leader context loss remains
global after disarming, and an unavailable follower cannot gain leader authority by
rearming. Browser context evidence remains explicitly synthetic. Final review also added
zero-entry rejection when a prewarmed leader becomes disabled or inactive.

Integrated verification (2026-10-05): `pnpm verify:functional` passes all six checks
against matching final source fingerprints. Report:
`dist/functional-proof-6edc6ce3-de09-4f2d-b301-84a23cd7ad8a/report.json`.
`OFF-READINESS`, `OFF-CHANNEL` and `OFF-FANOUT` pass for fixtures. Live remains LOCKED,
`functional=false`; connected context, secret-canary, repairs and latency proof remain pending.

## 4. Original Vest integration and prepared contexts

### Offline managed-browser checkpoint

- [x] Launch real headless Chromium against owned localhost fixtures in disposable dedicated profiles; no existing-browser attachment, extension, public debug endpoint or foreground window.
- [x] Keep the transport and controller separately LOCKED until explicit local fixture arming; restart/disconnect/navigation/identity loss revokes authority.
- [x] Expose named account-bound operations through one-use private invocation identities; reject forged calls and page replies.
- [x] Exercise controller-driven entry, reduction and protection changes through real fixture pages, independent follower loss and global leader loss.
- [x] Retain a timed-out account lane until underlying work settles; other follower lanes remain independent.
- [x] Add exact-file build guards requiring the reviewed headless launch syntax; production build remains inert and excludes the fixture host/Playwright.
- [ ] Prove process-wide browser network containment and a persistent real Vest profile. Context routing and suppression flags do not establish this proof.

Evidence and limits: [managed-browser fixture](managed-browser-fixture.md). These checks do not complete connected Phase 4.

- [x] Select the runtime target: local controller/dashboard with a dedicated managed
      Vest browser and no Chrome extension required. Owner decision 2026-10-06;
      [architecture and constraints](fanout-adoption-plan.md#chosen-runtime-target).
- [ ] Implement managed-browser lifecycle and private controller transport; prove
      dedicated-profile isolation, restart/disconnect locking and zero public debug access.
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

Offline preparation added: independently designed `bridge/provider-evidence.ts`,
strict complete inventory/context-generation and market-economics contracts, correlated
entry/partial-remainder normalization, and accepted-event intake through the existing
durable journal. Snapshot bootstrap never manufactures an entry. Synthetic tests cover
missing/stale/incorrect facts, duplicates, gaps, reordered events and identity conflicts.
Connected provider creation always refuses. See [contract and missing real evidence](provider-evidence-contract.md).

This is partial Phase 4 work. Actual Vest transports, account-bound contexts, contract
units/economics, event cursor and order/protection semantics remain unverified. No
authenticated browser or provider testing was performed; no trading charts were opened.

Operator checkpoints: separately agree the authenticated observation scope and sign-in
flow; confirm stable leader/follower account mappings, symbols and risk limits. Browser
login remains an operator action; never request passwords or exported session tokens.
If Vest cannot support the no-chart/background constraints, present that blocker before
changing the test approach. Architecture approval does not authorize authenticated testing.

## 5. Visibility, latency and safe repairs

- [x] Publish incremental, journal-backed follower updates through the local dashboard.
- [x] Show side/quantity, fill status/price, independent SL/TP status, reason and exposure.
      Show global lock separately from an individual follower needing repair.
- [x] Add account-specific Add Stop, Add Target, Flatten, Reconcile and Skip. Offer
      Retry only with verified terminal rejection/non-submission evidence, never UNKNOWN.
- [x] Make repairs authenticated/idempotent and conflict-safe with active account work;
      verify current identity, exposure and existing exits before mutation.
- [x] Record event detection, actual dispatch, acknowledgement, fill and protection
      observations using explicit clock/source provenance.
- [x] Calculate leader→submit, leader→fill, submit→fill, fill→protection, fleet submit
      spread and fastest/slowest followers. Missing metrics remain missing, not zero.
- [x] Test mixed outcomes, incremental updates, repair races, reconnect without resend,
      retry refusal and metric calculations. Inspect the synthetic UI in the background.

Main files: `apps/dashboard/server.ts`, `src/copier-simulation.ts`, `public/copier.js`,
`copier.html`, `copier.css`, execution/journal latency and repair records. Gates:
`OFF-REPAIRS`, `OFF-LATENCY`.

Completed and reviewed for fixtures (2026-10-06): the additive
`/copier` dashboard uses a separate synthetic fleet and durable sidecar. It shows
independent entry/fill/SL/TP/exposure outcomes, incremental progress, scoped repairs and
observed clock-bound latency. Restart restores outcomes while authority returns to LOCKED.
Read-only reconciliation remains available while entries are locked. UNKNOWN has no
Retry; safe retry binds the expected current attempt. Protection additions and flattening
require current owned-exposure evidence and conditional execution.

Headless localhost tests exercise desktop/mobile layouts, mixed failures, Add Stop,
duplicate/restart behavior, concurrent progress, exact origin/token/private authentication,
browser storage and observed requests. Fixture metrics are not actual Vest latency.
See the [copier simulation guide](copier-simulation-guide.md). Completion here means
synthetic execution only. Repair review findings were resolved with regressions for
fresh exit/position evidence, wrong protection identity, stale/duplicate Retry across
restart, journal-write failures and authorization revocation during initialization.
Independent review found no remaining blocking issue.

Evidence: 24 provider-contract tests, 14 latency tests, 22 repair/evidence tests,
10 dashboard/revocation tests and 8 secret-canary tests pass. Desktop and mobile
localhost layouts were exercised and inspected headlessly. `pnpm verify:functional`
passes all six checks with matching source fingerprints. Report:
`dist/functional-proof-81449dfd-12f5-4e32-8554-d3485c7716ab/report.json`.
`OFF-REPAIRS` and `OFF-LATENCY` pass. `OFF-DRIFT` and `OFF-SECRETS` remain UNPROVEN;
all Vest evidence remains unproven, live LOCKED and `functional=false`.

### High-priority protection follow-up

Added 2026-10-06 from the behavior and bug reports in Better Vest
[8.1.5](https://github.com/ax4p/better-vest/releases/tag/v8.1.5). Independently
implement these extensions. The checks below now cover the offline implementation only;
no authentic provider behavior or latency is proven. Connected execution depends on Phase 4 proving
account-bound protection operations, order identity and provider update semantics.

- [x] **Prevent duplicate stops during rapid changes.** Two stop changes while no
      stop exists must create at most one active owned stop, with the latest valid
      intent reconciled. Bind changes to durable event/account/position identities.
      Test simultaneous requests, duplicate events, delayed/out-of-order responses,
      timeout and restart. UNKNOWN creation reconciles without a second create;
      preserve existing protection until a safe update is proven.
- [x] **Propagate TP/SL changes promptly.** Dispatch valid changes across ready
      followers without waiting for another account or an unnecessary display refresh.
      Preserve ordering within each account; stale acknowledgements cannot overwrite
      newer intent. Verify current position ownership, quantity and reduce-only scope.
      Test rapid changes, position reduction/close races and isolated follower failure.
      Measure event-to-submit and event-to-verification latency with clock provenance;
      set no speed claim until actual measurements exist.
- [x] **Show pending protection immediately.** Publish separate stop/target
      SUBMITTING states from actual dispatch and show the intended level while pending.
      Display VERIFIED only after matching provider evidence; rejection or lost
      acknowledgement stays visibly FAILED/UNKNOWN with a safe repair/reconcile action.
      Test incremental dashboard updates while the provider is delayed, mixed follower
      outcomes, stale responses and restart without optimistic success or resend.

Offline implementation includes durable replay-only change activation, event/account identities,
separate remaining-exposure projections, aggregate ADD risk checks and ordered REDUCE/CLOSE.
Missed followers never receive an old event after restart. Unsupported side/leverage changes
fail closed; terminal local revision rejections do not halt valid followers. Fresh leverage,
active reduce-only/unfilled exits and ownership are checked before verification. Legacy
mutating repairs are refused after a root changes; current-root manual repair controls remain
open. See the [simulation guide](copier-simulation-guide.md).

Before checking off any connected item: pass its acceptance tests, resolve independent review
findings, and record evidence here. Retain required protection on entries; no default
unprotected STOP/LIMIT behavior. These tasks introduce no live authority or third-party
runtime dependency. Optional trailing stops, automatic breakeven and chart/P&L features
remain outside this priority batch.

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
- [x] Document manual recovery and manual build/update/load procedures. Actual
      provider recovery and release approval remain separate open requirements.
- [ ] Remove obsolete sequential coordinator/shared-browser paths only after replacement coverage.
- [x] Refresh README and architecture visuals for the current offline milestone, retain
      the logo and move detailed simulator instructions into their own guide. Version
      0.1.1: local links checked, fan-out SVG/PNG inspected headlessly, and all six
      `pnpm verify:functional` checks pass. Evidence:
      `dist/functional-proof-a3b7ea39-304a-4ef1-9f1d-b6f35f80b24d/report.json`.
- [ ] Run all relevant checks and `pnpm verify:functional`; inspect the diff and resolve
      required independent review findings. No fixture result approves live trading.

Main files: security policies/checks/build, credential-canary tests, profile/runtime
boundary, README and recovery docs. Gates: `OFF-SECRETS`, Vest security/profile/platform
gates and human security/originality/terms/recovery reviews.

Partial preparation: fake credential-canary tests cover provider payload/errors,
snapshots, audit/SQLite persistence, repairs, latency and channel inspection; fixture
dashboard tests cover API error sanitization, browser storage and localhost requests.
These are offline boundaries, not authenticated Vest whole-profile containment proof.
[Manual local release and recovery procedures](manual-local-release.md) are documented;
the exact connected artifact, platform, terms, security and recovery reviews remain open.
The production artifact stays inert. Phase 6 is not complete.

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

| Date       | Completed work                                   | Evidence / limits                                                                                    |
| ---------- | ------------------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| 2026-10-05 | Fan-out inspection and this implementation plan  | Document checks, 39-gate validation and 127 focused tests; old runtime remains                       |
| 2026-10-05 | Retained offline foundation                      | Historical local report above; concurrent and authenticated proof pending                            |
| 2026-10-05 | Phase 1 event records and follower outcomes      | 61 new tests, independent review, all six integrated checks pass; fixture-only                       |
| 2026-10-05 | Phase 2 independent follower fan-out             | 40 fan-out/exposure tests, 175 focused tests and independent review; synthetic ENTRY-only            |
| 2026-10-05 | Phase 3 offline readiness and concurrent channel | 79 targeted tests and independent review; real Vest context/provisioning pending                     |
| 2026-10-05 | Version 0.1.1 documentation refresh              | Concise README, planned fan-out visual and simulator guide; six checks pass, live LOCKED             |
| 2026-10-06 | Provider contracts and Phase 5 offline workflow  | Reviewed repairs, latency and dashboard; all six checks pass; real Vest integration remains open     |
| 2026-10-06 | Phase 6 offline security/release preparation     | Secret canaries and manual procedures; connected containment and release reviews remain open         |
| 2026-10-06 | Protection follow-up implemented offline         | Durable stop/target propagation, immediate pending states and duplicate-stop controls; fixtures only |
| 2026-10-06 | Managed-browser target selected                  | Local controller/dashboard and dedicated browser; no extension required; connection still unproven   |

Latest offline checkpoint evidence (2026-10-06): managed-browser tests **19 PASS**;
owned-event tests **21 PASS**; mutation-store tests **6 PASS**; headless/security-policy
checks **20 PASS**; dashboard API/desktop/mobile tests **10 PASS**. Simulator-owned
mutation tests also pass as part of the full regression suite. Independent review
cleared all blocking findings. `pnpm verify:functional` passes security, inert build,
typecheck, lint, formatting and full regression with identical before/after source
fingerprints. Report: `dist/functional-proof-5c3d215f-10c6-484b-99e2-fdf4b76550e0/report.json`.
`OFF-DRIFT` and `OFF-SECRETS` remain UNPROVEN; all connected/live gates remain open.

Offline checkpoint review: the managed lifecycle and owned-event executor passed
independent review after fixes for authority loss, launch syntax, unresolved repair
isolation, fresh protection evidence and partial-activation replay. Current-root repair
controls and real provider semantics remain explicit gaps.

Next implementation checkpoint: **Phase 4 authentic provider evidence and original
connected adapter**, then remaining Phase 6 security proof and separately authorized
Phase 7 trials. Three major phases remain (4, 6 and 7), with Phase 5 protection follow-ups now verified in fixtures and pending authentic integration. The original Phase 5 offline scope is complete;
Phases 4 and 6 remain partial.
Update this checklist as each verified item closes.

### Prototype retirement audit

- [x] Confirm the inert production build includes only `apps/local-trading/index.ts`; no fixture browser or legacy simulator is silently promoted to production.
- [x] Keep `risk-engine`, hedge checks, journaling, single-account execution and security verification as shared foundations.
- [x] Separate the concurrent `/copier` fixture fleet and mutation records from the original `/` dashboard and `FleetController` simulation.
- [ ] Retire legacy dashboard/controller and fixture bridge transports after the authentic managed adapter covers their required behavior and migration tests pass. They still serve compatibility tests; deleting them now would remove working coverage without a proven replacement.
- [ ] Provide current-root Add Stop/Add Target/Flatten repair scopes after ADD/REDUCE; old initial-fill repair scopes already fail closed.

No updater, remote configuration, third-party extension, payout/payment capability or credentials were added. This batch remains offline.
