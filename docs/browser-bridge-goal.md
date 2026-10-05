# Browser bridge implementation goal

Direction update: the [event-driven fan-out plan](fanout-adoption-plan.md) supersedes
the sequential follower requirement in this historical bridge plan. Security boundaries
remain required; an isolated follower failure should not halt other valid followers.

Closure goal: [automated functional proof](functional-proof-goal.md), with the
versioned 39-gate catalog and local verification reports. Offline evidence never
authorizes live execution; human review and funded trials remain explicit gates.

Security priority update: [the security-first adoption audit and plan](security-first-adoption-plan.md)
now governs this goal. Runtime must be local-only, independently implemented and
manually updated. Production boundaries and restart-locked live arming require proof
before any separately authorized funded-account trial. Better Vest is reference only;
do not install it or reuse its protected code. No parallel account execution or silent
resume is planned. The offline milestone below does not establish these controls.

Current implementation checkpoint: [local containment](security-containment.md).
The build is intentionally locked and excludes research/remote execution paths.
The simulator payout capability has been removed while preserving historical audit
records. Live arming, browser authentication and provider evidence remain future gates.

Decision date: 2026-10-05. This is the active execution direction requested by the
owner. It supersedes the UI-only transport choice in older planning documents;
it retains the controller's risk, journal, protection, and recovery rules.

## Outcome and completion criteria

Build an original browser-resident Vest bridge around the existing risk engine,
`FleetController`, and SQLite `Journal`. Verify account-scoped entry, actual fill,
fill-relative SL/TP, close, and failure recovery before sequential fleet execution.
Remove replaced execution paths after equivalent coverage passes. Keep live orders
disabled until the transport, provider evidence, and separately authorized trial
are established. Simulator results do not demonstrate live reliability.

Completion requires relevant automated checks, independent review of consequential
changes, inspection of the final diff, and explicit reporting of remaining live
capability gaps. Existing owner edits and browser/runtime records are preserved.
All testing must run in the background. Do not open foreground browser windows or
Vest trading charts while the owner is working. Authenticated observation must use
a separately agreed approach that respects this constraint.

## Reference and boundaries

