# Mobile/private beta implementation checkpoint

Recorded 2026-09-30. **Implementation is not published or release-ready.**

The execution environment disconnected during the combined acceptance run and subsequently
reported `environment_offline: Environment is not connected`. The cause has not been established.
GitHub remains reachable. This checkpoint preserves the handoff without presenting an
interrupted validation as a pass. The GitHub main branch still contains the earlier simulation
baseline; this documentation commit does not ship the new application code.

## Recorded progress

### Phase A — implemented and locally committed

Local commit: `9d6b85e` — `feat dashboard mobile simulation and durable command recovery`.
This commit was created in the execution workspace, **not pushed to GitHub**. Its availability
must be checked when the execution environment reconnects.

Implemented locally:

- Trade / Accounts / Activity navigation, responsive account preview cards and 44px controls.
- Separate confirmation for a simulated entry; prominent flatten and persistent simulation labels.
- Manifest, standalone metadata, 192/512 PNG branding and 180px Apple touch icon.
- No service worker, offline cache, Background Sync, deferred trading queue or write replay.
- Reachability separated from fresh quote/account/reconciliation evidence and existing health.
- Server-derived canonical command ID/hash, selection, owner/instance/session and expiry.
- PREVIEWED / PENDING / COMPLETE / UNKNOWN envelopes in the existing SQLite execution journal.
- Durable PENDING before dispatch; client persists identity before POST and recovers through reads.
- Duplicate/hash conflict, lost-response, reload, foreground and second-tab handling.
- Interrupted PENDING recovery to UNKNOWN with existing halt preserved.

Recorded full validation:

```sh
BROWSER_TEST_EXECUTABLE=/tmp/vfc-browser/chrome-headless-shell-linux64/chrome-headless-shell pnpm check
```

**PASS: 173 tests in 10 files**, including the original 155 tests.
Typecheck, lint and formatting passed. The new coverage comprised 13 mobile browser cases
and five command/journal cases. A minor phone price-input layout adjustment followed that
run; subsequent targeted validation was interrupted, so final-state verification remains due.

Widths exercised: 320, 360, 375, 390 and 430px portrait, plus landscape.
A separate scripted 390×844 Chromium workflow completed preview → confirmation →
ten protected positions → account review → flatten. Generated screenshots were inspected.
**This was browser emulation, not a physical phone or actual Home Screen installation.**

### Phase B — implemented locally, not committed/published

Local work added:

- Explicit direct Node HTTPS mode; default remains exact loopback HTTP.
- Private tailnet IPv4 binding and exact HTTPS hostname/port validation.
- Certificate hostname/validity and protected private-key/config permission checks.
- Strong generated host access secret, salted scrypt credential hash and bounded login attempts.
- Opaque Secure/HttpOnly/SameSite=Strict cookie with process-local hashed-token lookup.
- Expiring owner/instance-bound sessions, session-specific CSRF, logout and revoke-all.
- Exact origins; no permissive CORS or trusted forwarded identity.
- Remote canonical command binding; authenticated inventory/command ownership checks.
- Stable instance UUIDs, existing exclusive runtime lock and machine/runtime-path binding.
- Graceful shutdown that rejects new work, settles accepted execution, closes connections,
  and only then releases ownership.
- Host setup command and Ubuntu 24.04 x86-64 onboarding/recovery documentation.
- HTTPS access, ownership, expiry, replay, crash/restart and phone workflow tests.
- No pairing tokens: local provisioning plus direct sign-in requires no cloud pairing channel.

Recorded targeted checks:

- **15 private-access tests passed** in one file, covering authorization, origins/CSRF,
  logout/revocation/expiry, forged accounts/commands, owner/instance mismatch, replay,
  restart, host binding, permissions and interrupted-command recovery.
- **Two authenticated HTTPS phone-browser tests passed**, covering the simulated
  protected workflow, lost response/reload, disconnect/reconnect, flatten/reconcile,
  revocation, expiry and halted restart.
- Typecheck and lint passed before the final incremental changes.

The last combined run and final incremental checks have no recovered result.
Do not aggregate these targeted results into a claimed full Phase B pass.

