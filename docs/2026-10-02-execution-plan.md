# Vest execution plan and laptop handoff — October 2, 2026

**Immediate goal:** establish a stable, owner-authenticated Vest browser session and prove what the funded UI can reliably tell the controller. Resolve the current Windows regression alongside this work. Keep connected execution disabled throughout today's investigation.

This is the working order for the next laptop session and the remaining path to a reliable first release. It is not a promise that external permissions, live behavior or production reliability can be proved in one day. A successful day produces verified progress and exact remaining blockers, without substituting more dashboard polish for connection work.

Timezone: America/Los_Angeles. Planning snapshot: October 2, 2026. The source baseline is `f01a210827c5a9d903ec4b9b9b35fb834366a256` on `feat/vest-readonly-contracts`; recheck the head before starting. [PR #2](https://github.com/Mahdi451/vest-fleet-controller/pull/2) is open and unmerged. [Issue #1](https://github.com/Mahdi451/vest-fleet-controller/issues/1) remains the authoritative milestone tracker; this document supplies the detailed execution order.

## 1. What is actually complete

| Layer                      | Evidence at this checkpoint                                                                                                      | Remaining gap                                                                    |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| Simulation engine          | Independent sizing, post-fill protection, terminal partial-fill handling, hedge guard, durable journal, circuit halt and flatten | Real venue evidence and execution remain unverified                              |
| Dashboard and host         | Mobile controls, private HTTPS, durable commands and native host storage                                                         | Physical phone/desktop acceptance still open                                     |
| Browser evidence contracts | Reject incomplete identity, fills, freshness, protection and close proof                                                         | Tests use synthetic evidence; no real funded parser                              |
| Manual observer            | Dedicated headed browser, protected local profile, owner authorization and lifecycle locks                                       | Unexpected browser closure before verified sign-in; cause unknown                |
| Google sign-in             | Same-page `accounts.google.com` allowed until the Vest page returns; profile kept on quit                                        | Completed owner login, MFA return, and funded identity still unverified          |
| Actual fleet               | User reports ten Instant accounts                                                                                                | Discovery, switching, history, protection and execution timings not yet observed |
| Live copier                | Not implemented/enabled                                                                                                          | All connected execution and trial gates below                                    |

The master source for version one is a LONG/SHORT/FLATTEN command in our application. Watching manually placed leader trades, scale-ins, reversals, protection replacement, parallel workers, managed VPS and public billing remain separate later scope.

### Latest CI evidence overrides older green summaries

[Native CI run 36938820713](https://github.com/Mahdi451/vest-fleet-controller/actions/runs/36938820713), associated with `f01a210`, completed with Ubuntu, macOS Apple silicon and macOS Intel passing. Windows failed:

- Full suite: **338 passed, 1 failed, 4 skipped; 343 total**.
- Separate browser suite: **44 passed, 2 failed; 46 total**, overlapping the full suite.
- Failing file: `tests/private-mobile.test.ts`.
- Full-run diagnostic: accounts 01–08 PROTECTED; 09 rejected with `PRETRADE_REVALIDATION_FAILED`; 10 HALTED with `CIRCUIT_OPEN`.
- Separate-run diagnostic: 01–07 PROTECTED; 08 rejected; 09–10 HALTED. The restart workflow also failed its protected-position assertion.

These observations show incomplete simulated fleet establishment. They do not establish the rejection's underlying cause. Freshness expiry, host storage latency, fixture assumptions and an application defect must be distinguished. The earlier local result of 339 passed/four skipped is historical, not a green result for every current platform.

## 2. First 20 minutes on the laptop

**Mahdi:** use a local visible desktop session on the intended Windows or Mac host. Have normal Vest/Google/MFA access ready; enter credentials only into the official login flow. Keep the phone available for later acceptance, but desktop connection is first.

**Codex:** read applicable `AGENTS.md`, `DEVELOPMENT.md`, this plan, the [gap audit](vest-execution-gap-audit.md), [observation runbook](vest-read-only-observation.md) and latest Issue #1. Inspect uncommitted work before changing branches or files.

Existing checkout, only after preserving any local work:

```sh
git status --short --branch
git fetch origin
git switch feat/vest-readonly-contracts
git pull --ff-only
git log -5 --oneline
```

If the feature branch has not been created locally, use `git switch --track origin/feat/vest-readonly-contracts` in place of the switch command. If history diverges, inspect it; do not force-reset, discard work or force-push. If the PR has merged since this snapshot, use its successor branch from current main.

Fresh checkout:

```sh
git clone --branch feat/vest-readonly-contracts https://github.com/Mahdi451/vest-fleet-controller.git
cd vest-fleet-controller
```

Check the pinned environment and install locked dependencies:

```sh
node --version
pnpm --version
pnpm install --frozen-lockfile
pnpm exec playwright install chromium
```

Current requirements: Node 24.x, pnpm 11.25.0. On native PowerShell, use `pnpm.cmd` if script execution is restricted; do not weaken OS execution policy. Use the [native host guide](native-host-setup.md) for missing prerequisites or initial simulator runtime provisioning. Do not copy another computer's bound runtime/profile to initialize this laptop.

```sh
pnpm host:doctor --runtime .runtime/dashboard
```

Use the actual initialized runtime path if different. Preflight is read-only and does not authorize execution. Do not launch the quarantined observer yet. Preserve the existing journals, identities, profile, circuit state and locks.

**Exit:** correct branch, known working-tree state, supported runtime, identified host/profile and current CI baseline. Record the actual SHA and OS in the work log below.

## 3. Today's work blocks

Timeboxes are planning limits, not delivery estimates. When a block exposes an external dependency, record the exact dependency and continue the independent offline work. Do not spend the day repeating generic policy searches or building another UI.

| Priority | Suggested focus block  | Owner         | Concrete outcome                                                                  |
| -------- | ---------------------- | ------------- | --------------------------------------------------------------------------------- |
| A        | 45–90 minutes          | Codex         | Windows failure reproduced or narrowed with precise revalidation reasons          |
| B        | 45–90 minutes          | Codex + Mahdi | Browser closure explained or bounded; deliberate recovery procedure               |
| C        | 60–120 minutes         | Codex + Mahdi | Reviewed normal login handoff; successful returned Vest identity or exact blocker |
| D        | 60–120 minutes after C | Mahdi + Codex | Redacted real account/evidence inventory and initial switching measurements       |
| E        | 30–60 minutes          | Codex         | Checked-in results, accurate tracker, next command and CI links                   |

Stop at the authorization boundary even if time remains. If C cannot finish, D stays blocked; improve failure tests and recovery from observed behavior instead of inventing selectors.

### A. Diagnose and fix the Windows regression

- [x] Inspect both failed assertions and the full per-account results from the linked run.
- [x] Trace `PRETRADE_REVALIDATION_FAILED` through `packages/execution/src/controller.ts` to its specific validation reasons.
- [x] Capture allowlisted reason codes and durations: preview age, quote/account evidence age, queue delay, entry/protection time and storage-write time. Avoid raw account/session dumps.
- [ ] Reproduce the failing private-mobile cases on native Windows or the same CI runner. A Mac/Linux pass does not close this task.
- [ ] Determine whether the fixture expects ten successful accounts inside a budget that the host cannot meet, or whether the application is mishandling valid evidence.
- [ ] Fix the smallest evidenced cause. Do not lengthen production freshness, remove all-account checks, skip tests or add automatic retries just to obtain green CI.
- [x] If test structure changes, retain separate coverage for complete-fleet success and delayed fan-out rejection. A halted partial fleet must remain an explicit result.
- [x] Rerun the affected workflow and the full native matrix on the final relevant code revision. Record earlier failures as well as resolution.

Acceptance: the reason is known; Windows tests pass without weakening production safeguards; a deterministic delayed-account case proves later entries stop while earlier protected outcomes remain accurately reported. Reject timing-budget changes unless supported by measured evidence and a documented product decision.

### B. Resolve observer closure and recovery

- [x] Inspect `apps/vest-observer/` lifecycle code and `tests/vest-manual-observer.test.ts` against the recorded unexpected context-close event.
- [ ] Distinguish actual Chromium exit, parent-terminal/EOF shutdown, authorization expiry, origin/popup quarantine and lifecycle callback races. Do not assume the closure was a Google policy block or a Vest restriction.
- [x] Add minimal redacted lifecycle reasons and relative event times. Record process/browser version and exit information without URLs containing authentication parameters, raw stderr, traces or profile contents.
- [ ] Establish whether the bound observer and child processes still own the runtime/profile. PID absence alone is insufficient takeover evidence.
- [ ] Implement or document reviewed explicit observer-only recovery that preserves evidence and checks ownership. Never delete controller locks, journals, unresolved commands or circuit halts to restart a browser.
- [x] Test unexpected/early close, clean quit, expiry, terminal loss and concurrent launch. Confirm old queued tasks cannot act after quarantine or rearm a closed session.

Acceptance: either the cause is reproduced and fixed, or a clearly bounded remaining blocker prevents relaunch. An explicit recovery leaves controller state unchanged and proves there is only one observer owner. No silent auto-restart loop.

### C. Support normal Google login without weakening account safety

Personal manual read-only inspection is already owner-authorized in the current runbook. Do not reintroduce a mandatory written-letter prerequisite for that same scope. Owner authorization is not venue approval for automated trading or customer distribution.

- [ ] Inspect the actual visible Vest Sign in with Google flow with Mahdi present, without submitting trading actions. Observe the popup/redirect/return destinations through normal browser UI; do not infer them from hidden requests or credentials.
- [x] Design a separate bounded authentication phase permitting only the observed same-page `accounts.google.com` handoff. Other origins and extra pages still quarantine the session.
- [x] Keep the Chromium profile when the inspection window closes, so the next launch can reuse the Vest session. The one-hour limit ends the inspection; it does not log the owner out of Vest.
- [ ] Mahdi completes account selection, credentials and MFA directly. Our app does not create its own OAuth client pretending to be Vest.
- [ ] After return, verify the Vest authenticated owner view and expected account context. Google account selection and a `ready` acknowledgement do not establish funded identity.
- [ ] Return to one verified Vest page before discovery. Extra/unrelated pages, account mismatch, cancellation, expiry and unexpected destinations must block readiness.
- [x] Add local synthetic tests for the same-page Google handoff, a popup, a wrong return, acknowledgement before the Vest page is back, and profile reuse after the inspection hour. No test credentials or login screenshots in Git. A real MFA return is still untested.
- [ ] Demonstrate one real manual login and a permitted restart/reuse check; expiry must request manual reauthentication. If the normal login rejects the automated browser, record that blocker and evaluate a supported login route; no stealth or anti-bot bypass.

Acceptance: a usable returned Vest session on the intended host, verified owner identity and protected profile, with tested auth failure paths. This is connection evidence, not permission to trade.

Observer-lock recovery is set aside as of 2026-10-03. Do not delete retained locks to force a launch. Use the existing launcher from a visible terminal when this host can take the profile:

```sh
pnpm observe:vest --runtime .runtime/dashboard --authorize-owner-read-only
```

The flag authorizes personal read-only inspection for the documented duration. It does not enable trading. Do not blindly rerun it against retained locks.

### D. Inspect actual accounts, then build the read-only port

- [ ] Map the exact visible funded account IDs, labels, product and count. Do not substitute the simulator's 01–10 identifiers. Unexpected count/membership blocks the intended fleet mapping.
- [ ] Inspect selection mechanism, navigation, pagination and identity across account, position and history views.
- [ ] Document cross-tab/manual-selection effects only within the authorized read-only scope. Separate browser contexts do not prove server-side isolation. Keep the initial operational model one page with serialized switching.
- [ ] Record current positions, existing fills, open protection, completed exits and canceled orders where available. No new orders, cancellations or closes to manufacture sample evidence.
- [ ] Distinguish exact from rounded prices/quantities; display timestamp from observation time; empty view from complete history. Keep absent fields unknown.
- [ ] Capture sanitized semantic selector descriptions and uniqueness expectations. No guessed coordinates or fuzzy trading-control fallbacks.
- [ ] Implement the actual read-only port against observed selectors, behind a separately scoped observation entry point. Reuse the existing contracts; do not connect it to simulation execution or broaden `SIMULATION` into a live mode by renaming it.
- [ ] Validate owner/account before and after each read and scan; detect login loss, incomplete inventory, manual interference and stale data. Read timeouts must quarantine pending operations.
- [ ] After confirming scope, perform three full read-only passes over the ten accounts, recording each switch/read and full-scan age. Report sample count, median, maximum and failures; 30 observations are a diagnostic sample, not a long-term reliability claim.

Acceptance: every required field below has a source or an explicit blocker. No production state is fabricated to satisfy schemas. If real read-only automation is not yet within reviewed scope, finish manual observation and fixture implementation; do not label the port validated.

| Required evidence      | What must be observed or resolved                                                                                                     |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Owner/account identity | Stable visible ID, product, before/after agreement and complete fleet membership                                                      |
| Risk and market        | Balance/equity, drawdown/daily limits, positions, leverage, fees/funding, market units, tick/size increments and trading availability |
| Freshness              | Venue update evidence or a verified refresh mechanism; capture time alone is insufficient                                             |
| Entry                  | Unique visible order linkage, side, market, actual average price, quantity, fees and terminal remainder                               |
| SL and TP              | Independent accepted order identities, position linkage, trigger basis/price, actual protected quantity and reduction semantics       |
| Persistence/OCO        | Applicable proof that protection survives browser loss; sibling and orphan behavior; no assumption of native OCO                      |
| Close                  | Uniquely linked completed exit, canceled/filled siblings, complete flat book and no pending entry remainder                           |

Where no existing sample exists, mark it **unobserved**. Triggering stops, persistence during an open trade and execution timing require an approved test setting or a separately authorized supervised trial; a read-only session cannot prove them.

### E. End-of-session publication

- [x] Update the observation runbook, gap audit and validation report with actual findings, date, SHA, host and evidence provenance.
- [x] Record the exact reason for any remaining login, selector, data or permission blocker.
- [x] Run checks appropriate to changes; do not rerun the entire suite for documentation-only edits.
- [x] Commit focused fixes on the active feature branch, push and link CI. Do not merge PR #2 while the Windows failure or material review findings remain unresolved.
- [x] Update Issue #1 without checking off unobserved capabilities. End with the next file/command and the owner action required, if any.

## 4. Remaining path from connection to a usable copier

These stages are sequential gates, not tasks authorized to place trades today.

### F. Capability and execution-scope decision

- [ ] Resolve applicable same-owner automated execution/account/session terms and the separate commercial distribution scope. Use the existing [permission questions](vest-read-only-observation.md); Mahdi sends them personally if clarification is needed. Silence is not approval.
- [ ] Confirm the actual Instant risk rules and market metadata; do not promote simulation defaults to venue facts.
- [ ] Assess whether visible evidence supports unique order correlation. Local request IDs prevent local replay but cannot force venue-side exactly-once execution.
- [ ] Resolve continuing partial fills: prove terminal remainder cancellation or implement/test protection updates for changing filled quantity before supporting them.
- [ ] Resolve protection persistence, reduce-only semantics and OCO/orphan behavior. A browser-dependent emergency close is not a substitute for accepted protective orders.
- [ ] Set explicit measurable limits for evidence age, preview age, quote drift, unprotected duration, total fan-out and recovery. Record supported environments and rationale. Do not silently refresh an old approved intent to authorize a new risk decision.
- [ ] Record GO, LIMITED SCOPE or NO-GO for a one-account driver. Missing critical evidence means no-go; no private-API fallback.

The disabled-account exclusion in the existing hedge guard is a project rule, not proof that Vest ignores those accounts. Preserve the implemented guard; explicitly resolve broader account exposure policy before connected use.

### G. Implement one-account execution, still disabled by default

Use the existing FleetController, risk engine, journal and adapter boundary. Add a real writer only after F passes and that implementation is authorized. No second execution engine.

Required flow: verify identity/risk → durably claim entry → submit once → reconcile actual fill → recalculate risk/protection → submit reduce-only SL → submit reduce-only TP → verify both → PROTECTED.

- [ ] Journal intent before each possible UI side effect; bind attempts to account, position and immutable command identity.
- [ ] Correlate visible venue outcomes independently of local IDs. Ambiguous click/timeout means reconciliation, never blind resubmission.
- [ ] Protect actual filled quantity using each destination's actual average fill; verify rounding and exact risk after execution.
- [ ] On missing protection, attempt flatten only in a verified account, halt later entries and retain UNKNOWN until authoritative resolution. Failed cleanup must remain visible.
- [ ] Implement sibling cancellation and manual-close/orphan handling with reduction semantics that prevent reversal. UI-only cleanup must expose its outage limitations.
- [ ] Define priority for emergency flatten so it stops unsent entries and cannot race an in-flight entry/protection operation or deadlock behind ordinary work.
- [ ] Add explicit reviewed re-arm preserving balances, journals and unresolved records. Reconciliation alone does not authorize new trading.

Acceptance: fixture/failure matrix below passes; production remains disabled until exact trial authorization. Show the integration design, verified/unverified facts and manual recovery instructions to Mahdi before any live order.

### H. Supervised trials, then staged fleet expansion

- [ ] Prefer an officially permitted test/paper environment with representative funded behavior; do not assume an exchange demo has identical semantics.
- [ ] Before any funded trial, agree on exact account, market, maximum size/loss budget, action count, stop/target, time window, operator presence and emergency procedure. Today’s planning request is not that authorization.
- [ ] Prove one-account entry, protection, normal close and reconciliation under the approved scope. Do not inject destructive crashes into an unprotected real position.
- [ ] Progress one → two → small fleet → ten only after the previous stage meets recorded limits. Review p50/p95/max timing only with stated sample counts; sparse samples cannot establish tails.
- [ ] Keep copying sequential initially. A later failed child leaves earlier protected accounts explicitly reported. Do not automatically unwind them or retry skipped accounts without a defined operator-approved policy.
- [ ] For the intended short-scalp use case, measure first-to-last fill drift and fill-to-protection duration. If sequential copying misses the strategy's limits, document that limitation; concurrency requires a separate verified isolation design.
- [ ] Run extended supervised sessions across the declared supported conditions, including reauthentication and normal restart. News/high-volatility behavior is a separate scope; normal-session passes do not validate it.

Acceptance: recorded real outcomes, no unresolved duplicates/wrong-account actions/unprotected exposures, recovery demonstrated within scope, all agreed operational limits met. Any critical failure pauses expansion and requires cause/fix/regression evidence.

### I. Customer beta and sustainable maintenance

- [ ] Complete real Windows/Mac and phone acceptance: trusted private HTTPS, Home Screen, lock/background/reconnect, logout, host sleep/reboot and startup recovery. The host must remain awake during operation.
- [ ] Verify customer isolation, protected session profiles, redacted diagnostics, certificate/session renewal and conservative lock recovery.
- [ ] Define a supported browser/OS/version matrix; pin dependencies and test upgrades before rollout. Detect changed controls/unknown UI structures and disable entry until reviewed.
- [ ] Add a read-only session readiness check before arming. Automation must never “repair” unknown trading controls by guessing.
- [ ] Maintain redacted audit metrics for ambiguous outcomes, protection delay, drift, reconciliation failures and session loss; document incident triage and manual intervention.
- [ ] Validate upgrade/rollback with preserved journal schemas and host identity. Do not downgrade through an incompatible state migration.
- [ ] Complete commercial scope, clean-machine installation and signed Windows/Mac packaging before the intended customer release; avoid presenting a manual developer install as a finished consumer product.

Version-one completion means the declared same-owner master-command scope is supported end to end, measured under stated conditions, operationally recoverable and appropriately permitted. It does not imply automatic leader following, unattended availability during every outage, or permanent immunity to venue UI changes.

## 5. Required fault and acceptance matrix

Run mutation/chaos cases on synthetic pages or an approved test environment. Do not use funded accounts to create failures without separate exact authorization.

| Scenario                                                     | Required result                                                                 |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------- |
| Wrong account / account changes during form preparation      | No action in an unverified account; halt and preserve evidence                  |
| Duplicate command / lost acknowledgement                     | One local dispatch; uniquely reconcile or remain UNKNOWN                        |
| Fill differs from quote                                      | Risk and SL/TP use actual fill and actual quantity                              |
| Terminal partial / continuing fill                           | Protect terminal actual size; unresolved remaining fills block success          |
| SL or TP rejection / verification timeout                    | Attempt verified-account cleanup; halt further entries; do not report PROTECTED |
| SL/TP trigger / manual close                                 | Position reduces or closes, sibling/orphan cleanup verified, no reversal        |
| Browser crash after submit / between entry and protection    | Durable uncertain state; restart reconciles; no automatic resend/re-arm         |
| Login expiry / canceled OAuth / wrong returned owner         | Manual reauthentication or halt; no authenticated readiness claim               |
| UI change / duplicate selector / rounded or missing evidence | Explicit capability failure; no fuzzy fallback or invented data                 |
| Stale inventory / quote / deadline / excessive drift         | Reject unsent entries; retain explicit earlier outcomes                         |
| User manually changes exposure                               | Detect divergence; block new entries and reconcile                              |
| Flatten during pending operation / partial protection        | Serialized safe cleanup; unresolved orders/positions remain UNKNOWN             |
| Disk full / journal write failure / competing worker         | No unjournaled action or duplicate owner                                        |
| Phone double tap / screen lock / reconnect                   | Recover accepted command status without another dispatch                        |
| Host restart / update rollback                               | Preserve journals/identity, start unarmed, reconcile before review              |
| Disabled or unselected account exposure                      | Preserve tested project guard; flag unresolved wider venue-policy scope         |

## 6. Files and verification commands

Modify only the files necessary for the diagnosed issue; inspect current paths first.

| Work                                | Starting points                                                                                                         |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Windows revalidation failure        | `tests/private-mobile.test.ts`, `packages/execution/src/controller.ts`, existing audit/journal logic                    |
| Browser lifetime and login          | `apps/vest-observer/`, `tests/vest-manual-observer.test.ts`, protected host storage boundary                            |
| Visible evidence and read-only port | `packages/browser-execution/`, `tests/browser-readonly.test.ts`, inspected synthetic fixtures                           |
| Future permitted writer             | Existing browser adapter/coordinator, execution adapter/controller, protection/recovery tests                           |
| Evidence and handoff                | `docs/vest-read-only-observation.md`, `docs/vest-execution-gap-audit.md`, `docs/vest-execution-validation.md`, Issue #1 |

Run narrow tests while diagnosing, then required full checks for code changes:

```sh
pnpm exec vitest run tests/private-mobile.test.ts
pnpm exec vitest run tests/vest-manual-observer.test.ts tests/browser-readonly.test.ts
pnpm exec vitest run tests/execution.test.ts tests/protection.test.ts tests/hedge-guard.test.ts tests/risk.test.ts
pnpm exec prettier --write <changed-files>
pnpm check
pnpm exec vitest run tests/browser-execution.test.ts tests/mobile-dashboard.test.ts tests/private-mobile.test.ts
git diff --check
git diff --stat
```

Replace `<changed-files>` with explicit intended files. Review the diff and staged file list before committing; never stage profiles, runtime records or credentials. Do not repeat optional suites once they have resolved the diagnosed risk. Run `pnpm check` locally for the final code; docs-only changes need formatting/link verification, not a claim of newly executed application tests.

## 7. Session evidence and stop point

Append a short record after each completed block. Keep private account mappings and browser material out of Git.

| Field                                     | Verified checkpoint                                                                                                                                                                                                                                                                                   |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Date / host / browser / source SHA        | October 2, 2026; WSL2/Linux x64 development host; isolated native Windows 11 / Chromium test runs; relevant code `1173dc3`                                                                                                                                                                            |
| Block completed                           | A partially resolved; B diagnostics/tests and bounded recovery dependency; C signed-out first hop only; D awaits C; E checkpoint published                                                                                                                                                            |
| Root cause or observed capability         | Synthetic success fixture depended on host I/O time; now controlled. Original Windows rejection and October 1 browser-close causes remain unproven                                                                                                                                                    |
| Changed files / commit / PR               | Execution diagnostics `3452687`, observer lifecycle `824de71`, native fixtures/shared simulation clock `1173dc3`; PR #2 open and unmerged                                                                                                                                                             |
| Tests / counts / CI link / platform       | Local full check: 352 passed, four skipped; post-review focused check: 27 passed; separate browser suite: 46 passed; final native Windows laptop targeted check: 29 passed; [final code matrix](https://github.com/Mahdi451/vest-fleet-controller/actions/runs/37054143411) passed all four platforms |
| Real inspection versus synthetic evidence | Synthetic simulation/Chromium fixtures plus isolated signed-out public login inspection; no authenticated funded evidence                                                                                                                                                                             |
| Remaining blocker / owner action          | Choose the recovery path, establish exclusive observer ownership, then complete official login/MFA on the visible intended host                                                                                                                                                                       |
| Next exact file or command                | Choose the recovery path and follow the [recovery boundary](vest-read-only-observation.md#october-2-lifecycle-diagnosis-and-recovery-boundary) before any observer launch                                                                                                                             |

### October 2 WSL investigation checkpoint

- Baseline `0e00d62`, WSL2/Linux x64, Node 24.18.0, pnpm 11.25.0; clean initial
  worktree and existing runtime host preflight passed. This is a development host.
- A: execution diagnostic commit `3452687` published; fixed gate/risk reasons and
  storage/phase timing summaries ready for native diagnosis. Controlled delayed
  fanout rejection passes. Production budgets unchanged.
  [Native run 37049870681](https://github.com/Mahdi451/vest-fleet-controller/actions/runs/37049870681)
  passed all four platforms; native laptop phone cases at `824de71` passed too.
  Native preview ages varied up to 2620 ms in the passing CI cases. The fixture
  now uses controlled simulation time with separate expiry/partial-fleet tests.
  Final code `1173dc3` passed 29 native Windows laptop targeted tests.
  [Final relevant code matrix 37054143411](https://github.com/Mahdi451/vest-fleet-controller/actions/runs/37054143411)
  passed all four platforms, including the full and separate browser suites.
  The original Windows root cause remains unproven.
  Separate Intel macOS authenticated-view assertion race corrected in the fixture.
- B: distinct first close causes, private lifecycle timeline, confirmed-close lock
  release and late-callback tests implemented/reviewed. Original context-close cause
  remains unknown; retained locks preserved without reboot-boundary ownership proof.
  See [recovery boundary](vest-read-only-observation.md#october-2-lifecycle-diagnosis-and-recovery-boundary).
- C: isolated signed-out public inspection confirms Log In → unique Google button
  → same-page Google Accounts origin.
  Full authentication handoff/return still requires visible owner-assisted inspection
  on the chosen host after recovery. No allowlist guessed and no credentials entered.
- D: actual funded identities, inventory, switching, evidence and timings remain
  unobserved. No real port implemented from guesses.
- Validation/publication and next commands are recorded in the
  [validation report](vest-execution-validation.md#october-2-execution-diagnostics-and-lifecycle-investigation).
  Next owner dependency: choose the intended host and recovery path, establish
  exclusive observer ownership, then complete official manual login/MFA.
  Further independent code changes cannot establish the unobserved return route or
  funded account evidence.

Today's minimum useful finish: a precise Windows diagnosis, an observer/login outcome, preserved recovery evidence and a published next step. Today's stretch finish: a stable signed-in session plus a verified ten-account read-only inventory. Neither finish authorizes real trades or establishes a completed customer product.

## 8. Paste this into Codex on the laptop

> Continue `vest-fleet-controller` using `docs/2026-10-02-execution-plan.md` on `feat/vest-readonly-contracts` (PR #2). Read applicable repository instructions, inspect uncommitted work and recheck the current branch/CI before changing anything. Prioritize the Windows private-mobile failure, unexpected observer closure, actual Google login handoff and real read-only funded-account evidence. Follow blocks A–E in dependency order, continuing independent offline work when owner input is unavailable. Preserve the current controller, risk engine, journal, hedge guard, protection lifecycle, circuit halt and all runtime/profile records. Personal manual read-only inspection is already owner-authorized; do not confuse it with venue approval or live-trade authorization. Ask me only for the required secure login/owner action when ready. Do not submit/cancel/close real orders, use private endpoints, export authentication state, bypass login controls, guess selectors or loosen production risk/freshness to make tests green. Implement the evidenced fixes, run the relevant checks, publish focused commits and update Issue #1 with accurate results. Stop before connected execution/trials and show the actual capability gaps and proposed next scope. Do not claim a working copier from passing fixtures.
