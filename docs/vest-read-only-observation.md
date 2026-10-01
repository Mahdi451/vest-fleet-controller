# Owner-authorized Vest observation runbook

This is preparation for read-only inspection, not a connected trading feature.
A dedicated manual browser launcher is implemented in `apps/vest-observer/`.
It opens the official website for the owner to sign in directly. It has no automatic
credential entry, account selector, evidence parser or trading methods. The offline
contracts remain synthetic and separate from the executable fixture adapter.

## Permission questions to send personally

Do not send these on the user's behalf. These are questions for unresolved execution,
account-scope and commercial decisions. A written letter is not a blanket prerequisite
for the owner-authorized manual read-only step under the public terms reviewed on
2026-10-01. See [the scoped source review](vest-facts.md).

1. May the owner use a dedicated visible Playwright browser, normal manual login/MFA,
   one session/page and serialized switching to read their Evaluation/Live Funded/Instant
   accounts? What account/session/browser-profile restrictions apply?
2. Separately, may the owner automate MARKET entry, post-fill SL/TP, cancellation and
   close through inspected visible controls, copying one application master command
   across their own accounts? Is same-direction copying allowed and how does the
   agreement's single-Account language relate to the ten-funded-account FAQ?
3. Separately, may a commercial product distribute this workflow to other customers,
   each using their own host/session/accounts? What approval, licensing, support,
   automation limits or redistribution conditions apply? Owner permission alone does
   not approve distribution, cross-customer copying or manual leader-trade monitoring.
4. Which account/market identity, exact fill quantity/price/fees, terminal partial-fill,
   history-completeness and quote-update evidence is supported in the funded UI?
   Are stable visible order IDs or client request identifiers available?
5. Are protective orders venue-accepted and browser-independent, reduce-only, and
   linked/OCO? What happens on a partial fill, protective trigger, manual close,
   session loss, orphan protection or sibling-cancellation failure?
6. Which approved paper/test environment is available? What limits and permission
   apply to a later minimal supervised one-account trial?

API trading remains excluded from the plan. No hidden endpoints or session-material
extraction are proposed as a fallback.

## Manual browser setup and handover

Prerequisites: Node 24.x, pnpm 11.25.0, installed dependencies and Playwright Chromium
(`pnpm exec playwright install chromium`). Use the existing initialized native host
runtime; `pnpm host:doctor --runtime .runtime/dashboard` must verify its active owner,
instance and protected storage. The launcher does not initialize a host, open the
execution engine or change safety records. Windows/macOS are the intended customer
hosts; Linux is a development reference. Native interactive sign-in remains untested.

Run from a local visible desktop terminal:

```sh
pnpm observe:vest --runtime .runtime/dashboard --authorize-owner-read-only
```

The explicit flag records **owner authorization**, not Vest approval. The local record
contains owner/instance binding, authorization basis, public-terms review reference,
read-only scope and one-hour expiry. Removing the flag rejects launch before profile
creation. Signing into our dashboard does not sign into Vest.

The protected persistent profile defaults to:

- Windows: `%LOCALAPPDATA%/VestFleetController/manual-observer`
- macOS: `~/Library/Application Support/VestFleetController/manual-observer`
- Linux development: `~/.local/share/vest-fleet-controller/manual-observer`

An optional `--profile` must be outside every Git checkout and owner-private. The
browser retains its normal local authentication in this profile; the application
never reads, exports, injects or replays cookies/tokens/storage state. Keep it out of
cloud sync, ordinary backups and diagnostic exports; use host disk encryption.
Profiles are bound to the owner, instance, machine and canonical paths. Existing
unbound or copied profiles are rejected rather than silently adopted.

One runtime observer lock plus one profile lock permit one browser/page. The launcher
opens only `https://next.vestmarkets.com/`; a new page or different origin quarantines
and closes it. No speculative OAuth allowlist is installed. If supported login needs
a popup/other origin, that exact handoff must be inspected and reviewed before extension.
Browser lifecycle guards cannot prevent an owner manually placing an order; **do not
place orders during this inspection**. No automated read/write controls are present.