Further local edits were initiated for durable legacy command aliases, monotonic browser
freshness/BFCache recovery and a persistence-failure halt latch. Verify their exact on-disk
state, formatting and tests after reconnection. A sixth command regression test was added.
Do not infer that these final edits were validated.

## Major local files

| Location | Purpose |
| --- | --- |
| `apps/dashboard/public/app.js` | Mobile command identity, status recovery, evidence age and private sign-in |
| `apps/dashboard/public/index.html`, `style.css` | Three phone surfaces, entry confirmation, touch controls, login and safety labeling |
| `apps/dashboard/public/manifest.webmanifest`, `brand/*.png` | Home Screen installation assets |
| `apps/dashboard/server.ts` | Same engine behind freshness/command/auth/TLS boundaries and graceful shutdown |
| `apps/dashboard/src/commands.ts` | Validated canonical command envelope and status |
| `apps/dashboard/src/identity.ts` | Owner/instance and saved host/runtime binding |
| `apps/dashboard/src/private-access.ts` | HTTPS configuration, scrypt credentials, sessions and origin/security policy |
| `apps/dashboard/setup-private.ts`, `package.json` | Protected private-host provisioning command |
| `packages/execution/src/journal.ts` | Command envelopes/aliases in existing SQLite journal |
| `tests/dashboard-commands.test.ts`, `mobile-dashboard.test.ts` | Durable command and phone acceptance cases |
| `tests/private-access.test.ts`, `private-mobile.test.ts`, `fixtures/private-host.ts` | Isolated HTTPS security and phone tests |
| `docs/mobile-beta.md`, `private-phone-access.md`, `private-access-architecture.md` | Local policy, onboarding and architecture documentation |
| `docs/images/mobile-trade.png`, `mobile-accounts.png` | Local rendered simulation evidence |

The core risk engine, FleetController financial logic, hedge guard and simulator were
preserved; no real Vest connectivity or order was added. The private sign-in is our host
access mechanism, not a Vest login.

## Architecture decisions

- Same simulation engine; no alternate risk/execution engine or framework migration.
- Home Screen assets with deliberately no service worker or offline mutation delivery.
- Command envelopes reuse the execution journal and controller's deterministic child IDs.
- Server checks quote/account/reconciliation freshness; heartbeat alone is not protection.
- One owner and one saved execution instance per user-owned host.
- Direct private HTTPS, opaque expiring sessions and separate mutation protection.
- Pairing not needed for this direct-to-host deployment; no pairing tokens issued.
- Exclusive lock plus saved host/path binding; no automatic stale-lock takeover or failover.
- Accepted work remains owned by the host after phone disconnection or logout.
- Restart revokes sign-ins, preserves journals, reconciles and stays HALTED.
- Single-host fencing assumes a unique OS machine ID and trusted host administrator;
  it is not a distributed lease system or protection against deliberately edited identities.

## Remaining work before completion

1. Reconnect the execution environment; inspect git status, local commit and all pending edits.
2. Recover code before making further changes; do not discard journals or secrets to bypass a halt.
3. Complete/review README, DEVELOPMENT, architecture/execution references, prototype checklist
   and validation record so published user instructions match delivered code.
4. Inspect regenerated phone screenshots after the final responsive changes.
5. Run `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `pnpm test` and final `pnpm check`.
6. Re-run browser suites against the final source; report exact counts and negative cases.
7. Review secret handling, ownership/resource filtering, shutdown and accepted-job recovery.
8. Commit Phase B logically; publish application commits and verify remote tree/content.
9. Link published commits and evidence in Issue #1, checking only supported acceptance items.
10. Perform a fresh Ubuntu installation, trusted HTTPS over the user's real tailnet,
    physical Safari/Android Home Screen and screen-lock checks, and actual host sleep/reboot.
    These hardware/deployment checks have not been performed here.

## Tracker status and next gate

Issue #1 remains the source of truth. No new completion checkbox is checked by this
checkpoint: publication and final-state validation are still outstanding, and physical
acceptance must not be implied by Chromium emulation.

Vest-connected execution remains blocked until Issue #1's written permission and visible
capability review is completed. No live Vest login, funded execution, unofficial endpoints,
cookie replay, managed VPS provisioning or public customer signup is authorized or implemented.
