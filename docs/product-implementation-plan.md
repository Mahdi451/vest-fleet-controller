# Customer product implementation and acceptance plan

Current priority: [security-first audit and local adoption plan](security-first-adoption-plan.md).
The owner's local-only private copier takes precedence over customer packaging,
remote phone access, UI polish and older transport assumptions in this document.
Live execution remains disabled pending the plan's security and evidence gates.

Active execution direction as of 2026-10-05: [the browser bridge goal](browser-bridge-goal.md).
It supersedes this document's UI-only transport choice. The offline bridge is
implemented through the existing durable controller; authenticated integration
and live sending remain disabled. The dated milestones below retain the earlier
planning context.

Prepared 2026-09-30. Scope: an invitation beta where each customer controls their own
Vest Instant-account fleet through our mobile dashboard. The current build is a local
simulation prototype. Mobile UI, durable commands and private single-owner HTTPS
authentication are delivered in the [validation report](mobile-private-validation.md);
no real account connection, production browser driver or managed hosted service exists.

Use [the prototype checklist](prototype-todo.md) for shipped functionality and the
[fact register](vest-facts.md) and [browser investigation](browser-execution.md) for
Vest permissions, sources and visible-evidence gates. This plan does not authorize live
orders or replace those gates.

## Recommended first release

One verified market, MARKET entries initiated in our app, independent sizing,
leverage/equity-as-margin presets, fixed stop and target distances, per-account preview,
sequential execution, fill-anchored reduce-only protection, account/group flatten,
audit history, explicit health and operator recovery. Preserve all current risk,
hedge, journaling, duplicate prevention and uncertainty rules.

Customers initially run one isolated execution instance on their own **Windows or
macOS computer**; their phone controls it through private authenticated HTTPS. These
are the customer deployment targets. Linux is a development/reference environment,
not a required customer installation. Native desktop host support is implemented;
physical host/phone acceptance is still required
without weakening ownership or secret protection. Release only the platforms with
recorded native acceptance. See [desktop host support](desktop-host-support.md).

Continuous watching of a leader account, additional markets, position additions,
reversals, ongoing partial-fill remainders, live TP/SL replacement, public signup,
billing automation and parallel browser workers are outside the first beta. Current
core rules require flat accounts for new entries and support confirmed terminal partial
fills; the UI must accurately describe those limits.

## Two separate identities and sessions

| Session      | Purpose                                                                            | Ownership                                                     |
| ------------ | ---------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| Our product  | Identify the customer, authorize their worker and fleet, protect dashboard actions | Our application                                               |
| Vest website | Access the customer's actual funded-account interface                              | Vest's normal supported login in the execution host's browser |

Google sign-in may identify a user to our application. It does not grant access to
Vest or transfer the phone's Vest login to a desktop/VPS browser. Even if Vest itself
offers Google login, that is its own login flow and session. No Vest account-link OAuth
contract is established. Do not advertise one-click Google-to-Vest account connection.

Google documents the distinction between authentication and authorization and notes
that application session management remains the application's responsibility [1].
Implement verified identity, an opaque secure application session, expiry/revocation,
CSRF protection, exact origins, logout and tenant authorization on every operation.
Use immutable identity-provider subjects instead of email alone as ownership keys.
Private-device authentication is acceptable for an initial supervised personal pilot;
it is not a substitute for authorization between multiple customers.

### Proposed connected journey — Vest steps remain blocked

1. Sign into our app or the explicitly private personal pilot interface.
2. Install/start the execution worker; pair it with the customer through an expiring,
   single-use code that is bound to the intended instance and owner.
3. Open a visible Vest browser on that execution host. The customer completes Vest's
   official login and MFA directly. We do not collect Vest passwords in our forms.
4. Verify identity and account inventory through supported visible UI. Show only
   positively identified accounts; bind each selected account's immutable ID/label,
   owner and execution instance. Account visibility is not proof of API access.
5. Reconcile positions, orders, unresolved submissions, protection and risk metadata.
   Existing positions prevent new entries until reviewed under the beta's rules.
6. Configure account selection, risk profile, reserve and drift tolerance. Use preview
   and simulation before an explicitly authorized connected trial.
7. Show READY only after capability checks, fresh venue evidence, reconciliation and
   explicit operator arming. A process restart or login renewal never auto-arms.

Vest login methods, remote interactive login, MFA, profile persistence, concurrent
sessions and permitted automation must all be verified. If an identity provider or
Vest refuses the proposed browser environment, stop; do not bypass that restriction.
Never embed a fake Vest login or assume an iframe can access the customer's session.

