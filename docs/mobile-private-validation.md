# Mobile simulation and private access validation

Recorded 2026-09-30. **Application implementation is delivered; physical-device and
production deployment acceptance remain open.** No connected Vest stage is complete.

## Recovery and scope

The available workspace was a clean fresh clone at documentation checkpoint `4fc26f8`.
`git cat-file -t 9d6b85e` found no object; there were no additional worktrees or Phase B
files in the searched project/temp locations. The previous application commit and
uncommitted changes were unavailable here. Work was reconstructed incrementally from
the specification, checkpoint, tracker and existing engine. Earlier recorded test
results were not reused as proof of this build.

The controller/risk engine, hedge guard, fill-anchored reduce-only protections,
journaling, deterministic child IDs, circuit breaker, reconciliation, simulator and
CLI remain in place. No real Vest login, funded execution, private endpoint, session
replay or browser write automation was added.

## Delivered behavior

- Phone Trade / Accounts / Activity, readable risk/account cards, 44px controls,
  explicit confirmation, sticky SIMULATION label and reachable emergency flatten.
- Home Screen manifest/standalone metadata and branded 192/512/180px icons.
- Controller reachability separated from quote/account/reconciliation freshness;
  stale/disconnected entry disabled and pending/UNKNOWN status visible.
- Canonical command envelopes in the existing SQLite journal, durable acceptance,
  payload-conflict rejection, read-only recovery, duplicate/expiry protection,
  persistence-failure halt and unresolved-command reset guards.
- Explicit private Node HTTPS route; default exact loopback remains unchanged.
  Exact Host/Origin, CSRF, scrypt credential verifier, expiring/revocable opaque
  Secure/HttpOnly/Strict sessions and server-resolved owner/instance/inventory.
- Stable machine/runtime-bound identity, exclusive execution ownership, graceful
  accepted-job settlement and conservative halted restart.
- Resumable in-place legacy adoption preserving records, hashes, aliases and results;
  interrupted PENDING becomes UNKNOWN without another dispatch.
- First-host installation, phone sign-in, Home Screen, shutdown, recovery, revocation,
  diagnostics and update instructions in [the host guide](private-phone-access.md).

## Architecture decisions

No framework migration, second controller or second risk engine was introduced.
There is no service worker, offline cache, Background Sync or future mutation queue.
All API responses use no-store. Browser recovery never automatically resends entry.

A server-issued canonical ID/hash binds owner, instance, simulation session, preview,
normalized intent and selected fleet. The canonical ID becomes the existing controller
master ID; legacy browser UUIDs are immutable aliases. PENDING is stored before the
first controller side effect. Same ID/hash returns status; changed payload conflicts.
Expired requests fail. UNKNOWN remains unsafe even after cleanup or reconciliation.

Production freshness/preview policy remains 5,000ms. The UI advances evidence age
with a monotonic browser clock and invalidates previews on foreground/pageshow/network
loss. The server rechecks expiry, fresh evidence, halt and ownership before acceptance.
A heartbeat alone cannot establish protection. Preview refresh explicitly refreshes
synthetic quotes and reconciles books.

One locally provisioned owner controls one host/instance. Direct private HTTPS over
Tailscale avoids forwarded-identity trust. Only the production loader accepts exact
HTTPS tailnet origin, assigned private IP, protected key/config, matching certificate
and ACTIVE host identity. Pairing is unnecessary because there is no remote registration
or control plane. Each invited owner needs their own isolated host/runtime; shared
multi-tenant hosting is outside this release.

The O_EXCL lock has no automatic expiry, takeover or failover. Accepted work survives
phone disconnection/logout. Graceful shutdown waits for accepted work before releasing
ownership. Restart revokes authentication, reconciles, preserves positions and circuit
state and stays HALTED. Missing/moved/corrupt identity fails closed. Recognized legacy
journals adopt in place through ADOPTING → ACTIVE, with immutable ownership binding;
legacy previews cannot execute and incomplete legacy claims cannot bypass reset.

