# Reliability audit and simulator beta hardening

Review date: 2026-09-29 (America/Los_Angeles). Reviewed baseline:
`12c727153282a5b13fe9d3a05292f91f8a9036e9`. Scope: the actual repository, not presumed
Vest capabilities. No live API facts were promoted or endpoint behavior invented.

**Beta boundary:** one local dashboard owner, synthetic prices, ten simulated accounts.
This work improves recovery and operation of that beta. It does not make the application
ready to trade funded accounts, expose a remote service, or promise loss containment.

## All 17 requested items

IMPLEMENTED means implemented within the stated simulator scope. PARTIAL means a
useful subset exists with an explicit remaining boundary. NOT CURRENTLY NEEDED means
there is no corresponding exposed feature/transport; it can still be a mandatory live gate.

| #   | Item                               | Before               | After                | Evidence and remaining boundary                                                                                                                                                                                                            |
| --- | ---------------------------------- | -------------------- | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | Post-fill protection state machine | IMPLEMENTED          | IMPLEMENTED          | `FleetController.execute`: entry ledger + position, actual-fill prices, separate SL/TP, both verified before PROTECTED. Existing flow preserved.                                                                                           |
| 2   | Fail-closed protection recovery    | IMPLEMENTED          | IMPLEMENTED          | Uncertain establishment attempts affected-account flatten, keeps UNKNOWN and latches halt. Periodic reconciliation now detects later protection loss too. Cleanup can fail; no automatic re-arm.                                           |
| 3   | Partial-fill handling              | MISSING              | PARTIAL              | Terminal `PARTIALLY_FILLED` requires explicit canceled remainder. Protects actual quantity. Pending/incremental fills still fail closed; no claim of support for a continuing fill stream.                                                 |
| 4   | Authoritative reconciliation       | PARTIAL              | PARTIAL              | Existing immediate lookups plus new periodic/operator book reconciliation and durable local restart recovery. Live stream gaps, delayed external fills and venue recovery remain unimplemented.                                            |
| 5   | Idempotency / duplicate prevention | PARTIAL              | PARTIAL              | Entry and SL/TP fingerprints/IDs survive simulator restart. Cancellation is a terminal-state no-op on repeat in the mock. Replacement orders do not exist; no invented replacement-ID subsystem.                                           |
| 6   | Safe TP/SL replacement             | NOT CURRENTLY NEEDED | NOT CURRENTLY NEEDED | No modification command or UI is exposed. Keep it disabled until generation IDs, serialization and verified venue amendment semantics can be designed.                                                                                     |
| 7   | Fleet partial-execution policy     | IMPLEMENTED          | IMPLEMENTED          | Sequential dispatch. Keep earlier protected accounts; clean up the unsafe child; halt later children. A terminal partial fill may continue only after its full actual exposure is protected.                                               |
| 8   | API rate limiting / backoff        | NOT CURRENTLY NEEDED | NOT CURRENTLY NEEDED | No outbound trading API. Entry serialization, per-call deadlines and server busy guards exist. Venue request budgets, 429/Retry-After handling and update debouncing belong before a live transport or replacement feature.                |
| 9   | WebSocket lifecycle                | NOT CURRENTLY NEEDED | NOT CURRENTLY NEEDED | No socket/session/listen-key protocol is implemented. Simulator disconnect/reconnect is tested; that is not a WebSocket test.                                                                                                              |
| 10  | Dynamic venue metadata             | NOT CURRENTLY NEEDED | NOT CURRENTLY NEEDED | Synthetic NDX and configurable quantity/leverage assumptions remain intentional. Destination symbol, ticks, size limits and leverage must be fetched and verified before live execution.                                                   |
| 11  | Clock / nonce handling             | NOT CURRENTLY NEEDED | NOT CURRENTLY NEEDED | No signed requests or nonces. Existing future/stale timestamp rejection remains. New latency measurements use a monotonic clock. Venue clock offset/recvWindow/nonce rules remain a live gate.                                             |
| 12  | OCO / orphan cleanup               | PARTIAL              | IMPLEMENTED          | Existing reduce-only sibling cleanup plus new orphan scanning, cancel lookup and open-book verification. Local simulator behavior only; native OCO and venue race guarantees are not assumed.                                              |
| 13  | Manual-intervention detection      | PARTIAL              | PARTIAL              | Existing pre-trade account revalidation plus ongoing position/quantity/protection divergence and unverified external-close detection. No external venue event feed or complete attribution of every balance change.                        |
| 14  | Risk based on actual execution     | PARTIAL              | IMPLEMENTED          | `assessFilledRisk` recalculates from actual quantity, fill and paid entry fees, bounded exit costs/funding, current floor, reserve and margin. Preview envelope remains an upper budget; no size increase.                                 |
| 15  | Operational observability          | PARTIAL              | PARTIAL              | Structured stage timing, actual-risk fields, reconciliation counters/divergence and SAFE/DEGRADED/HALTED endpoint/UI. No live 429 counters, remote alerts or durable metrics exporter. Audit is durable; counters are process-local.       |
| 16  | Fault/chaos testing                | PARTIAL              | PARTIAL              | Existing timeout/lost-response/rejection/duplicate tests plus partial fills, disconnects, persistence failures, real SIGKILL between stages and restart with protected positions. No fictitious WebSocket/429 tests for absent transports. |
| 17  | Live-adapter capability gate       | IMPLEMENTED          | IMPLEMENTED          | Adapter contract is SIMULATION-only and runtime rejects LIVE mode. The beta cannot enable live trading. A future capability checklist must be enforced against official funded-account support before relaxing this veto.                  |

