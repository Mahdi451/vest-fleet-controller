# Vest connection and execution gap audit

Audited 2026-10-01 against the current checkout and GitHub Issue #1. This milestone
proves the permitted connection and execution evidence path. Visual polish and
installer work are paused. No authenticated Vest inspection or orders were performed.

## Working today versus fixture-only behavior

| Area                | Current code evidence                                                                                                                                                                                        | Gap before connected execution                                                                                                                                                          |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Controller and risk | `packages/execution/src/controller.ts`, `packages/risk-engine/src/index.ts`: independent Decimal sizing, hedge guard, durable claims, actual-fill checks, protection verification, conservative cleanup/halt | Keep this controller. Confirm that real visible evidence can satisfy its invariants without invented values.                                                                            |
| Browser transport   | `packages/browser-execution/src/dom.ts` requires `LOCAL_FIXTURE`; `adapter.ts` rejects other environments. `ExecutionAdapter.mode` accepts only `SIMULATION`                                                 | Manual headed launcher opens official Vest for owner login; no real observation port or executable Vest adapter exists.                                                                 |
| Request correlation | `adapter.ts` finds entry/protection rows using our local `requestId`; `journal.ts` claims actions before dispatch                                                                                            | Fixtures echo local IDs. A journal does not establish venue-side exactly-once execution. Need unique visible venue correlation; ambiguity means halt, never click again.                |
| Account identity    | `identitySchema` and `adapter.ts` check exact ID/label/context before action and again after form preparation                                                                                                | Real authoritative account ID/product, identity across views and server-side selection scope unobserved. Local page/context IDs are not account authority.                              |
| Inventory           | `visibleBookSchema` requires a full array, with exact binding membership checked by the adapter                                                                                                              | Pagination, hidden accounts, discovery completeness, account lifecycle and cross-account manual changes unverified. The dashboard's `01`–`10` IDs are simulation IDs.                   |
| Fill ledger         | `resultSchema`, controller fill reconciliation: quantity, average price, fees, position match and terminal partial remainder                                                                                 | Fixture has full history, exact decimals and deterministic records. Real precision, stable IDs, terminal state and cancellation evidence unverified. Rounded displays are insufficient. |
| Market/risk rules   | `core/src/index.ts` uses simulation `NDX`; `simulator/src/index.ts` supplies balances, floors, fees and quote timestamps                                                                                     | Actual market mapping/units/precision, fee/funding costs, margin/liquidation, Instant floor/daily loss and trading hours require evidence. No fixture defaults may fill missing values. |
| Protection          | Controller uses each destination's actual fill/quantity; both independent reduce-only SL/TP are verified                                                                                                     | Venue acceptance, trigger basis, exact quantity, reduce-only, browser-independent persistence and sibling cancellation are unverified. SL/TP controls alone prove none of these.        |
| Close and cleanup   | Controller/adapter verify flat positions and no active protection; unresolved cleanup remains UNKNOWN                                                                                                        | Need complete positions/open orders and terminal exit/cancel evidence in a verified account. Disappearing rows alone do not prove successful cleanup.                                   |
| Recovery            | Existing journals, circuit halt, exclusive runtime ownership; browser actions after restart require recovery                                                                                                 | No actual session expiry, browser crash, venue ambiguity or manual intervention has been exercised. Reconciliation must precede a separately authorized re-arm.                         |
| Copier source       | Dashboard master command drives sequential execution through the existing controller                                                                                                                         | Monitoring manually placed leader trades is not implemented and remains a separate future capability.                                                                                   |

## Minimum visible evidence

Inspection must record absence as unknown, including fields the executable simulation
schemas currently require. No new timestamp, venue ID, fee or quantity may be synthesized
to make those schemas parse.

1. **Identity and inventory:** stable visible account identifier and account product;
   same identity in selector, account view, order history and form context; complete
   inventory including unselected accounts for the hedge guard; pagination/end evidence;
   identity before/after each serialized selection and after preparing any future form.
2. **Freshness:** capture time separately from venue update time or an explicitly
   observed refresh mechanism. A freshly read stale DOM is still stale. Exact quote
   market, price, units and freshness; account evidence ages for every fleet member.
3. **Entry and fill:** stable visible venue order/position linkage, side, market,
   exact executed quantity, average fill, fees and terminal status. A submitted local
   attempt ID is not a venue ID. Unique acknowledgement-to-order linkage is required;
   matching side/size/time alone is not sufficient. Continuing partial fills or an
   unresolved remainder prevent protection success.
4. **Protection:** independently identifiable venue-accepted SL and TP, linked to the
   actual position, exact trigger price/basis and filled quantity, reduce-only proof.
   Verify persistence without the browser and sibling-cancellation/OCO behavior;
   determine orphan handling and reopening risk. Existing visible orders can be
   observed read-only; absence of orders cannot prove these capabilities.
5. **Closing:** complete position and open-order views, terminal exit and cancellation
   evidence, no active orphan protection or unresolved entry. An unverifiable account
   is never a cleanup target.

These are acceptance requirements, not assertions that Vest provides the fields.
If the permitted UI cannot supply them, record a no-go or review the interface explicitly;
do not bypass the UI using private endpoints.

## Connection and observation workflow

