# Native desktop simulation validation

This report supplements the [mobile/private validation](mobile-private-validation.md).
The application remains **SIMULATION ONLY**. Native engineering and automated
acceptance are separate from the physical desktop/phone acceptance in Issue #1.

## Implementation

- Windows MachineGuid and macOS IOPlatformUUID supply stable native machine bindings.
  Existing Linux machine hashes, owner/instance IDs and runtime schemas are preserved.
- Windows uses current-user SID ownership and real protected DACLs. Private creation,
  publication and lock removal use native handles; junctions, reparse points, UNC,
  nonlocal/non-NTFS paths and multiple file links are rejected.
- macOS checks ownership, private modes and native extended ACLs on the same opened
  descriptor. Absent ACLs are distinguished from unreadable ACLs; actual extended
  entries remain rejected. Writes use file synchronization and `F_FULLFSYNC`.
- POSIX exclusive native rename publishes a fully written record without an
  intermediate hard link. Collisions preserve the authoritative private record;
  unsupported native operations/filesystems fail closed.
- Fresh SQLite journals receive private access before SQLite opens them. Existing
  journals are validated and preserved. Existing unsafe storage fails closed;
  the Linux reference guide includes an explicit in-place `0755` to `0700` upgrade.
- `dashboard --runtime` selects an explicit runtime without relocating old state.
  `host:doctor` performs read-only, redacted preflight and never establishes execution
  readiness. `host:protect` hardens only an explicitly selected valid TLS key.
- Native onboarding and a physical acceptance checklist cover private HTTPS,
  sign-in, identity verification, shutdown, restart, revocation and conservative recovery.

The existing engine, risk sizing, hedge guard, journal, command identity, circuit
breaker, reconciliation, fill-anchored reduce-only protection and emergency flatten
remain in place. No second controller or risk engine was introduced.

## Major files

| Files                                                                                                            | Purpose                                                                                                |
| ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `packages/host/src/storage.ts`, `windows.ps1`, `windows-native.cs`                                               | Native identity, access checks, private publication and owned-lock handling                            |
| `packages/simulator/src/storage.ts`                                                                              | Integrate native storage around the existing journal/session lifecycle                                 |
| `apps/dashboard/src/identity.ts`, `legacy-adoption.ts`, `private-access.ts`                                      | Preserve identity/adoption and authenticate against protected native storage                           |
| `apps/dashboard/server.ts`, `setup-private.ts`, `host.ts`, `src/host-diagnostics.ts`                             | Explicit runtime startup, provisioning and redacted host commands                                      |
| `tests/host-storage.test.ts`, `host-diagnostics.test.ts`, existing reliability/access/browser tests and fixtures | Actual platform permissions/links, publication, ownership, diagnostics, restart and browser acceptance |
| `.github/workflows/native-host.yml`, `vitest.config.ts`, `.gitattributes`                                        | Native matrix, reproducible fixture execution and consistent checkout line endings                     |
| `docs/native-host-setup.md`, `desktop-phone-sanity-check.md`                                                     | Native development setup and unfilled physical acceptance record                                       |

## Decisions preserved

The phone is an authenticated controller for one simulator on the customer's
computer. Localhost remains the default. Remote access explicitly requires private
Tailscale HTTPS, an assigned private IPv4 address, the exact configured origin and
host, protected TLS files and host-generated credentials. Sessions are opaque,
server-authorized, Secure/HttpOnly/SameSite=Strict, expiring and revocable; mutations
require origin and CSRF validation. Browser-supplied owner/account identities confer
no authority. Direct locally provisioned sign-in does not require a pairing service.

The PWA has a manifest and Home Screen assets, with no service worker, offline queue,
background mutation delivery or blind retry. The five-second application freshness
and preview policy is unchanged. Reachability is distinct from fresh account evidence.

Accepted commands retain their existing durable ID, payload hash, account selection,
owner/instance and timing binding. Same ID/payload recovers status; conflicting data,
stale entry or unauthorized status access rejects. Reload and lost response query the
accepted command. UNKNOWN blocks unsafe new entries. A browser disconnect does not
abandon the host's responsibility for accepted work.

Exactly one process holds a runtime's exclusive execution lock. Crash locks remain
for authoritative operator review; PID absence does not authorize takeover. Restart
preserves journals, positions, balances and circuit state, reconciles and stays HALTED.
PENDING recovery becomes UNKNOWN. Cleanup does not rewrite an earlier unsafe outcome.
No automatic failover, identity reassignment or re-arm is provided.

## Automated results