### Session handling

Keep a user-owned browser profile inside their instance only if Vest permits that
persistence; otherwise require a new supported login. Treat its storage as sensitive
credential material [2]. Use restricted filesystem permissions, encrypted host storage
and retention/revocation controls; do not put session state in git, logs, screenshots,
diagnostic exports or ordinary backups. The browser can use its normal session; the
controller cannot extract/replay cookies or tokens as an unofficial API.

For local pilots, access remains on the customer's machine and operators do not have
central access to profiles. Hosted execution adds a separate security boundary:
secrets isolation, encrypted persistent storage, controlled interactive login,
restricted staff access, retention/deletion and incident response must be reviewed
before that option is offered.

## Deployment choices

API versus visible UI describes how we communicate with Vest. Local versus cloud
describes where the execution instance runs. These are independent decisions.

| Option                     | Benefits                                                                                           | Limits / release decision                                                                                                                                    |
| -------------------------- | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Customer computer          | Windows/macOS target; local session ownership, direct interactive login, personal feasibility test | Sleep, reboots, home network and maintenance affect availability. Recommended first pilot.                                                                   |
| Customer-owned VPS         | Can keep the worker/browser running while the phone disconnects; customer owns infrastructure      | Verify Vest/identity-provider permission for the host, IP/location and login workflow; updates and outages remain possible. Optional after local validation. |
| Managed dedicated instance | Simplest eventual customer experience; we provision, monitor and update each worker                | Requires accepted hosting/session terms, profile custody controls, tenant isolation, support and tested operations. Separate release gate.                   |

Tradecopia documents both local desktop execution and a hosted dedicated instance
accessible from a browser [3]. Browser execution could also be hosted, if permitted;
neither APIs nor VPS hosting guarantee availability or correct trade outcomes.

Prefer one worker per customer. Before adding a shared cloud control plane, enforce
ownership on commands, results, sockets, files and support access; never accept an
account ID supplied by a browser without resolving it through the authenticated owner.
Keep phone control distinct from the execution instance. A disconnected phone does
not terminate an already accepted job; the worker remains responsible for protection.

## Command, ownership and recovery requirements

- Persist a command's deterministic ID, payload hash, owner, instance, selected fleet,
  issue/expiry times and preview reference before its first potential side effect.
  A repeated ID returns known status; changed payload conflicts. Do not store secrets.
- Reject stale or disconnected submissions. No offline trading queue, service-worker
  replay or delayed execution of an expired trade. A received cleanup command may be
  attempted while degraded if identity is verified; do not require a fresh entry preview.
- The phone must be able to query a command after losing its response. UI double taps,
  reconnects, multiple phone tabs and app reloads must not mint replacement entries.
- Enforce one active execution owner and serialized browser actions. A control-plane
  lease alone cannot cancel a UI click already sent. Never automatically fail over to
  another host while the old host or accepted entry could still be active.
- Renewed login or restored connectivity requires authoritative reconciliation,
  quiescent old execution and explicit operator review. An empty position table alone
  does not prove a timed-out entry cannot fill later.
- Separate controller/browser reachability from venue evidence freshness. Display
  last verification age, pending/unknown commands, affected accounts and protection
  status. A green network heartbeat must not imply a protected position.
- Verify venue-held SL/TP semantics. If the host dies before protection, the position
  may remain unprotected. If it dies after protection, do not claim venue durability
  until independently documented/tested. Browser-based flatten may be unavailable;
  customer instructions must include manual recovery via Vest's normal UI.
- Reuse the existing circuit breaker, journal and recovery flow. Add explicit arming
  only after proving recovery; do not clear a halt by deleting records or resetting a
  customer fleet to fictional balances.

## Staged implementation timeline

Effort bands below are planning targets in **active coding/review sessions**, not
elapsed calendar dates or autonomous background work. A session length and throughput
have not been measured. External permission, UI capability discovery and actual market
validation cannot be compressed into a coding estimate. Re-estimate after stage C.

