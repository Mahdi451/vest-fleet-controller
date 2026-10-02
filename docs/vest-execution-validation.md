# Vest evidence contracts and manual observer validation

Date: 2026-10-01. Node 24.18.0, pnpm 11.25.0, Linux development environment.
This validates offline contracts and a manual browser launcher, not a working Vest copier.
The first sections record the original offline slice; the follow-up below records current scope.

## Implemented and reviewed

- Partial visible evidence schemas preserve unknown/null IDs, decimal precision,
  timestamps and collection completeness. No synthetic values enter controller state.
- Assertions reject ambiguous correlation, nonterminal remainders, incomplete risk/
  freshness, mismatched actual fill/position/protection, unknown reduce-only/persistence
  or sibling behavior. Local request IDs do not establish venue idempotency.
- Complete current flat-book evidence is separate from a completed close. Close proof
  additionally requires a uniquely linked terminal EXIT fill and exact exited quantity.
- Read-only inspection serializes one offline page/session, verifies owner/instance
  permission and before/after account identity, inventory, UI revision and scan chronology.
  Timeout/uncertainty quarantines; late completion cannot restore the session. Restart
  starts unverified. Real transports are rejected even with a supplied permission record.
- No controller/risk/adapter/journal/simulator or dashboard execution changes. Existing
  `SIMULATION`/`LOCAL_FIXTURE` restrictions remain. No real browser source, URL/selectors,
  login automation, authentication export, network probing or orders were added.

Independent architecture review preceded implementation. Post-test review found and
resolved missing terminal exit proof, unordered scan timestamps, independently unchecked
capability freshness and unbound sibling evidence. Targeted re-review confirmed all four
were addressed; final offline regression passed after those fixes.

## Commands and results

Publication retry on 2026-10-01 restored filesystem and network access. The full check
was rerun successfully on the Linux development host before committing this change.

The pinned pnpm binary was already cached. A temporary `/tmp/vfc-refocus-bin/pnpm`
wrapper supplies it on PATH. `pnpm_config_verify_deps_before_run=false` avoids pnpm's
automatic dependency installation into the read-only global store; locked dependencies
already exist. This changes package-manager startup only, not tests, expiry or policy.

```sh
pnpm typecheck
pnpm lint
pnpm format:check
CI=1 pnpm check
pnpm exec vitest run tests/browser-readonly.test.ts
pnpm exec vitest run tests/browser-readonly.test.ts tests/risk.test.ts tests/execution.test.ts tests/protection.test.ts tests/hedge-guard.test.ts tests/simulator.test.ts tests/host-storage.test.ts tests/private-access.test.ts tests/legacy-adoption.test.ts
pnpm exec vitest run tests/browser-execution.test.ts tests/mobile-dashboard.test.ts tests/private-mobile.test.ts
```

| Check                                         | Result                                                                                                             |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| New offline contracts                         | PASS: **71 tests**, one file                                                                                       |
| Selected offline regression above             | PASS: **196 passed, 4 platform skips**, nine files, 200 total                                                      |
| Full typecheck, lint, formatting              | PASS; final source checks rerun after review fixes                                                                 |
| Current full `pnpm check` / `pnpm test`       | PASS: **309 passed, 4 platform skips**, 313 total in 17 files. Typecheck, lint and formatting passed.              |
| Separate Playwright-backed browser acceptance | PASS: **46 tests in three files**, rerun after access restoration; Chromium emulation and synthetic sessions only. |

The earlier restricted-session full run failed with 228 passed, 21 failed, 64 skipped
and 19 unhandled errors. It encountered Chromium `SIGTRAP`, loopback `listen EPERM`
and `spawnSync ... node EPERM`; HTTP/HTTPS hooks consequently timed out. After access
was restored, the same full suite passed with **309 tests and four platform skips**.
No production deadline was extended and no test was disabled to obtain that pass.
The current full run includes all Playwright-backed cases; the separate acceptance
run is recorded above. Current results are Linux-only; historical native evidence is
in [native validation](native-host-validation.md), not a new Windows/macOS trial.

## Measured and unmeasured behavior

Offline tests exercise the new boundary with a synthetic in-memory port and an injected
clock. Existing simulator/controller regressions verify safety invariants. Neither is a
measurement of real Vest switching, execution or protection latency. No authenticated
Vest connection, physical phone, native desktop onboarding or Home Screen flow was
performed in this milestone. Current Chromium acceptance uses fixture pages and
authenticated simulation with browser/device emulation; it does not establish
physical-device or funded-account readiness.

Current browser/controller/freshness defaults and test-only differences are in
[the gap audit](vest-execution-gap-audit.md). No budget was changed. Actual account
switching/read/full-scan timings require an owner-authorized authenticated session;
submission, fill-to-protection and fleet execution require a separately approved trial.

