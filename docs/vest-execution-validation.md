# Offline Vest connection contract validation

Date: 2026-10-01. Node 24.18.0, pnpm 11.25.0, Linux development environment.
This validates offline preparation, not a working Vest connection/copier.

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
switching/read/full-scan timings require permission and an authorized session;
submission, fill-to-protection and fleet execution require a separately approved trial.

## Remaining gates and tracker handover

Written owner read-only automation permission, separate execution/copy permission,
commercial distribution scope and an authorized funded session are unavailable.
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
polish/installers while retaining physical release gates. Only the audit, tested offline
contracts and runbook items are complete. Permission, authenticated inspection,
measured real UI capability, connected execution and trial items stay unchecked.

Commit message: `feat(browser): define fail-closed read-only Vest evidence contracts`.

Vest-connected execution remains blocked until the permission and visible-capability
review defined in Issue #1 is completed, followed by separate trial authorization.