| Stage                           | Effort target                                          | Concrete output                                                                                                                          | Release criterion                                                                                                                                                     |
| ------------------------------- | ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A. Mobile simulation            | 1–3 sessions                                           | Focused Trade/Accounts/Activity UI, Home Screen assets, stale/disconnected state, touch-safe preview and flatten                         | Phone browser tests pass; synthetic mode unmistakable; existing checks remain green.                                                                                  |
| B. Native private desktop host  | Re-estimate after portability review                   | Native Windows/macOS host identity/storage, HTTPS/auth, instance ownership, expiring commands, status recovery and setup instructions    | Native platform checks pass; unauthorized/replayed/cross-owner commands rejected; disconnect/restart cannot duplicate an accepted job.                                |
| C. Vest feasibility             | 1–3 inspection/review sessions after permission/access | Verified login path, accounts, market/rules, fill/protection/exit evidence, measured sequential UI timings                               | Applicable execution terms reviewed, exact trial authorized and all required capabilities proven. Stop or narrow the product if absent.                               |
| D. Permitted one-account driver | 2–4 sessions after C                                   | Visible UI transport, real account binding, entry/fill/protection/exit reconciliation; initially non-trading/read-only                   | Contract and fault tests pass; no invented evidence, private endpoints or automatic write retries. Required pre-integration review complete before any funded action. |
| E. Operational acceptance       | 2–4 sessions, reusing existing safeguards              | Session loss/restart/manual intervention/orphan handling, explicit recovery UI, diagnostics, worker monitoring and version gate          | Tests below pass; unknown exposure blocks entries; old/new worker ownership cannot overlap.                                                                           |
| F. Supervised invitation pilot  | Several real permitted test/trading sessions; measured | Approved paper/test if available, then minimal one-account trial, two accounts, small fleet, up to ten                                   | Separate trade authorization, correct fills and exits, complete protection/cleanup, agreed latency/drift limits and documented recovery.                              |
| G. Customer release packaging   | Estimate near feature/recovery completion              | Signed Windows `.exe` installer and signed/notarized macOS `.app`/`.dmg`; bundled runtime/assets, launcher and update/uninstall behavior | Clean-machine install/launch, safe update/recovery and uninstall tests pass; journals/identity preserved; platform and release scope explicit.                        |
| H. Managed hosting              | Estimate after local pilot                             | Dedicated-instance provisioning, secure interactive login/profile custody, monitoring and incident procedures                            | Hosted permission/security/restore tests pass. Not required for the first customer-owned-host pilot.                                                                  |

Stages A/B and fixture tests can progress while policy questions are being resolved.
Native Windows/macOS host portability and onboarding are now required before
customer-host acceptance; the Linux reference run does not satisfy that gate.
Stages C–F are dependent gates. We can demonstrate mobile simulation promptly; we cannot
assign a defensible connected-customer launch date before C. Do not combine effort
bands into a calendar promise without measured session length and external resolution.

## Browser-first connection milestone — current decision

Treat this as an independent browser-based Vest copier, built around the actual
visible interface and the existing controller. Stop routine Vest documentation/API
research as the implementation path. Retain the dated source register and known
restrictions; this decision does not enable private endpoints, token/cookie replay,
authentication bypass or real orders. Missing UI evidence remains unknown.

Immediate work, in order:

1. The unexpected headed-browser closure remains undiagnosed. As of 2026-10-03 the
   owner set that recovery aside. Preserve the quarantined profile, observer locks and
   execution records. Do not delete them to force a launch, and do not automatically
   restart or take over an ambiguous session.
2. Inspect the visible **Sign in with Google** option and make it the first login path
   to test. The owner completes Google authentication/MFA directly. A new dedicated
   profile may require Google sign-in; existing everyday Chrome authentication is not
   copied into it. Email login remains an alternative if normally supported.
3. The reviewed sign-in phase allows the observed same-page `accounts.google.com`
   origin until the main frame returns to Vest. `ready` before that return is rejected.
   Popups and every other origin still quarantine the session. Quit keeps the Chromium
   profile, so the next launch can reuse a Vest session that Google and Vest still
   accept. A completed owner login, MFA return, and funded identity are not yet
   verified. Do not capture authentication URLs, authorization codes, tokens or
   credentials.
4. Verify the returned Vest identity corresponds to the owner's intended funded fleet.
   Discover complete visible inventory and inspect serialized switching, exact account
   identity, current positions and existing fills/protection/closing without orders.
5. Build the real read-only evidence port from inspected semantic selectors. Measure
   switching/read/scan latency; assess exact quantities, fill linkage, freshness,
   reduce-only protection, persistence and sibling cancellation. Preserve null/unknown
   values; do not substitute fixture IDs, prices, fees or timestamps.
6. Only after capability/recovery review and separate authorization, implement and test
   the one-account execution path through the existing controller, then expand the fleet.

Initial copying originates from our application master command. Monitoring trades
manually placed on a leader account remains future work. Visual polish/installers stay
paused; Windows/macOS are customer hosts and phone access is a supporting surface.

