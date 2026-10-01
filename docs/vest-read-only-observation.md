# Permission-gated Vest observation runbook

This is preparation for read-only inspection, not a connected trading feature.
No actual Vest browser source is implemented. Offline contracts use synthetic observations
and cannot launch a browser, log in or submit an order.

## Permission questions to send personally

Do not send these on the user's behalf. Obtain dated written answers covering the exact
products and workflow, rather than inferring permission from general strategy rules.

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

## Required handover before any actual inspection

Record a protected local permission reference, owner and execution-instance binding,
exact account product/workflow scope, approval and expiry/revocation conditions, and
the authorized user's availability for manual login. Do not put identifying account
details or approval correspondence with personal data into public source control.

Permission is an operator-reviewed prerequisite, not a dashboard checkbox or browser
claim. The offline boundary tests permission/owner/instance/expiry failures but is not
an authorization service and cannot create a real connection. Adding a real source
requires a new reviewed implementation after this handover.

Reuse the existing host ownership boundary. One host owns the protected dedicated
profile and one page. Never delete runtime locks/journals to obtain access. Never
automatically take over a profile from another worker. Expiry/crash/context uncertainty
requires manual reauthentication or reconciliation; no automatic connected re-arm.

## Read-only observation steps

1. Verify the host owner/instance and permission scope; open only the approved official
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

| Field                   | Record                                                                                        |
| ----------------------- | --------------------------------------------------------------------------------------------- |
| Permission              | Dated protected reference, scope, owner/instance binding, expiry/revocation review            |
| Host/browser            | OS/version, browser version, one session/page, protected local profile location               |
| UI revision             | Date, inspected semantic selector names, uniqueness and navigation destinations               |
| Account identity        | Exact source and before/after agreement; redact private values in shared report               |
| Inventory               | Completeness/pagination/end evidence, before/after membership, scan ages                      |
| Quote/account freshness | Venue timestamp or proven refresh mechanism; capture time separately                          |
| Entry/fills             | Visible order linkage, exact quantity/average/fees, terminal remainder; unavailable fields    |
| Protection              | Accepted SL/TP linkage, quantity/trigger/basis, reduce-only, persistence, OCO evidence source |
| Closing                 | Exit/cancel terminal records, complete flat/order book, orphan behavior                       |
| Timing                  | Switch/read/full-scan measured durations; submission/protection/fleet marked unmeasured       |
| Conclusion              | Verified observations, unknown capabilities, exact no-go blockers, next authorized step       |

No real orders are permitted in this observation workflow. A later driver and one-account
trial require separate approval; passing offline tests does not satisfy either gate.