Application source: `df5a2c4`, with native corrections in `5f8d81a`.
Final fixture configuration: `ec387ac`; diagnostic assertions: `6170f2a`.
Latest [native CI run](https://github.com/Mahdi451/vest-fleet-controller/actions/runs/36790130635).
Results below distinguish native automated runs from physical acceptance.

| Environment                                | Full `pnpm check`                                       | Separate browser suite                                                                                       |
| ------------------------------------------ | ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Local Linux development host, Node 24.18.0 | PASS: 238 passed, 4 platform skips; 16 files, 242 total | Earlier unchanged application run: 46 passed in 3 files; latest fixtures are also included in the full check |
| Ubuntu 24.04 x64 regression                | PASS: 238 passed, 4 platform skips; 16 files, 242 total | PASS: 46 tests in 3 files                                                                                    |
| Windows Server 2025 x64                    | PASS: 238 passed, 4 platform skips; 16 files, 242 total | PASS: 46 tests in 3 files                                                                                    |
| macOS 15 Apple silicon                     | PASS: 240 passed, 2 platform skips; 16 files, 242 total | PASS: 46 tests in 3 files                                                                                    |
| macOS 15 Intel                             | PASS: 240 passed, 2 platform skips; 16 files, 242 total | PASS: 46 tests in 3 files                                                                                    |

Local commands used the pinned package manager through `npx pnpm@11.25.0`:

```sh
pnpm typecheck
pnpm lint
pnpm format:check
pnpm test
CI=1 pnpm check
pnpm exec vitest run tests/browser-execution.test.ts tests/mobile-dashboard.test.ts tests/private-mobile.test.ts
```

Runner metadata: Ubuntu Linux `6.17.0-1022-azure`, Node `24.21.0`; both Mac
runners Darwin `24.6.0`, Node `24.20.0` (ARM64) and `24.19.0` (Intel).
Windows Server reports `10.0.26100`, Node `24.21.0`. pnpm is `11.25.0` throughout.
The full matrix and each separate browser suite passed at `6170f2a`.

Native CI runs `pnpm check` and the separate browser command on every matrix runner.
Tests cover real ACL grants, links/junctions, publication collisions, competing/stale
owners, unchanged records, wrong owner/instance/account/command, malicious origins,
missing CSRF, expired/revoked authentication, stale/expired entry, payload conflicts,
same-command recovery, unknown outcomes, unsafe/protected books and circuit halts.

The test-only browser fixture uses the adapter's existing three-second maximum;
its production default remains 1.5 seconds. CI runs test files sequentially to reduce
renderer contention; explicit concurrent-command and duplicate tests remain concurrent.
The Node HTTPS restart fixture avoids sockets pooled from the stopped server.
Application entry freshness and command expiry were not relaxed.

Independent review found and resolved the old Linux directory upgrade, dangling-link
diagnostic and hard-link publication recovery issues. The native Mac absent-ACL
correction also received targeted review. Deterministic tests preceded review.

## Mobile and workflow evidence

Existing Playwright/Chromium acceptance exercises widths **320, 360, 375, 390 and
430 px**, plus landscape **844 × 390**, Trade/Accounts/Activity, readable previews,
touch controls, SIMULATION labels, reachable flatten and valid manifest assets.

The private HTTPS browser workflow demonstrates authenticated preview, one protected
intent, lost response/reload/disconnect recovery without duplicate entry,
flatten/reconcile and logout/revocation. The restart workflow retains protected books,
rejects old authentication and keeps entries HALTED. Certificates and fleet state in
these tests are isolated synthetic fixtures.

A separate localhost CLI runtime check on the Linux development host launched the
dashboard with an explicit fresh private runtime, read its ten simulated accounts
and provisioned identity, stopped normally with SIGINT, and restarted. Identity and
runtime records were preserved; the restarted simulator remained HALTED, and both
normal shutdowns released only their owned locks. This checks the real startup
command, not a physical desktop reboot or private-network deployment.

This is **Chromium emulation**, not an actual iPhone/Android or trusted tailnet trial.
Windows Server CI is not physical Windows 11 acceptance. Actual Home Screen launch,
screen lock/backgrounding, desktop sleep/reboot and fresh-machine onboarding still
need the [manual record](desktop-phone-sanity-check.md). Those boxes remain empty.

## Limits and next gate

- A prior Windows combined run failed its all-account protection assertion while
  the separate browser suite passed. The latest combined run passed. The older
  failure did not capture per-child outcomes, so its cause is unconfirmed; preview
  expiry during sequential execution under load is a possible explanation. New
  diagnostic assertions retain synthetic outcomes on recurrence. No production
  freshness/deadline was relaxed and no test retry was added. Record per-account
  outcomes and fleet timing during physical acceptance; this is not evidence that
  every machine will finish ten entries inside the preview window.
- The development beta still requires Git, Node, pnpm and native private-network setup.
  Signed Windows `.exe` and signed/notarized Mac `.app`/`.dmg` packages remain scheduled
  near release completion; no installer artifact is claimed.
- Windows supports local fixed NTFS storage. POSIX exclusive rename requires native
  filesystem support; the Linux reference route uses modern Ubuntu/glibc. Unsupported
  hosts or storage fail closed rather than inventing another binding or copying state.
- Windows file flush/publication verification supports process-crash recovery;
  sudden power-loss rename durability is not claimed. Physical power behavior is open.
- The host must remain awake. Certificates require deliberate renewal; restart loads
  new files and revokes sessions. No managed hosting, auto-start/failover service,
  public signup, billing or customer runtime migration is added.
- Retained locks and unresolved records require conservative recovery. This beta has
  no balance-preserving automatic re-arm or journal-reset shortcut.

Next, complete the physical checklist on the actual intended Windows/Mac host and
phone before customer invitation. Vest-connected execution remains blocked until the
permission and visible-capability review defined in Issue #1 is completed.

## Git history and tracker

- `6ac02c5`: schedule native installers near final release.
- `df5a2c4`: native Windows/macOS protected runtimes, diagnostics and native tests/CI.
- `f5927c8`: native setup and desktop/phone acceptance checklist.
- `5f8d81a`: native absent-ACL correction and consistent checkout line endings.
- `ec387ac`: isolate restart/browser fixtures during native CI.
- `6170f2a`: retain synthetic command-result diagnostics on protection assertion failure.

The following Issue #1 items are supported by this implementation and linked native
automated evidence:

- Define native Windows/macOS host deployment routes, retaining localhost by default.
- Provide native installation/startup/shutdown/recovery instructions for this
  development beta. Final customer installers remain separate.
- Implement and validate native host identity, protected storage and durable runtime
  handling while preserving existing ownership and records.

Physical phone/screen-lock, actual phone stage exit and pre-invitation sleep/reboot
acceptance remain unchecked. Permission, connected execution, funded trials and
release-installer checkboxes remain unchecked.