## Near-final customer release packaging

Installer/release packaging is scheduled **near the end**, once the chosen release's
features, security and recovery behavior are nearly finalized. It is not the next
coding task. A simulation release may be packaged after its own acceptance; a connected
release also requires the permission, capability and supervised-validation gates.

Deliver a signed Windows `.exe` installer and an equivalent signed/notarized macOS
`.app` distributed in a `.dmg` or suitable native package. Bundle the supported Node
runtime and application/assets so customers do not install Git, Node, pnpm or Linux.
A desktop launcher should start the existing engine, open the dashboard and expose
clear status and graceful shutdown. Preserve the existing dashboard/controller rather
than assuming a framework migration is necessary.

Store configuration, secrets, identity and journals in protected per-user runtime
storage, separate from application installation files. Updates must settle accepted
work and preserve records/bindings; uninstall must not silently destroy unresolved
records or credentials. Validate clean install, launch, update, interrupted update,
shutdown/restart and uninstall on every supported native platform before publishing
versioned release artifacts. Choose installer/signing tooling during that late-stage
work and record checksums and supported OS/architectures with the release.

## Acceptance test matrix

Existing tests are the baseline; extend them where missing instead of duplicating
controllers, journals or risk calculations. Fake login pages are original fixtures;
automated tests must not attach to real Vest accounts.

| Area                | Essential cases                                                                                                                         | Required outcome                                                                                                                        |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| App identity        | Invalid/expired login, logout, wrong owner, forged forwarded identity, missing CSRF, malicious origin                                   | No unauthorized account data, status or mutation; tokens absent from logs.                                                              |
| Instance pairing    | Expired/reused/stolen code, wrong customer, revoked worker, changed account inventory                                                   | Pairing cannot silently reassign ownership or allow a second execution owner.                                                           |
| Mobile commands     | Double tap, lost response, screen lock, two tabs, reload, offline cache, expired preview/command                                        | One durable outcome; no queued offline entries or blind resubmission.                                                                   |
| Vest authentication | MFA challenge, session expiry, logout, denied login, unsupported browser, login changed mid-batch                                       | Pause entries; identify session loss; approved login handoff and reconciliation before re-arm.                                          |
| Account context     | Wrong account, same label/different ID, switch lag, another tab changes account, terminated/replaced account                            | Abort before any new entry; precise account correlation remains mandatory for cleanup.                                                  |
| Quote and rules     | Stale quote, unavailable fees, precision/size mismatch, leverage rejected, unknown daily floor, market closed, clock skew               | Reject unsafe/unknown entry; clock synchronization does not manufacture venue freshness.                                                |
| Entry               | Partial terminal fill, working remainder, timeout after accepted click, duplicate/late evidence, price drift, crash after fill          | Protect actual terminal quantity; unresolved remainder blocks progression; no duplicate click; unsafe child halts and attempts cleanup. |
| Protection          | SL/TP rejection, one missing order, wrong qty/price/side/position, unknown reduction/trigger semantics, gap during unprotected interval | Both confirmed before success; failure flattens if possible and halts even if cleanup cannot be confirmed.                              |
| Exit/OCO            | SL fills, TP fills, simultaneous triggers, manual close, stale sibling, cancellation race, orphan/paginated orders                      | No reversal; final flat state plus terminal order status proven; ambiguity stays halted.                                                |
| Fleet               | Early children protected then later rejection/timeout, insufficient buffer, disabled account, unselected opposite exposure              | Per-child outcomes explicit; stop later entries per policy; existing hedge behavior preserved pending documented scope decisions.       |
| Manual intervention | Outside trade/close, leverage or protection edit, withdrawal, account disabled after entry                                              | Detect divergence and halt new entries; recompute equity/risk; disable never implies flat.                                              |
| Host failure        | Sleep/reboot, network/browser loss, SQLite/disk full, browser freeze, clock jump, version mismatch, crash between journal and click     | No unsafe retry or automatic re-arm; diagnose unresolved exposure; manual recovery possible.                                            |
| Dual ownership      | Worker restarted while old instance remains alive, stolen lease, partitioned old host                                                   | No automatic failover/re-entry; old actions accounted for before another worker is armed.                                               |
| Customer isolation  | Customer A requests B's command/account/file/socket, shared browser/profile, diagnostic export                                          | No cross-customer data/session/execution access. Customer trades never share mutable browser state.                                     |
| Operations          | Schema upgrade/rollback, old backup restore, deletion/unpair with open positions, rolling update                                        | Preserve unresolved records; backups cannot authorize replay; update only with reconciled safe state or reviewed recovery.              |