Use one dedicated **visible Playwright browser on the user's Windows/macOS host**,
one session and one page. The user performs Vest's supported login and MFA directly.
Dashboard authentication only authenticates our application. It provides no Vest access.
Keep the local browser profile protected and outside Git/logs; do not export cookies,
tokens, storage state, raw authenticated DOM, request traces or login screenshots.

The new offline observation boundary is documented in
[the read-only observation runbook](vest-read-only-observation.md). It is separate from
`ExecutionAdapter` and has no trading methods. The owner-authorized `pnpm observe:vest` manual launcher is separate from both
contracts and controller. No real evidence parser or executable Vest driver is enabled. Session expiry requires manual reauthentication and fresh identity/inventory
verification. A changed selector, unexpected account, incomplete view or timed-out read
invalidates the observation session. There is no automatic browser restart/failover.

With owner read-only authorization and an authenticated manual session, inspect semantic selectors and
explicit states for discovery, switching and existing history/orders. Record selector
uniqueness/version and any server-side account-context changes. Do not click submit,
cancel, close or flatten, even to investigate. Ordinary tabs/contexts do not establish
isolation. If no existing sample demonstrates a fill/protection/close state, mark it
unobserved until a separately authorized trial; never create an order in this milestone.

## Reliability: measured versus unmeasured

The fixture adapter records `accountSwitchMs`, `submitMs`, and counts. The coordinator
records `fanOutMs`; controller journals local fill/protection/reconciliation latency.
Those are synthetic/local instrumentation, **not measurements of Vest**.

Current defaults: browser operation timeout **1,500 ms**, maximum **3,000 ms**;
controller default operation timeout **1,000 ms**, browser coordinator **10,000 ms**;
configuration evidence and preview ages **5,000 ms**. The existing browser fixture
suite uses **60,000 ms** evidence/preview ages and a **3,000 ms** browser timeout.
Its passing results do not demonstrate the production five-second fleet budget.
No production budget is changed for this milestone.

Read-only observation must measure selection start → verified identity, view refresh
→ usable evidence and full inventory scan age. Submission, fill → both protection
acceptances, close/cancel and total executable fleet latency remain **unmeasured** until
an explicitly permitted trial. Include slow/failure cases and per-account drift. If
measured performance cannot satisfy freshness, halt and review the budget/approach;
do not extend expiry simply to make tests pass.

## Before a separately authorized one-account trial

- Review applicable automated-execution/product/session restrictions and authorize the
  exact trial separately; commercial distribution remains a distinct decision. Personal
  manual read-only inspection is owner-authorized, not claimed as Vest approval.
- Authorized manual session plus inspected semantic selectors and exact account identity.
- Complete risk/market rules and every required visible evidence capability above.
- Reviewed real driver using the existing controller/journal; unique outcome reconciliation,
  no blind retry; account checks before mutation and after form preparation.
- Protection persistence/reduce-only/sibling behavior proven in an approved test setting
  or authoritative applicable documentation. Read-only inspection alone cannot test triggers.
- Failure/restart/manual-intervention contract tests, measured budgets, explicit go/no-go,
  recovery instructions and separate approval for a minimal supervised trial.

The owner authorized personal read-only connection on 2026-10-01; an authenticated
funded session and actual UI evidence are still missing. The exact blocked
observation is authenticated account discovery/switching and existing fill, protection
and closing evidence. Connected execution stays disabled regardless of offline tests.

Offline contract checks, independent review, full-suite restrictions and publication
status are recorded in [the current validation report](vest-execution-validation.md).

## October 2 investigation checkpoint

Execution diagnostics now retain fixed revalidation gate/risk reasons and signed
preview/quote/account ages in the existing final child audit row, without additional
execution-path writes or a change to child outcome codes. The native phone fixture
measures existing journal mutation durations and emits only a synthetic allowlisted
summary. Production freshness and preview limits remain 5000 ms. A deterministic
5001 ms delay during account eight revalidation verifies seven protected outcomes,
rejected eighth entry, halted ninth/tenth and no redispatch on replay.

[Diagnostic run 37049870681](https://github.com/Mahdi451/vest-fleet-controller/actions/runs/37049870681)
passed all four runners. Its four Windows phone commands protected the full fleet,
with preview ages up to 2620 ms and measured storage-call totals up to 2729 ms.
Native laptop phone cases at `824de71` also passed after fixing local OpenSSL PATH.
These observations do not establish the older failure's exact cause; expiry under
runner load remains an inference. The full-fleet fixture now uses controlled
simulation time, alongside deterministic expiry/partial-fleet rejection coverage.
Production limits remain unchanged; final relevant revision native CI is pending. A newer baseline run passed Windows but failed macOS Intel at
an immediate logout-visibility assertion; the fixture now waits for the authenticated
view after reachability. That race is distinct from the earlier fleet rejection.

Observer close/recovery diagnostics and tests are improved, but the legacy locks
remain retained without reliable reboot-boundary proof. Original closure cause and
safe relaunch remain unresolved. Public signed-out inspection confirmed the Google
button and same-page navigation to Google Accounts; a complete normal handoff, returned owner/account identity, actual funded
inventory and existing fill/protection/close sources remain unobserved. The
[runbook](vest-read-only-observation.md#october-2-lifecycle-diagnosis-and-recovery-boundary)
records the exact recovery boundary. No real read-only port or writer was added.