## Remaining gates and tracker handover

The owner now authorized personal manual read-only inspection; applicable automated
execution/commercial scope and an authenticated funded session remain unresolved.
Actual discovery/identity/switching and existing fill/protection/closing evidence are
therefore unobserved. Prepare a reviewed real read-only port only after these gates;
see [the observation runbook](vest-read-only-observation.md). Protection persistence,
trigger/sibling behavior and execution failure timing cannot be tested by placing an
order during this task. Every connected/trial checkbox remains open.

## Publication and tracker scope

The earlier session could not stage or publish: `.git` was read-only and GitHub mutation
required approval unavailable in that session. Access was restored on 2026-10-01;
this reviewed change is published through `feat/vest-readonly-contracts`. Issue #1 links
the authoritative commit/PR and verification evidence. `git diff --check` and patch
application checks passed. Only the 15 intended code/test/documentation files are in
this change; the prior CLI fix and `docs/images/ui-preview/` remain separate local work.

Issue #1 makes connection/evidence verification the immediate priority and pauses
polish/installers while retaining physical release gates. The original publication completed the audit, tested offline
contracts and runbook. The follow-up additionally records owner read-only authorization
and the tested manual launcher. Authenticated inspection,
measured real UI capability, connected execution and trial items stay unchecked.

Commit message: `feat(browser): define fail-closed read-only Vest evidence contracts`.

Vest-connected execution remains blocked until the permission and visible-capability
review defined in Issue #1 is completed, followed by separate trial authorization.

## Owner-authorized manual launcher — 2026-10-01 follow-up

The owner revised the earlier mandatory written-letter project gate for personal
manual read-only inspection. A fresh signed-out browser rendered public prop/Site
terms and expanded the funded API/strategy FAQ answers; [the source register](vest-facts.md)
records the scoped finding. No blanket automation prohibition was found in reviewed
public text. Owner consent is recorded as `USER_OWNER_AUTHORIZATION`, never converted
to `VENUE_WRITTEN_APPROVAL`. Execution/commercial scope remains separate.

`apps/vest-observer/` launches a headed dedicated browser on the exact official start
URL. It reuses native protected host storage without opening the execution engine.
The persistent profile stays outside Git and binds to owner/instance/machine/paths;
independent runtime/profile locks reject competing or stale observers. Only launch,
navigation and lifecycle guards are automated. No credentials, DOM/account evidence,
cookies/tokens/storage state or authenticated traces are read/exported. No automated
account switching or trading controls are present. Operator acknowledgement is not
verified authentication or readiness. Unexpected pages/origins and expiry quarantine;
ambiguous launch/crash/unconfirmed close retains locks rather than silently taking over.

Validation commands:

```sh
pnpm exec vitest run tests/vest-manual-observer.test.ts tests/browser-readonly.test.ts
CI=1 pnpm check
pnpm exec vitest run tests/browser-execution.test.ts tests/mobile-dashboard.test.ts tests/private-mobile.test.ts
```

- Targeted contracts and manual lifecycle mocks after review fixes: **101 passed**
  (71 existing contracts plus 30 launcher/authorization tests).
- Full check: typecheck, lint, formatting PASS; **339 passed, four platform skips,
  343 total in 18 files** on this Linux host. Static checks and 101 targeted tests
  were rerun after the lifecycle review fixes.
- No production timeout/freshness budgets changed; launch/navigation has its own
  30-second manual-browser budget, not an execution budget.

The preceding sections describe the earlier offline-contract commit. This follow-up
adds the separate real browser launcher, not a real observation port or copier. Actual
funded discovery, fills/protection/closing and execution timing remain unverified;
real orders stay disabled. Windows/macOS interactive login and physical phone
validation are still open. The existing CLI reporting edit and saved UI images remain
separate local work, outside this change.

- Separate Chromium browser regression: **46 passed in three files** (local fixture
  adapter, mobile dashboard and authenticated HTTPS simulation). This is not a Vest
  or physical-phone test.
- Independent review identified unexpected-close lock-release and early-close-event
  races. Fixes latch ambiguity, replay early closure and cancel the expiry timer;
  tests verify expiry/later close cannot release locks after a crash.
- Real headed launcher attempt: official navigation reached the open-for-manual-login
  state, followed by an unexpected context-close event. It quarantined before sign-in
  was verified and retained both observer locks. The underlying cause is unconfirmed;
  it is not evidence of a terms restriction or successful account connection. The
  lingering CLI was stopped explicitly; locks/profile were preserved, with no automatic
  relaunch or record deletion.