## Unresolved gaps that must not be hidden

1. A session or browser profile is still credential material even if no password is
   stored. Hosted operation increases custody and support responsibilities.
2. Current fixture pages expose full IDs, precision, costs and deterministic request
   IDs; actual Vest may not. Our journal prevents repeated controller clicks, not
   venue-side deduplication of every human/browser action. Missing proof is a blocker.
3. Ten sequential entries are not simultaneous. Measure switch/submit/fill/protection
   latency, first-to-last drift and failed child outcomes. For short scalps, reject the
   workflow if observed drift/latency exceeds the user's explicit tolerance; no invented
   millisecond promise or arbitrary lengthening of preview freshness.
4. Daily loss/reset, drawdown basis, maintenance margin/liquidation, fees/funding,
   trading hours and withdrawal behavior need product-specific evidence. A fixed $490
   simulator floor does not certify every customer's account.
5. The user's current hedge guard ignores disabled accounts. Vest policy may consider
   their exposure anyway. Resolve that scope before funded use; do not silently change
   the requested guard or describe it as complete compliance. Correlated-instrument
   restrictions remain unverified; retain extensibility without automatic blocking.
6. Manual trades, additional funded accounts outside the selected group, social
   signals and copying into other owners' accounts require separate permission and
   exposure scope. An app-disabled account must not be treated as closed.
7. The current simulator provides sibling/OCO behind the browser fixture. No live
   browser OCO monitor, protected-order replacement or production login exists.
8. Sustained runtime does not require trading continuously. Restrict operations to
   verified instrument hours, reviewed maintenance windows and healthy armed sessions.
9. Notifications inform the operator but cannot be the only protection mechanism.
   Process availability, human response and venue-held protection are separate concerns.
10. Public distribution requires reviewed commercial permission/applicable terms,
    customer support and accurate product claims. Native copier availability and any
    future funded API are unverified dependencies; neither is a promised delivery path.

## Definition of first connected beta completion

A new invited customer can install a supported worker, sign in through approved flows,
identify their own accounts, preview independent risk, execute at the authorized test
scope, verify each fill and both protections, inspect outcomes, exit/flatten, and recover
from disconnect or restart without duplicate exposure. Tenant isolation, stale-data
rejection and manual emergency instructions are verified. The allowed account count
comes from completed staged trials. Simulated readiness is never labeled live readiness.

## Planned files — reuse existing boundaries

| Location                       | Purpose                                                                                                      |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------ |
| `apps/dashboard/public/`       | Mobile UI, install assets, ownership/connection age, preview and result recovery                             |
| `apps/dashboard/server.ts`     | Configured HTTPS proxy/auth boundary, exact origins, authenticated commands/status                           |
| `apps/worker/` (new if needed) | Single instance lifecycle, pairing, browser handoff, host ownership, heartbeat; no alternate risk engine     |
| `packages/browser-execution/`  | Future permission-gated real DOM driver, session/identity/capability checks; retain local-fixture mode       |
| `packages/execution/`          | Reuse durable journal, controller, reconciliation/circuit; add recovery/command ownership only where missing |
| `packages/core/` and `config/` | Versioned verified venue/account profiles and command/instance identity where required                       |
| `tests/`                       | Extend existing dashboard/controller/browser fixtures; add ownership, auth and host lifecycle tests          |
| `docs/` and onboarding scripts | Installation, evidence/capability matrix, incident/manual recovery and release validation                    |

## Primary references

Sources checked 2026-09-30; publication dates may differ. These explain product identity
and deployment concepts, not permission to automate Vest.

1. Google Identity Services, [integration considerations](https://developers.google.com/identity/gsi/web/guides/integrate): sign-in authenticates users to our site; authorization and application session management are separate.
2. Playwright, [authentication](https://playwright.dev/docs/auth): stored browser state can impersonate an account and must not be committed. This is security guidance, not authority to export Vest sessions.
3. Tradecopia, [Pro+ hosting](https://docs.tradecopia.com/en/articles/15515230-what-is-tradecopia-pro) and [product overview](https://docs.tradecopia.com/en/articles/15515215-what-is-tradecopia): dedicated hosted and local plans; browser access is distinct from where execution runs.
4. Vest's [funded FAQ](https://next.vestmarkets.com/faq), previously browser-verified 2026-09-29: API unavailability and unresolved browser permission are recorded in [vest-facts.md](vest-facts.md); no new authenticated inspection performed for this plan.
