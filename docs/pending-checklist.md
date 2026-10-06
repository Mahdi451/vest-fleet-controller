# Pending work before a functional Vest copier

Updated 2026-10-06. The planned offline foundation is verified: all six checks and
all 15 offline gates pass. Independent review is clear. See the committed
[offline evidence](evidence/offline-checkpoint-2026-10-06.json) and the
[implementation history](implementation-checklist.md).

**The product is not connected to Vest and is not ready for live trading.**
Execution stays LOCKED. No foreground windows or Vest charts may be opened under
the current instructions. Check an item only when its stated evidence exists.

## 1. Owner-assisted read-only evidence — next

- [ ] Agree on a dedicated application-owned profile, permitted sign-in activity
      and exact read-only, non-chart views. Foreground activity needs an explicit
      change to the current restriction; repository access is not that permission.
- [ ] Manually sign in without sharing credentials or MFA codes with the tool.
- [ ] Prove stable account identities, complete enabled-account inventory, product
      types and balances/equity/drawdown/position/order freshness.
- [ ] Verify symbol mapping, contract units, tick/quantity steps, limits, fees and
      account-specific risk rules.
- [ ] Identify authoritative leader events and durable provider identities;
      opening the tool with existing positions must not generate new entries.
- [ ] Establish account-scoped request/order/fill correlation, partial-fill and
      terminal-remainder evidence, protection semantics and ownership revisions.
- [ ] Identify necessary provider-owned origins, methods and endpoints. Record
      sanitized evidence and unknowns; deliberately review every allowlist addition.

No order placement, modification, cancellation or flattening belongs in this stage.
See the [session boundary](next-authenticated-checkpoint.md) and
[provider evidence contract](provider-evidence-contract.md).

## 2. Original connected implementation — after evidence

- [ ] Implement narrow account reads and validated leader-event detection first,
      with execution still LOCKED. Do not install or depend on Better Vest.
- [ ] Adapt the managed profile, private transport and whole-browser network
      boundary to reviewed Vest scopes; prove login/navigation/staleness and
      communication loss revoke authority.
- [ ] Implement only approved trading capabilities: entry, stop, target, cancel,
      reduction and flatten. Refuse unknown URLs/routes and wrong accounts/symbols.
- [ ] Connect concurrent follower lanes to durable event/command identities,
      prepared readiness, risk limits and the hedge guard. Keep failures isolated
      where safe; UNKNOWN requires read-only reconciliation, never blind retry.
- [ ] Normalize authoritative fill/protection/exposure evidence into follower
      outcomes, journals and repair controls. Do not automatically reopen followers
      after stop-out, manual close, breach, liquidation, flatten or skip.
- [ ] Validate the exact connected adapter against captured, sanitized provider
      cases, including drift, partial fills, lost acknowledgements and recovery.
- [ ] Retire obsolete sequential/shared-browser prototype paths only after the
      connected replacement and migration coverage prove their required behavior.

## 3. Connected security and release readiness

- [ ] Prove exact domain/method/endpoint/payload enforcement at build and runtime,
      including whole-profile egress and fail-closed behavior.
- [ ] Prove authenticated credentials cannot leak through application diagnostics,
      journals, dashboard or unauthorized networking. Any approved token access
      must remain memory-only behind an exact read-only capability.
- [ ] Confirm the exact runtime artifact excludes capital/payment/account-management
      actions, updater/remote code/configuration, telemetry, analytics, referral
      and donation features; review dependencies and license provenance.
- [ ] Validate every required desktop platform natively, including background
      lifecycle, permissions, browser isolation and descendant cleanup.
- [ ] Review applicable Vest terms, the exact connected artifact and security
      boundaries independently; resolve findings.
- [ ] Validate account-scoped emergency controls and independent manual recovery;
      review manual build/update/release procedures.
- [ ] Run all required checks against frozen source and preserve current evidence.

Offline Linux profile tests do not prove authenticated or other-platform containment.
See the [manual release procedure](manual-local-release.md).

## 4. Separately authorized real execution proof

- [ ] Obtain approval for the exact minimal one-account build/account/market/risk
      trial after the connected evidence and reviews are complete.
- [ ] Prove entry and actual fill, SL/TP quantities and reduce-only behavior,
      protection persistence on disconnect, reduction/close and sibling cancellation.
- [ ] Prove authorized rejection, lost-response, restart and protection-failure
      recovery without duplicate orders or unsafe late remainders.
- [ ] Obtain separate approval for the exact concurrent fleet trial and limits.
- [ ] Prove fast independent fan-out, isolated follower failures, global locking,
      hedge safety, duplicate prevention and no reopening after follower exits.
- [ ] Measure actual leader-to-submit/fill and fill-to-protection latency, fleet
      submit spread and fastest/slowest followers; preserve sanitized measurements.
- [ ] Obtain owner approval of the tested artifact for manual local deployment.

No offline check, persistent setting, repository push or browser sign-in grants
permission for these trials. The remaining major phases are authentic integration,
connected security/release proof, and separately approved provider trials.
