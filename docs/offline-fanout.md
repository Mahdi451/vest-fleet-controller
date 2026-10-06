# Offline independent follower fan-out

Phase 2 adds `OfflineFanoutController` for synthetic ENTRY events. It is not wired
into the dashboard or a Vest session. The CLI/dashboard retain the legacy sequential
simulator. Production trading remains LOCKED and the local trading artifact inert.

## Execution contracts

- Start LOCKED. Explicit, expiring memory-only fixture arming binds the leader,
  followers, symbol, leverage, notional and planned-loss ceilings. Restart discards it.
- Activate a durable event batch with its immutable intent and complete follower set.
  Only the winning activation schedules work. Replays report recorded outcomes;
  missing children after a crash stay NOT_ATTEMPTED rather than catching up.
- Claim each follower attempt atomically before dispatch. Commands derive from the
  leader event and account identity. Dispatch requires the owning generation.
- Run independent account lanes. A blocked account does not delay other accounts;
  timed-out underlying work retains its account lane until it actually settles.
- Reuse one account lifecycle for both coordinators: fresh account/risk checks,
  entry evidence, actual-fill sizing and exact reduce-only protection verification.
  The legacy coordinator retains its existing fleet-wide failure policy.
- Reserve observed and pending/UNKNOWN exposure atomically. Removing or disabling
  an account cannot hide its durable pending reservation. Only conclusive terminal
  evidence plus ABSENT exposure releases it.
- Check identity, risk envelope, arming and hedge safety at dispatch. Global faults
  stop new submissions; already submitted trades remain exposure requiring tracking.
  Arming expiry/revocation does not abandon protection of a known owned fill.
- Publish independent entry, fill, stop, target and exposure outcomes incrementally.
  Local failures remain visible. UNKNOWN cannot be retried blindly. Partial fills
  without conclusive remainder evidence remain uncertain and reserved.

The synthetic bridge permits account lanes only with explicit `ACCOUNT_BOUND`
capability. A legacy/shared-context SERIAL port is refused. Session/capability changes
and protocol-integrity failures quarantine the bridge globally. Its authenticated
channel prototype still needs the Phase 3 concurrency/security redesign.

## Evidence and remaining limits

`tests/fanout-controller.test.ts` covers independent dispatch, isolated rejection,
missing SL/TP, UNKNOWN, late settlement, duplicate/concurrent replay, zero/partial
batch restart, revocation, expiry, storage failure and identity/channel failures.
`tests/copier-exposure.test.ts` covers observed and reserved hedge safety, restart,
disabled accounts and competing processes. Legacy lifecycle/authority/bridge tests
protect the retained simulator.

No real leader detector, provider transport, prepared Vest contexts, non-entry event
propagation, dashboard repairs or latency report is implemented by this phase.
There is no retry dispatcher or continuous position synchronization. Durable exit/skip
records prevent re-entry for the same event; complete live no-reopen proof remains pending.

At the Phase 2 checkpoint, `OFF-FANOUT` remained BLOCKED by its unfinished
`OFF-READINESS` dependency. Phase 3 adds [synthetic readiness and channel proof](offline-readiness-channel.md).
Fixture success does not establish real context attestation, latency or funded authority.

Independent review found no blocking issue in the offline implementation. Phase 3
adds clock-rollback protection. Production admission/dispatch must require complete
verified fleet evidence; the record API's optional evidence argument is retained for
fixtures and compatibility only.
