# Copier event records

Phase 1 adds records to the existing Journal without dispatching trades or changing
its legacy controller. Copier tables are created on the first explicit `journal.copier`
access; ordinary journal creation and reopen preserve the legacy inventory. Adoption
of a copier-enabled database through legacy recovery is deliberately unsupported.
The schemas currently accept only synthetic offline evidence
and the existing NDX fixture symbol. Real Vest event identities, ordering and position
ownership remain unproven; a future adapter must establish those facts independently.

## Identity and ordering

Leader/source/provider-event identity determines one durable event ID. Canonical
quantities and immutable event facts prevent formatting differences from creating a
second event; changed facts under the same identity stop new work globally. Observation
generation and detection time are separate from event identity.

Streams have a durable baseline, contiguous cursor and high-water mark. Gaps block
admission. Filling a gap does not authorize catching up an old entry. Closed roots and
per-follower exit/skip dispositions survive restarts; snapshots are not entry events.
A genuine new entry has a new root and may become eligible independently.

## Commands, attempts and outcomes

One event plus one follower determines one immutable command. SQLite transactions
atomically claim its first attempt, including across competing processes. A separate
owner-bound dispatch-start record reserves the send boundary. These records do not
provide a browser capability or trading authorization.

Submission certainty, partial/full fill, average fill price, stop, target and exposure
are independent fields. A rejected order does not erase uncertain or existing exposure.
Account-local unresolved attempts block that account; global identity, storage or system
failures stop new admission. Non-entry mutations require owned exposure under the same
entry root. Concurrent reservations and the fleet hedge guard are Phase 2 work.

UNKNOWN never grants retry. Explicit retry requires correlated terminal evidence that
the prior attempt was not sent or was conclusively rejected, with no remaining execution
and absent exposure. Retries are linked attempts. Once a successor exists, prior attempt
observations are frozen except for exact replay. A positive fill with absent exposure
requires correlated exit evidence; a fill acknowledgement alone cannot prove closure.

Public record reads sanitize storage failures, check stored identities and terminal
proof correlation, and attempt to persist a global integrity stop. Broken storage may
prevent that stop from being written; the read still fails closed.

## Evidence and remaining work

`tests/copier-records.test.ts` contains 61 offline cases, including two competing
processes, database restart, immutable payloads, historical row preservation, stale and
changed observations, partial fills, rejected/unknown attempts, exit proof, corrupted
reads and every supported exit/skip disposition.

This is a record-layer milestone. It does not prove fan-out, provider reconciliation,
arming, browser isolation, dashboard repair actions, latency or live functionality.
The production runtime remains inert and live execution remains locked.