## Automated validation

Environment: Ubuntu 26.04 x86-64 development host, Node **24.18.0**, pnpm **11.25.0**,
Playwright **1.62.1**, bundled Chromium **151.0.7922.34**. The documented first deployment
target is Ubuntu 24.04 LTS x86-64; this was not a fresh Ubuntu 24.04 installation.
Commands used the pinned pnpm launcher `npx pnpm@11.25.0` because global pnpm was absent.

| Command                                                                                                            | Result                                                                                              |
| ------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------- |
| `pnpm install --frozen-lockfile`                                                                                   | PASS; lockfile unchanged                                                                            |
| `pnpm exec playwright install chromium`                                                                            | PASS                                                                                                |
| `pnpm typecheck`                                                                                                   | PASS                                                                                                |
| `pnpm lint`                                                                                                        | PASS                                                                                                |
| `pnpm format:check`                                                                                                | PASS                                                                                                |
| `pnpm check`                                                                                                       | PASS: **219 tests in 14 files**, including the legacy-reset and queued-flatten shutdown regressions |
| `pnpm exec vitest run tests/browser-execution.test.ts tests/mobile-dashboard.test.ts tests/private-mobile.test.ts` | PASS: **46 tests in 3 files**, exit 0                                                               |

Final suite inventory:

| Test file                 | Passing tests |
| ------------------------- | ------------: |
| risk                      |            19 |
| simulator                 |             8 |
| execution                 |            17 |
| protection                |            33 |
| hedge guard               |            13 |
| beta reliability          |            27 |
| dashboard                 |             7 |
| fixture browser execution |            31 |
| dashboard commands        |            10 |
| mobile dashboard          |            13 |
| private access            |            17 |
| private dashboard API     |            14 |
| private mobile HTTPS      |             2 |
| legacy adoption           |             8 |
| **Total**                 |       **219** |

Independent Sol High review found two consequential issues, both corrected: shutdown
now drains queued cleanup as well as accepted entry before releasing ownership; logout,
expiry and foreground access checks clear private DOM/memory, guard late responses and
retain only a command-status reference on disk. Focused review and regressions passed; the final independent review reported no
outstanding consequential source finding.
Browser tests also use guaranteed mock-route cleanup and the application’s canonical
shutdown path. A diagnostic run located an intermittent timeout at the test’s manual
`server.close()` before `app.close()`, with one remaining TLS connection. Calling the
canonical application lifecycle drained it; that bypass was removed from the test.
Temporary diagnostic code was removed.

All original 155 tests remain passing. The previous checkpoint's 173 count described
unavailable source, rather than the reconstructed implementation.

## Mobile and manual inspection

Chromium emulation exercised **320, 360, 375, 390 and 430px portrait**, plus
**844×390 landscape**. All three surfaces were checked for page overflow, readable
account risk, visible simulation labeling, touch targets and reachable flatten.
Manifest/icons were fetched and validated; no service worker was registered.

A scripted rendered 390px local workflow completed preview → confirmation → ten
PROTECTED positions → Accounts review → flatten. A subsequent process restart of
that same local runtime adopted legacy ownership in place, retained the existing
COMPLETE command, zero positions and HALTED state. No records were removed to start it.

Two private HTTPS browser tests demonstrated unauthenticated rejection → sign-in →
preview → one accepted command/ten protected simulated accounts → lost response/reload →
phone-context offline/online → status recovery with the same command and no extra
entries → flatten/reconcile → logout/revoke-all. Expiry and process restart revoke
sessions; sign-in retrieves the prior COMPLETE command and protected books while HALTED.
Tests use an isolated self-signed localhost certificate with verification bypass only
inside the fixture, not the production configuration loader.

