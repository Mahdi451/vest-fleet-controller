# Event-driven copier adoption plan

Owner direction, 2026-10-05: Account 01 is the leader; Accounts 02–10 are followers.
Copy genuine leader events with fast independent follower execution. This supersedes
the strict sequential follower requirement in earlier plans. Live trading stays disabled.
All testing stays in the background, without opening Vest charts.

Track implementation and completion evidence in the
[working checklist](implementation-checklist.md).

## Current enforcement to replace

- `packages/execution/src/controller.ts`: `execute()` awaits the whole child lifecycle
  inside an account loop. `stopped`, `circuitOpen`, failure handling and reconciliation
  promote ordinary child errors to a fleet halt. The controller-wide busy flag also
  excludes simultaneous execution and repair.
- `packages/browser-execution/src/bridge/adapter.ts`: one queue serializes all accounts;
  quarantine halts the shared journal. Some errors signify global integrity loss;
  others need account-specific handling.
- `packages/browser-execution/src/coordinator.ts`: sequential coordinator and shared
  fleet lifecycle belong to the older DOM prototype. Do not share a mutable selected
  account/ticket across concurrent follower writes.
- `packages/execution/src/journal.ts`: `halted()` infers a global stop from any UNKNOWN
  child or unresolved browser action. Separate account blockers from global halt state.
- `apps/dashboard/server.ts` and `public/app.js`: one command/busy/UNKNOWN state blocks
  the whole UI; results arrive primarily after execution finishes.
- `bridge/authenticated-channel.ts`: unfinished, unvalidated work from the interrupted
  prior task uses one in-flight exchange. Redesign for independent account lanes before
  adopting it. A synthetic channel still cannot prove real browser authenticity.

## Adaptation

1. **Event coordinator and fan-out.** Keep one execution owner. Refactor reusable
   account execution out of the existing controller rather than introducing another
   risk/protection engine. Maintain account-bound prepared contexts, fresh readiness
   and independent account queues. Claim valid follower commands durably, then start
   ready followers together and collect outcomes independently. Within each account,
   entry/fill/protection and conflicting commands remain ordered. Never wait for a
   different follower's protection before starting a ready account.
2. **Session and readiness.** A memory-only arm binds leader/followers, symbols,
   leverage, order/allocation/risk ceilings and verified context generations. Start
   locked after restart. Precompute sizes and maintain account/quote/order readiness;
   immediately before dispatch check that readiness is fresh, matching and within
   the armed envelope. Stale accounts are skipped/flagged, never dispatched blindly.
3. **Risk and hedge guard.** Retain risk sizing and enabled-account exposure checks.
   Include pending/UNKNOWN exposure reservations in fleet direction checks so concurrent
   events cannot bypass the hedge guard. Reserve/check direction atomically before
   dispatch. Account-local UNKNOWN blocks that account; possible opposing fleet exposure
   can block globally when the hedge invariant cannot be proven.
4. **Independent outcomes.** Extend the existing child result with entry submission
   certainty, intended side/size, actual fill/price, separate stop/target states,
   exposure PRESENT/ABSENT/UNKNOWN, fixed reason codes and permitted repairs. Fleet
   summaries can be COMPLETE_WITH_ISSUES without stopping unrelated valid followers.
   Authentication, identity mapping, channel integrity, journal/event corruption and
   unsafe hedge conditions remain global stops. A lost acknowledgement is local only
   when transport integrity and account scope remain trustworthy.
5. **Durable identity.** Add leader-event and follower-attempt records to the existing
   SQLite Journal. Derive the logical command from event ID + follower stable ID;
   bind it to an immutable payload hash and claim atomically before sending. Replay
   returns recorded state. UNKNOWN reconciles without resend. Any explicit retry must
   prove the prior attempt terminally rejected/not sent with no late execution possible,
   then create a linked, separately claimed attempt. Do not erase the original record.
6. **No state-driven reopening.** Reconciliation observes and flags divergence; it does
   not create entries. Store follower exit/skip disposition against the leader event.
   A stopped, closed, liquidated, breached, skipped or flattened follower can enter only
   on a genuine new leader entry event and fresh approval within the armed session.
   Initial observations and reload catch-up must not manufacture entry events.
7. **Latency.** Record event detection, actual dispatch start, provider acknowledgement,
   fill observation and protection observation per follower. Derive leader→submit,
   leader→fill, submit→fill, fill→protection and fleet submit spread, plus fastest/slowest
   followers with explicit missing measurements. Use a common monotonic measurement
   origin where possible; preserve clock/source uncertainty across processes. Existing
   shared last-latency fields cannot represent concurrent results. Synthetic metrics
   must be labeled; real Vest latency remains unknown until authorized measurement.
8. **Dashboard and repair.** Publish incremental journal-backed account updates using
   a local event stream. Show all requested fields and exposure immediately. Add Stop,
   Add Target, Flatten, Reconcile, Skip and conclusively-safe Retry are account-scoped,
   authenticated, idempotent operations. Re-read current identity/position/protection
   before repairs. Never offer Retry for UNKNOWN or silently duplicate an existing exit.
9. **Security boundary.** Retain exact build/dependency/domain/endpoint/permission
   checks, fixed named operations, credential-free diagnostics and manual updates.
   Implement runtime method/route/body/account enforcement, trusted channel provisioning,
   lifecycle revocation and dedicated-profile isolation before live use. No updater,
   remote configuration, telemetry, promo/donation or capital-management capabilities.
   Existing inert production artifact and empty enabled network policy stay unchanged
   until a separately reviewed connected build is ready.
10. **Reference and simplification.** Independently recreate leader/follower selection,
    prepared contexts, event hooks, TP/SL propagation, copy logs, per-account status and
    fast scoped flatten/repair. Exclude themes, calendars/payouts, support commerce and
    forced position synchronization. Replace sequential-only production requirements,
    global child-error halt rules, per-event confirmation and shared mutable browser
    state. Retire obsolete coordinator paths only after equivalent coverage exists;
    preserve owner edits and historical journal records. No protected source reuse.

## Implementation order and proof

First refactor per-account execution and journal/error scope with synthetic fan-out
tests. Prove that a delayed/rejected/UNKNOWN follower does not delay unrelated valid
followers, replay creates no second entry, opposite pending events fail the hedge guard,
global revocation stops queued submissions, and follower exits never reopen on snapshots.
Then connect readiness/arming, latency and incremental dashboard/repair tests. Build the
original Vest adapter and prove provider identities, protection and exact egress before
separately approved one-account and concurrent-fleet trials.

Earlier sequential fixture passes remain historical evidence; they do not prove this
new fan-out design. Update the functional gate catalog and evidence reports alongside
implementation. No current test count or readiness flag enables live execution.