Inspected [Vest-Copier at befd4dc](https://github.com/xAmped/Vest-Copier/tree/befd4dcbe02309c047dc7507e3c03cfb6eb71339).
Its script uses page request hooks, session tokens, account-specific tokens, and
backend requests. It is evidence of a third-party implementation, not documented
Vest support or proof that this fleet may use that transport. Its
[custom license](https://github.com/xAmped/Vest-Copier/blob/befd4dcbe02309c047dc7507e3c03cfb6eb71339/LICENSE)
restricts modified redistribution and commercial use. No implementation was copied.

The proposed production bridge keeps Vest credentials inside the browser. The host
receives validated, normalized observations, not credentials or raw provider bodies.
This is a design requirement; no authenticated browser bridge is installed yet.
Strict schemas prevent accidental extra credential fields but cannot prove that an
untrusted sender has not put sensitive content in a permitted text field. Browser
origin authentication, pairing, and secret handling require a separate review.

Do not introduce a second risk engine, execution state machine, run journal, or
automatic write retry. A timed-out request may have executed. Reading a flat book
does not resolve an outstanding write or prove that no late fill remains possible.

## Work order

### Additional transport reference: Better Vest

Inspected [Better Vest at 2ae2f25](https://github.com/ax4p/better-vest/tree/2ae2f25b3e32d4f76598dc95e7fe7654819726ac)
on 2026-10-05 through background source reads only. Its copier locates Zustand
account/position stores and React Query order functions through React fibers. It
calls the page's own mutation functions, delegating authentication and request
construction to Vest's client. This is a third transport candidate alongside DOM
interaction and independently constructed backend requests, not a documented API.

The copier's write adapter does not expose tokens to its caller. The extension's
separate read-only subsystem nevertheless borrows a session token for positions,
resting orders, and history GETs. Do not describe the entire extension as token-free.
Light mode temporarily switches the local account store synchronously and restores
it; Turbo opens background follower trading tabs. Neither is proof of safe account
isolation in our session. No extension was installed, and no Vest tab was opened.

Its reconciliation targets leader size times each follower's ratio and includes a
retry/pause policy and conditional resume after reload. Our controller retains
independent drawdown sizing, fill-relative protection, durable intent claims, and
explicit halted recovery. Its internal-function discovery is worth evaluating as
an original bridge approach, but would need client-revision checks, unambiguous
writer/account verification, provider outcome correlation, and failure tests.

The [Better Vest license](https://github.com/ax4p/better-vest/blob/2ae2f25b3e32d4f76598dc95e7fe7654819726ac/LICENSE)
explicitly prohibits reuse in other projects and distribution of modified works
without written permission. No code was copied into this project. Static syntax
checks of its page script, content bridge, and service worker passed; that does not
establish runtime correctness or live reliability. This assessment adds a candidate
for investigation without enabling authenticated requests or changing the
simulation-only adapter boundary.

### Implementation sequence

1. **Offline contract and integration:** strict, versioned command/response messages;
   session/message/operation correlation; bounded waits; quarantined transports;
   existing durable claims before mutations. Exercise the existing fleet controller
   with the simulator across the message boundary.
2. **Transport and read-only capability proof:** establish the applicable transport
   permission and inspect an owner session without placing orders. Verify complete
   inventory, account authority, exact market rules, freshness, positions, order
   history, fills, protection, and closing evidence. Record absent facts as unknown.
3. **Reviewed one-account integration:** implement explicit provider/client identity
   mapping and exact evidence normalization. Keep execution disabled until the
   separately authorized minimal trial. Verify protection persistence, reduce-only
   behavior, sibling cancellation, fees, and terminal partial remainders.
4. **Sequential fleet:** independent sizing and freshness checks for every account;
   stop later entries on unexpected failure. Measure latency/drift while preserving
   sequential execution. Browser loss must have an independent manual recovery path.
5. **Final cleanup and release validation:** remove superseded paths and update the
   active documentation. Phone acceptance and installers remain parked until the
   execution path is proven.

## First implementation milestone

`packages/browser-execution/src/bridge/protocol.ts` defines an original strict
synthetic message contract. `adapter.ts` implements `ExecutionAdapter` using an
in-memory test port. It remains `SIMULATION`, rejects live ports, and does not contact
Vest, capture tokens, inject scripts, open a browser, or change the dashboard mode.

`tests/offline-bridge.test.ts` and its synthetic fixture exercise:

- LONG/SHORT entries, fill-relative protection, and verified flattening.
- Duplicate submissions, changed-payload conflicts, and durable master replay.
- Response loss after a fill, halted later accounts, and no resend after restart.
- Partial fills, unresolved remainders, and protection failure cleanup.
- Wrong session/message/operation/account/request/provider-order identity.
- Malformed, oversized, future/stale, extra-field, and wrong-environment responses.
- Unexpected credential fields rejected before sending and sanitized exchange errors.
- Timeout and late completion without reconnection.
- Partial flatten plus response loss and changed orders across journal restart;
  no repeat flatten while the prior action is unresolved.
- Completed flatten with a lost acknowledgement stays UNKNOWN even when the
  subsequently observed position and order books are empty.

These checks establish synthetic protocol behavior. Local capture timestamps are
separate from the existing account/quote timestamps; capture does not refresh venue
evidence. There is no arbitrary URL, header, request body, or executable-code command.

## Capability report

| Capability                | Current evidence                                                          | Remaining proof                                                              |
| ------------------------- | ------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| One execution owner       | Offline adapter calls existing FleetController and Journal                | Production integration and operator ownership                                |
| Durable claims and replay | Simulator-backed entry/protection/cleanup claims and SQLite restart tests | Provider correlation and ambiguous acceptance behavior                       |
| Session isolation         | Fixture session UUID and per-message correlation                          | Authenticated browser origin, secure pairing, revocation                     |
| Account identity          | Exact synthetic account ID checks                                         | Real stable provider ID and complete inventory                               |
| Freshness                 | Capture validation; controller checks quote/account age                   | Real update timestamps/mechanism and measured scan latency                   |
| Fill-relative protection  | Actual simulator fills drive controller SL/TP                             | Venue quantity/price/fees, accepted exits, persistence, reduce-only/OCO      |
| Provider identity         | Different protection order ID is explicitly refused                       | Verified provider/client mapping; no synthesized venue IDs                   |
| Market mapping            | Synthetic NDX only                                                        | Real symbols, units, tick/size steps, limits, and risk rules                 |
| Transport permission      | Unresolved; third-party source only                                       | Applicable guidance for this exact backend/session approach                  |
| Live sending              | Disabled                                                                  | Reviewed integration, exact trial authorization, and measured trial evidence |

## Cleanup decisions

Removed the test-only `copier/` runner, state machine, in-memory journal, mock adapter,
and contracts. They were not connected to the dashboard's execution path and
duplicated execution ownership. Replaced their orchestration test with integration
through the existing durable controller. Existing controller/protection/exposure
tests remain. Dashboard status moved to `copier-status.ts`; its disarmed gate test
is retained in `capability-decision.test.ts`.

Defer deletion of `single-account.ts`, `vest-live-page.ts`, and their tests until
the permitted production transport replaces their actual evidence and execution
coverage. The owner has uncommitted work in that area. Keep `live-command.ts` while
the dashboard imports its preview/readiness helpers. Keep the DOM fixture adapter
until transport replacement and failure coverage are verified. Keep the observer,
simulator, private host authentication, risk engine, journal, and recovery tools.

No dependency is currently proven unused by this cleanup. Do not remove Playwright,
host storage/authentication, or simulator dependencies based on the new direction.
Older dated investigations remain historical evidence; use this document for the
active transport goal.

## Validation checkpoint

On 2026-10-05, type checking, lint, formatting, and whitespace checks passed. The
full sequential suite passed 417 tests with four skips. After the final missing
flatten-acknowledgement regression, the focused bridge, capability, execution,
protection, and exposure checks passed 98 tests, including 28 bridge cases.
The full-suite result precedes that last regression; the affected suites were
rerun after it. The parallel suite was interrupted after revealing competing
fixture failures and a prototype entry-gate bug; the entry gate was corrected and
the sequential run follows the repository's existing CI approach.

Independent architecture/recovery review identified the partial-flatten restart
risk. Durable unresolved-action checks and a SQLite reopen regression address it.
The adapter captures persisted halt state at construction rather than treating an
active unfinished master as a restart halt. After explicit authoritative recovery,
the adapter must be rebuilt; observation never silently re-arms it. The guard and
claim assume one execution owner. Multiple processes would require an atomic claim
policy before being supported.

The next milestone is transport/evidence proof, followed by a reviewed provider-ID
mapping. Vest permission for session/backend reuse, actual provider observations,
browser-origin authentication, and exact market/protection behavior remain
unverified. Full filesystem access does not establish those facts or authorize a
live order trial. No trading window, authenticated backend request, or real order
was needed for this checkpoint.