- Host preflight initially rejected the existing runtime directory's broad POSIX mode.
  Explicit owner-only directory hardening restored preflight; all immediate runtime
  file-content hashes were unchanged. No identity rebind, halt reset or journal deletion.

Actual authenticated inspection remains blocked on a usable manually signed-in session
and explicit review of the quarantined browser lifecycle. No real switching, fills,
protection/close evidence or executable latency was measured.

## October 2 execution diagnostics and lifecycle investigation

Source baseline: `0e00d62`; execution diagnostic revision: `3452687`. Host:
WSL2/Linux x64, Node 24.18.0, pnpm 11.25.0. Locked dependencies and Chromium were
verified/installed. Existing `.runtime/dashboard` host preflight passed read-only;
this is not native Windows/macOS or execution readiness evidence.

- Current baseline [run 37046519706](https://github.com/Mahdi451/vest-fleet-controller/actions/runs/37046519706)
  passed all four runners. [Run 37046545285](https://github.com/Mahdi451/vest-fleet-controller/actions/runs/37046545285)
  passed Windows, Ubuntu and Apple silicon; Intel macOS failed its separate browser
  suite at the immediate logout-visibility assertion. `refresh()` marks connectivity
  before awaiting command recovery and exposing the authenticated view. The fixture
  now waits for that view. Neither run explains the older Windows fleet rejection.
- Revalidation instrumentation preserves all prior safety predicates and child error
  codes. Fixed enum reasons, signed evidence ages and monotonic phase durations use
  the existing final audit write. Test-only wrappers time existing journal calls;
  no snapshot, session material or raw state enters those summaries.
- Deterministic delayed-fleet regression passes: seven PROTECTED results, account
  eight rejection with stale account/quote and preview-expiry diagnostics at 5001 ms,
  later accounts HALTED, no later dispatch, protected earlier positions and stable
  durable replay. The first new test used the inclusive 5000 ms boundary and failed;
  it was corrected to 5001 ms without changing production freshness semantics.
- At observer revision `824de71`, local `pnpm check` passed typecheck, ESLint and formatting, with **350 passed,
  4 platform skips, 354 total in 18 files**. The **40-test observer suite** includes
  two real Chromium lifecycle cases. Narrow execution/private
  phone checks passed **20 tests**; the separate Chromium browser/private-phone suite passed **46 tests**. Source/diff checks and independent Sol High review
  passed for both the execution diagnostic and observer lifecycle changes.
- Native diagnostics run:
  [37049870681](https://github.com/Mahdi451/vest-fleet-controller/actions/runs/37049870681),
  passed all four runners. Windows ran both phone cases in both suites: all ten
  accounts were protected in each. The historical rejection has no detailed reason
  and remains unexplained; expiry under runner load is consistent with the evidence,
  not proven.

Observer timelines record first-cause-wins quit/EOF/signal/expiry/guard/unexpected
close events with relative timing and safe version metadata. Tests cover concurrent
close, late callbacks, early/external close, unobserved or failed close, retained locks
and original controller-record preservation. Two real Chromium tests render an
isolated synthetic signed-out page and verify requested versus external context
closure. They do not reproduce the October 1 failure or verify real login.

The retained observer locks were read but left unchanged: their payloads agree, the
parent is absent, no matching guest process was found, and both postdate guest boot.
Those facts do not establish exclusive child ownership or safe recovery. The original
closure lacks diagnostic provenance. Full host reboot and reviewed observer-only
recovery are the remaining relaunch dependency; no permissive stale-lock tool shipped.
Public signed-out inspection confirmed the Vest Log In dialog and its unique Google
button, followed by same-page navigation to the `accounts.google.com` origin with no
additional page in this sample. Authentication URL parameters were not recorded.
The complete return route, owner identity, ten-account inventory and real
read-only selectors/capabilities remain unverified. No credentials, authentication
screenshots, session export or trading actions were used.

### Native timing evidence and controlled simulation clock

At `3452687`, the four Windows CI phone commands had maximum preview ages
2009–2620 ms, maximum queue delays 1897–2489 ms, aggregate measured journal-call
cost 2197–2729 ms and maximum individual storage-call cost 152–213 ms. Measurements
include the existing nested journal wrappers and are diagnostic call totals, not a
separate wall-clock fan-out budget. All ten accounts were protected in each command.
Production evidence and preview limits remain 5000 ms.

A separate tracked-source archive at `824de71` ran under native Windows 11
10.0.26100.0 on this laptop, using a temporary portable Node 24.18.0 installation,
pinned pnpm and native Chromium. No bound runtime, profile, credentials or Git
configuration was copied. The first phone attempt failed during fixture setup
because per-user Git's OpenSSL was absent from PATH. Adding its bundled OpenSSL to
that test process's PATH resolved setup: **2 phone tests passed**, all ten positions
protected in both cases, with maximum preview ages 470/286 ms and maximum queue
delays 271/184 ms. This is emulated phone validation, not physical-phone acceptance.
No global PATH or PowerShell policy change was made.

Those passing samples show materially variable native timing, but cannot recover
the old missing rejection reason. The full-fleet phone/persistence fixture now uses
one injected simulation clock across adapter, controller, evidence and command
checks, matched by browser `Date` only. Production defaults to wall time; private
access/session expiry, real timers, I/O and monotonic diagnostics remain independent.
The fixture's diagnostic summary labels its controlled synthetic time explicitly.
Separate API/controller cases advance time by 5001 ms and prove rejection before
entry or during account-eight revalidation, retained earlier protections, a latched
halt, accurate partial-command completion and replay without redispatch.

Current controlled-clock `pnpm check` passed typecheck, lint and formatting, with
**352 passed, four platform skips, 356 total in 18 files**. The initial clock capture
broke two existing dynamic wall-clock expiry tests; the default was corrected to
read `Date.now()` on each use, and both focused expiry suites (24 tests) then passed.
Independent Sol High clock review found a test-only reconciliation race. The delay
now requires seven observed entries, preventing a background scan from advancing time
before execution. Focused dashboard/execution checks then passed **27 tests**; the
separate browser/private-phone suite passed **46 tests**. No production safety or
security-clock findings remain. Final relevant revision native CI passed as recorded below.

The native laptop observer suite at `824de71` took about 940 seconds: **39 passed,
one failed**, in the real Chromium requested-close case. The isolated case also
failed with timeout-shaped runner errors and a cleanup permission error under its
explicit 30-second test limit. Matching the existing Windows suite's 60-second test
allowance made both real Chromium close cases pass (**2 passed, 38 filtered out**),
with reported durations about 37 and 33 seconds. Only this test deadline changed;
observer authorization and closure/ownership policy did not. The targeted native
copy was `824de71` plus that one test-deadline diff. No new complete native laptop
observer suite is claimed.

[Observer revision run 37050725933](https://github.com/Mahdi451/vest-fleet-controller/actions/runs/37050725933)
passed all four native runners, including the full suite and separate browser suite
on Windows, before the controlled-clock/test-deadline changes.

### Final code revision `1173dc3` checkpoint

A fresh tracked-source archive of `1173dc3` passed **29 targeted tests** natively on
this Windows 11 laptop: dashboard API, execution and both private-phone workflows.
The runs used the same temporary portable Node and process-local OpenSSL PATH;
no bound runtime, browser profile or credentials were copied. Both phone commands
protected all ten synthetic accounts. Their controlled synthetic preview ages were
zero, while measured real maximum queue delays were approximately 319/273 ms.
The API/controller cases separately exercised deliberate expiry and retained partial
fleet outcomes. These observations do not prove physical-phone or funded compatibility.

[Final relevant code matrix 37054143411](https://github.com/Mahdi451/vest-fleet-controller/actions/runs/37054143411)
passed on all four platforms at `1173dc3`: Windows Server 2025 x64, Ubuntu 24.04
x64 and macOS 15 Intel/Apple silicon. Windows completed the full typecheck, lint,
format and test suite with **352 passed, four skipped, 356 total in 18 files**,
including **40 observer tests**; its separate browser/private-phone suite passed
**46 tests**. The four Windows phone diagnostic commands each reported ten PROTECTED
accounts and no rejection, with their controlled synthetic time clearly labeled.
This establishes final-code native fixture acceptance, not the historical failure's
missing reason or real funded/browser readiness.

The original failed Windows job `110625296195` was rechecked against `f01a210`:
the first phone assertion required one ACTIVE protected position on every account
(line 190), and the restart assertion required the same after recovery (line 435).
The recorded full-run command had accounts 01–08 PROTECTED, 09 rejected and 10
HALTED; the separate run had 01–07 PROTECTED, 08 rejected and 09–10 HALTED.
The available diagnostic objects contain only halt state, health metrics and results,
without validation reason details or quote/account/preview ages. They cannot identify
the precise old revalidation predicate. The restart failure lacks a detailed book
dump, so it cannot independently establish why a protected position was absent.

The retained runtime/profile observer locks were rechecked after final validation:
they still exist and have matching payloads, the recorded parent is absent, and
both lock modification times remain later than current guest boot. This is not
exclusive child-ownership or full-host shutdown proof. They remain unchanged.
The owner recovery-path question remains unanswered; recovery, complete Google
handoff/return, verified owner/fleet identity and actual read-only observations are
still required. No real observer was relaunched and no authenticated funded port
was implemented. PR #2 remains open and unmerged.
