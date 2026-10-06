# Independent follower simulation

The local `/copier` page exercises the new concurrent copier with **synthetic accounts only**. It has no Vest connection and cannot place funded orders. The original dashboard at `/` remains available as the legacy simulator.

```sh
pnpm install --frozen-lockfile
pnpm dashboard
```

Open `http://127.0.0.1:4173/copier` manually when convenient. No browser or trading chart needs to open automatically. The running production artifact remains inert and live trading remains LOCKED.

## Exercise a copy event

1. Choose followers from Accounts 02–10. Account 01 is the synthetic leader.
2. Set the maximum leverage, order value and planned loss. Arm the simulation for the displayed session duration.
3. Choose side, stop/target distance and risk percentage within the armed envelope.
4. Optionally set a one-account synthetic failure: rejected entry, unknown entry, rejected stop or rejected target.
5. Generate a new leader entry and inspect each follower separately. Another follower's failure does not prevent valid accounts from executing.

The event has a durable identity. Replaying it or reloading the page does not submit it again. Accounts execute in independent lanes; operations concerning the same account stay ordered.

The page shows intended side and quantity, submission and fill state, fill price, stop and target state, exposure and the reason for a problem. Global session locking is shown separately. UNKNOWN means submission or exposure needs reconciliation; it does not mean an order was rejected.

## Repairs

Repairs act on one event and one account. They use current ownership evidence and serialize with that account's work.

| Control               | Required evidence and behavior                                                                                                                                                                          |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Reconcile             | Reads current correlated evidence; available while entries are locked. No entry resubmission.                                                                                                           |
| Add Stop / Add Target | Requires an armed session and a proven owned position. An exit can be added only when its original submission was never attempted or was conclusively rejected; uncertain exits require reconciliation. |
| Flatten               | Requires an armed session and conditional ownership/revision checks. It closes the proven owned position and reconciles remaining exposure and exits.                                                   |
| Skip                  | Records an explicit disposition; it does not close an existing position.                                                                                                                                |
| Retry                 | Requires an armed session, the expected current attempt identity and conclusive terminal rejection/non-submission evidence with no possible future fill. UNKNOWN has no Retry action.                   |

A repair timeout or uncertain result stays visible. Reconcile before considering another action; do not treat a lost acknowledgement as proof that nothing happened.

The copier copies entry events rather than forcing follower position state to match the leader. Stop-outs, manual closes, skips and operator flattening do not cause automatic reopening.

## Leader position and protection changes

Choose an original entry event, then generate ADD, REDUCE, CLOSE, a stop change or a target change. These are accepted synthetic leader events, not real leader observations. The initial synthetic leader quantity is 1; quantity deltas scale from each follower's immutable initial fill. Adds apply aggregate risk checks to existing exposure. Reductions resize owned exits; a close removes owned exposure and exits without opening an opposite position.

Changes run concurrently across followers and in order within each account. Only unsent stop/target intents of the same type may be superseded by newer intent. Economic changes are never coalesced. An existing stop is amended by its stable identity; uncertain creation blocks another creation.

The dashboard keeps historical entry fills separate from current owned exposure. Each change shows QUEUED, SUBMITTING, VERIFIED, PARTIAL, REJECTED, UNKNOWN, SUPERSEDED, NOT SENT or SKIPPED, its intended price/quantity and fixture timings. Entry protection displays SUBMITTING and the intended level before provider acknowledgement. VERIFIED means correlated synthetic evidence passed; a missing sibling exit remains explicitly flagged.

Reconcile Change is read-only and works while locked. UNKNOWN never has an automatic retry. Once position-change tracking owns a root, legacy mutating repairs are blocked because their original entry-size scope is stale. Current owned exposure now has Add Stop, Add Target, Flatten and Reconcile Position controls using its current quantity and revision. Add only creates genuinely missing protection; it never replaces an existing exit. An explicit operator action has its own durable identity and does not invent a leader event or change the historical entry fill. UNKNOWN operator results show Reconcile Repair, with no retry. Operator flatten may reduce owned exposure even if the session's risk ceilings have since been lowered.

Leader changes and operator repairs share an atomic per-root reservation in SQLite. Admission checks the current root revision and both pending-command ledgers in the same transaction that records dispatch. UNKNOWN retains the reservation across restart until correlated terminal evidence settles it. Read-only position reconciliation also checks that no command owns the root when it commits; older provider revisions cannot clear recorded exposure.

Every change has a durable whole-event activation and event/account command identity. Replaying an activation after a partial write or restart reports its original records and missed followers; it never catches up previously unattempted accounts. A closed, stopped, manually exited or skipped follower is not reopened by a change.

## Timing and restart

The dashboard displays observed **fixture** leader→submit, leader→fill, submit→fill and fill→protection durations, submission spread and fastest/slowest fills. Missing observations stay unavailable. Clock-domain mismatches are not combined. These numbers are not Vest latency measurements.

The synthetic copier uses a separate `copier-simulation.sqlite` sidecar when the dashboard uses persistent storage. It does not adopt the legacy simulator's fleet or journal. Restart restores durable events, outcomes and simulated books but resets authority to LOCKED. Restoration never automatically sends an entry or repair.

The browser keeps the local mutation token in memory. It does not persist copier state or tokens in localStorage or sessionStorage. Private HTTPS hosting uses the existing sign-in, exact origin and mutation authorization boundaries; signing out locks the copier session.

## Limits

This page proves local workflow and synthetic failure handling. Actual Vest account contexts, accepted leader event feed, order correlation, trading units, protection behavior, network scope and provider latency remain unproven. Leader reduction/close and TP/SL-change propagation are implemented for fixtures; authentic Vest integration remains pending. See the [provider evidence contract](provider-evidence-contract.md) and [implementation checklist](implementation-checklist.md).