## Smallest useful change set selected

1. Support terminal partial fills without weakening the unknown-remainder policy.
2. Reassess actual execution risk before placing protection; flatten if the approved
   budget, reserve, margin or state consistency cannot be maintained.
3. Add one reconciliation operation to the existing controller, used by startup,
   a one-second serialized service loop and an explicit Reconcile action. Detect
   protection loss, unmanaged exposure, missing inventory and orphans; halt and clean
   unsafe exposure. Reconciliation never clears the existing circuit.
4. Persist simulator books and deduplication records in the existing SQLite journal.
   Restore the active dashboard session on restart and require halted review. Add an
   exclusive owner lock and explicit new-session reset that retains prior journals.
5. Expose stage timings and health using the existing audit and local HTTP service.
   Bound activity reads to the last 15 events instead of loading the entire audit table.
6. Add recovery/failure tests and update operating instructions and visuals.

No second risk engine, event bus, retry scheduler, alternate journal, live adapter,
undocumented endpoint, fake WebSocket layer or assumed API rate limit was added.

## Files involved

| Area          | Files                                                                                                                  | Change                                                                                                                               |
| ------------- | ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Execution     | `packages/execution/src/adapter.ts`, `controller.ts`, `journal.ts`                                                     | Terminal partial result contract, saved intent, final-risk fields, reconciliation, metrics, snapshot storage and bounded audit reads |
| Risk          | `packages/risk-engine/src/index.ts`                                                                                    | Actual-fill risk reassessment                                                                                                        |
| Simulator     | `packages/simulator/src/index.ts`, `storage.ts`                                                                        | Partial faults, validated snapshots, restore, active-session selection and exclusive owner lock                                      |
| Dashboard     | `apps/dashboard/server.ts`, `public/app.js`, `public/index.html`                                                       | Durable startup, periodic/operator reconciliation, health, read polling and recovery text                                            |
| Tests         | `tests/beta-reliability.test.ts`, `tests/fixtures/crash-worker.ts`, `tests/dashboard.test.ts`                          | Partial/actual-risk tests, book divergence, durability, crash and HTTP health checks                                                 |
| Documentation | `README.md`, `DEVELOPMENT.md`, architecture/execution/risk/simulator/validation/project-plan documents, dashboard PNGs | User behavior, audit status, recovery limits and current visuals                                                                     |

## Important behavior and limits

- A confirmed terminal partial gets protection exactly matching its filled size.
  The rest of the requested quantity is never assumed canceled without evidence.
- Post-fill loss includes paid entry fees once. Stop reserve uses the after-fee balance;
  it does not debit entry fees a second time.
- Known good earlier children stay protected when a later child fails. The controller
  does not blindly compensate the whole fleet with new trades.
- Snapshot writes can capture intermediate unsafe states. Recovery validates schema,
  configuration and identity, halts first, then checks the books. A saved protection
  flag alone is never sufficient evidence. Real process-kill tests cover these states.
- The dashboard resumes its saved fleet halted, including after a clean shutdown.
  Reconcile and Flatten remain available. Continuing with the same balances after a
  halt requires a future reviewed operator re-arm workflow; New simulation is an
  explicit reset, not reconciliation or permission to retry an unknown request.
- The owner lock is conservative: a crash leaves it on disk. Verify the recorded PID
  is no longer the owning controller before removing that one lock file. Do not delete
  the active-session manifest or SQLite/WAL files to get past a recovery error.
- The lock is for one trusted local filesystem, not distributed coordination. Do not
  share the runtime directory across hosts or run multiple controllers over one fleet.
- SAFE means a recent successful simulator book check, not a guarantee of financial
  safety. Stale synthetic data or an operation in progress is DEGRADED; an open circuit
  is HALTED. Metrics reset when the process restarts. Audit events do not.
- No automatic live quote catch-up occurs while offline. Persistent snapshots are not
  an exchange, a live execution ledger, or full deterministic market-event replay.

## Direction update after this audit

The later [browser investigation](browser-execution.md) supersedes API-oriented planning
below for this funded fleet. The public FAQ now confirms that Evaluation/Live Funded/
Instant API trading is unavailable. Required execution evidence must come from an
explicitly permitted visible-UI workflow or compatible official copier. Fixture-only
browser tests do not establish permission or real UI capability.

## Required before live deployment

1. Obtain dated official funded-account permission and documentation covering auth,
   account scope, exact market identity/metadata, stops, targets, reduce-only, request
   lookup, cancellation, rate limits, stream lifecycle and account risk rules.
2. Build a fail-closed capability check. Unsupported or unknown required capabilities
   must keep LIVE disabled. No preference/configuration toggle may bypass it.
3. Resolve incremental/pending fills and late requests authoritatively, including
   partial protective executions, canceled remainders and reconnect event gaps.
4. Implement documented rate budgeting, backoff, clock/nonce rules and stream recovery.
   Give protection/flatten priority; do not automatically retry ambiguous writes.
5. If amendments are exposed, add versioned replacement IDs, serialized updates,
   debouncing and cancellation-race tests that preserve protection where possible.
6. Add an operator recovery/re-arm workflow with evidence and durable acknowledgement,
   retention/backup procedures, and operational alerts appropriate to actual deployment.
7. Validate through simulator → paper/test if supported → separately authorized tiny
   single-account test → small fleet. No full-fleet funded deployment from this beta.

See [validation results](validation.md) for exact test counts and commands.
