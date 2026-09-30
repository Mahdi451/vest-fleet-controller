# Prototype completion checklist

Status checked 2026-09-30. This is the development checklist; the [README](../README.md)
describes what a local user can do today. The [Vest fact register](vest-facts.md) and
[browser investigation](browser-execution.md) carry sources and detailed evidence gates.

## What works today: local simulation prototype

- [x] Run a ten-account synthetic fleet in a local dashboard and CLI.
- [x] Preview independent notional and estimated all-in risk per account using fixed
      notional, fixed dollar risk, drawdown percentage, or equity-as-margin percentage with
      configurable leverage, stop distance and target distance.
- [x] Select/disable accounts, execute simulated sequential MARKET entries, derive
      reduce-only SL/TP from each actual simulated fill, and reconcile protection.
- [x] Reject opposite-direction same-market exposure, duplicate trade requests, stale
      previews, insufficient drawdown reserve and unsafe execution outcomes.
- [x] Simulate slippage, fees, funding, price changes, partial terminal fills,
      protection failures, OCO sibling cleanup and emergency flatten.
- [x] Persist a local SQLite journal and simulation snapshot; restart halted for review.
- [x] Exercise a fixture-only browser adapter with original synthetic pages. It is not
      wired to the Vest website or the dashboard.
- [x] Pass formatting, lint, typecheck and all 155 tests in eight files (2026-09-30).

These checks establish a **functioning simulation prototype**, not permission or
readiness to automate funded trades. The ten accounts, quotes, fills, fees, rules and
browser pages are synthetic assumptions. A halted session has no automatic safe re-arm.

## Gate 1 — permitted integration path

- [ ] Obtain written Vest confirmation for visible-UI automation of the user's Instant
      accounts, same-owner same-direction copying, and the applicable account/session terms.
      Resolve the single-Account clause versus the FAQ's ten funded accounts.
- [ ] Confirm whether a supported native copier exists and whether it supplies
      independent sizing, per-account fill/protection evidence, reconciliation and flatten.
- [ ] Confirm the exact Instant drawdown/daily-loss/withdrawal rules, market symbol and
      contract/size units, tick/size precision, leverage, fees and funding. Replace
      simulation defaults only with product-specific evidence.

**Stop condition:** Without explicit permission for the chosen path, keep the project
simulation-only. The official FAQ excludes funded and Instant API trading; private
endpoints and browser session material are not an alternative API.

## Gate 2 — read-only funded UI investigation

- [ ] In an authorized logged-in session, map the account selector, account identity,
      cross-tab effects, account state, market/order controls, order history, positions,
      protection, errors and manual emergency-close flow. Save only redacted evidence.
- [ ] Prove that the visible UI can correlate a unique entry to the exact account,
      terminal filled quantity, weighted fill price, fees and resulting position, including
      partial fills and ambiguous/late responses.
- [ ] Prove independent active SL and TP identity, trigger basis/price, exit side,
      quantity, reduce-only semantics, and cancellation/final flat-state evidence. Determine
      native OCO behavior; plan permitted sibling cancellation if it is absent.
- [ ] Verify product quote freshness, size increments, leverage selection, rounding,
      and account state before any order. Measure how account switching behaves when other
      tabs or sessions are open; never infer isolation from ordinary tabs.

**Stop condition:** If exact account identity, fill correlation, or durable reduce-only
protection cannot be established through a permitted interface, do not automate orders.

## Gate 3 — production-path engineering, still without real trades

- [ ] Implement a permitted visible-UI driver behind the existing DOM/adapter boundary.
      Keep one serialized browser owner, select and verify the exact account before each
      action, and start with sequential account switching. No hidden requests or guessed
      selectors.
- [ ] Connect the existing risk preview and controller to the driver only behind an
      explicit capability/configuration gate. Preserve independent sizing, pre-entry
      revalidation, actual-fill SL/TP, hedge guard, journal claims and fleet drift abort.
- [ ] Reconcile account, position, fills, orders and protection after timeouts, session
      loss, manual intervention, restart and uncertain clicks. Never auto-retry a write
      whose outcome is unknown.
- [ ] Design and test an explicit operator recovery/re-arm flow, including read-only
      diagnosis and manual Vest-side recovery when the browser or venue is unavailable.
      Reconciliation alone must not silently unblock entries.
- [ ] Prove orphan/OCO cleanup and flatten under live-UI semantics, including races,
      partially created protection and the inability to verify a close.
- [ ] Add approved signal input for CME NQ direction only after a destination-market
      mapping, independent Vest quote, timestamp/basis validation and operator override
      exist. Do not use CME price or multiplier as a Vest fill.
- [ ] Expand fixture/contract tests for UI changes, delayed or partial fills, duplicate
      responses, lost confirmation, SL/TP rejection, stale data, login expiry, browser
      crash/restart, manual trades, cancel races, orphan orders and account switch errors.
- [ ] Measure switch, submit, fill-to-protected and whole-fleet latency; set bounded
      quote age and first-to-last price drift from evidence. Add actionable alerts and a
      clear SAFE/DEGRADED/HALTED operator view.

**Stop condition:** Complete a review of permissions, evidence, recovery instructions,
tests and exact current risk assumptions before enabling even a one-account trial.

## Gate 4 — supervised validation

- [ ] Use an officially permitted paper/test venue if available; demonstrate entry,
      actual fill, both protections, exit, sibling cleanup and restart reconciliation.
- [ ] Obtain separate approval for one minimal-size, supervised funded-account trial
      only after Gate 3 and a manual recovery procedure are complete.
- [ ] Validate one account, then two, then a small fleet, and finally ten sequentially.
      Record divergences, failures and fan-out drift; keep already protected children
      explicit when later accounts abort.
- [ ] Consider isolated contexts and limited concurrency only after permission and
      independently proven account/session isolation. Ordinary shared-session tabs are
      not an execution architecture.

The **Vest-connected prototype** is complete only when a permitted supported path
demonstrates the full entry → authoritative fill → per-account protection → verify →
reconcile → exit/flatten lifecycle, including failure recovery, at the agreed test
scope. That outcome remains conditional on Vest policy and visible capabilities.