The generated [Trade screenshot](images/mobile-private-trade.png) and
[Accounts screenshot](images/mobile-private-accounts.png) were visually inspected.
`CAPTURE_MOBILE_EVIDENCE=1` opts into regenerating these browser artifacts; routine
checks do not overwrite evidence. The chrome-devtools-axi bridge failed with a page-ID
validation error, so inspection used the project's working Playwright stack.

## Security and recovery evidence

Tests reject missing/forged/expired/revoked authentication, foreign command ownership,
wrong instance, forged account IDs, altered owner/instance payload fields, changed
command hashes, unknown IDs, malicious Host/Origin, missing CSRF, forwarded identity
claims, stale evidence and expired delayed/offline entry requests. Same-ID replay
returns a result without another simulated trade. No unauthorized account/command
state is exposed. Cookie attributes, fixed expiration, logout and revoke-all are tested.

TLS tests reject wrong SAN, expired/not-yet-valid certificate and mismatched private
key. Configuration/key permissions and revoked instance are checked. Production loader
rejects localhost/public configuration; test-only direct construction is explicit.
Host/path identity copies, malformed/missing records, foreign legacy owners and changed
adoption inventory fail closed. Partial adoption resumes with unchanged UUIDs and
bindings. Conflicting workers are rejected; shutdown retains the lock until accepted
execution settles. Interrupted acceptance and unfinished legacy claims halt and cannot
be cleared with reset, restart or startup reset flags.

No pairing tokens exist, so expired/reused/stolen token endpoints are not applicable.
There is no remote instance reassignment endpoint.

## Known limitations and tracker acceptance

Customer target correction: **Windows and macOS are the intended execution hosts**.
The initial Ubuntu selection is a Linux reference implementation, not the customer
deployment requirement. Current dashboard startup depends on Linux machine identity
and Unix permissions. Native desktop support and validation remain open in
[the desktop host gate](desktop-host-support.md); previous Linux results remain
valid evidence for that implementation, not proof of Windows/macOS compatibility.
The tracker’s host-definition and customer-onboarding items are reopened for these
targets; the completed Linux reference guide is retained.

The implementation and automated acceptance are distinct from invitation readiness.
No physical iPhone/Android, real Home Screen installation, real screen lock/BFCache
suspension, trusted HTTPS over a user's tailnet, clean supported-host installation or
actual host sleep/reboot was available. Process restart and browser offline simulation
are the recorded substitutes, not claims that those hardware cases passed.

Issue #1's supported implementation evidence covers mobile UX, manifest/assets,
freshness/UNKNOWN display, phone browser cases, host/deployment definition, private
HTTPS/authentication, owner/inventory binding, exclusive execution and durable command
semantics, and host instructions. The screen-lock/device acceptance and final phone
stage gate remain open. Host hardware/deployment acceptance remains open before
inviting another owner. No permission or connected-execution box is supported.

The first release has one owner/instance per host, no shared cloud control plane,
no managed provisioning and no automatic recovery re-arm. Machine binding assumes
unique Linux machine IDs and a trusted host administrator, not malicious-admin or
distributed fencing guarantees. UNKNOWN must remain halted pending reviewed operator
investigation. Certificate renewal and host availability are operator responsibilities.

## Git history and publication

- `4b821c8`: mobile simulation, PWA assets, freshness and durable command recovery.
- `a91ea63`: private HTTPS, authentication, ownership, legacy adoption, halted recovery
  and security/restart coverage.
- The accompanying documentation commit and verified remote main reference are recorded
  in Issue #1 after publication; this report is part of that documentation commit.

The historical `9d6b85e` application commit was not recovered or pushed. The source
is reconstructed, not a continuation of that unavailable Git object. Before tracker
updates, remote main must be verified to contain the new application and test files.

## Next gate

**Vest-connected execution remains blocked until the permission and visible-capability
review defined in Issue #1 is completed.** No real account or funded experiment is
authorized by this simulation work.