Complete normal login/MFA directly in the browser. Type `ready` only to acknowledge
manual inspection, never to claim authenticated identity, SAFE/READY or protection.
Type `quit` for confirmed browser closure and release of owned observer locks. EOF,
SIGINT/SIGTERM and authorization expiry also attempt closure. Unexpected browser crash,
ambiguous launch or unconfirmed closure retains locks and prohibits automatic takeover.

Recovery: preserve profile and runtime records. Establish whether the recorded browser
and child processes still exist before an explicit operator recovery. Never delete
`controller.lock`, journals, halts or unresolved commands to obtain access. There is
no automatic stale observer-lock cleanup/restart. A later reviewed recovery tool is
required for safe usability after an ambiguous browser failure; do not blindly relaunch.

The authenticated owner must be available for the next observation. Do not send
credentials, MFA codes or account PII in chat/source control. A real evidence port
still needs inspected selectors and a reviewed implementation; the launcher does not
provide discoverable account objects or connect to the controller.

## Read-only observation steps

1. Verify the host owner/instance and owner read-only authorization scope; open only the approved official
   UI in a visible browser. The user completes normal authentication/MFA. No automated
   credential entry, anti-bot bypass or storage-state export.
2. Inspect exact semantic navigation/account selectors and reject zero/multiple matches.
   Review navigation destinations before enabling account selection. Never match trading
   controls by coordinates, fuzzy names or fallback selectors.
3. Discover the complete inventory, including pagination and unselected accounts.
   Record stable visible identity/product, missing fields and scan times. Preserve external
   identities; do not assign the simulator's ordinal `01`–`10` IDs.
4. Serialize switching. Verify account identity after selection, before each evidence
   read and again afterward. Recheck inventory at scan end. Any identity/session/view
   revision change invalidates the observation. Capture time is not evidence freshness.
5. Read existing positions/order/fill history/protection only. Record exact versus rounded
   decimals, visible identifiers, venue timestamps, remainder/cancel states, pagination,
   market units and freshness mechanism. Missing evidence remains null/unknown.
6. Inspect existing close/cancel history without submitting anything. Empty or hidden
   views do not prove flatness/completeness. Capability documentation and actual samples
   have separate provenance. Never infer reduce-only/OCO from button labels alone.
7. Record per-switch/read/inventory durations and quote/account ages; compare with the
   production budgets in [the gap audit](vest-execution-gap-audit.md). Stop on expiry,
   timeout, changed selectors or manual interference. A read timeout does not cancel a
   pending browser task; the future source must quarantine the page before reuse.
8. Save only a reviewed, redacted evidence report in the protected runtime area. Avoid
   raw DOM/network dumps, screenshots of authentication and account PII. Publish a
   sanitized capability matrix with absent fields and blocked conclusions explicit.

## Observation record template

| Field                   | Record                                                                                             |
| ----------------------- | -------------------------------------------------------------------------------------------------- |
| Authorization           | Basis (owner consent versus venue approval), protected reference, owner/instance, scope and expiry |
| Host/browser            | OS/version, browser version, one session/page, protected local profile location                    |
| UI revision             | Date, inspected semantic selector names, uniqueness and navigation destinations                    |
| Account identity        | Exact source and before/after agreement; redact private values in shared report                    |
| Inventory               | Completeness/pagination/end evidence, before/after membership, scan ages                           |
| Quote/account freshness | Venue timestamp or proven refresh mechanism; capture time separately                               |
| Entry/fills             | Visible order linkage, exact quantity/average/fees, terminal remainder; unavailable fields         |
| Protection              | Accepted SL/TP linkage, quantity/trigger/basis, reduce-only, persistence, OCO evidence source      |
| Closing                 | Exit/cancel terminal records, complete flat/order book, orphan behavior                            |
| Timing                  | Switch/read/full-scan measured durations; submission/protection/fleet marked unmeasured            |
| Conclusion              | Verified observations, unknown capabilities, exact no-go blockers, next authorized step            |

No real orders are permitted in this observation workflow. A later driver and one-account
trial require separate approval; passing offline tests does not satisfy either gate.
