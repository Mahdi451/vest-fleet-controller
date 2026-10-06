# Offline arming, readiness and concurrent channel

Phase 3 extends the synthetic copier. It provides no Vest connection, browser
injection, real peer provisioning or live trading authority.

## Prepared follower execution

`OfflineFanoutReadiness` keeps authority in memory. A restart creates a new generation
and starts LOCKED. Explicit arming binds the leader/followers, symbol, leverage,
notional and planned-loss limits. Expiry or revocation rejects queued entries; clock
rollback invalidates the session permanently. Global integrity failures require a
fresh controller and channel rather than silently restoring authority.

`OfflineFanoutController.prepare(intent)` can prewarm exact-intent account approvals.
Preparation uses a complete, fresh account inventory and quote, expires at the
earliest relevant evidence/session boundary and is bound to account revisions and
local context generations. Returned summaries contain no dispatch capability. Internal
preparations reject cloning or modification, and attempts consume authority once.
The session admits at most 4,096 dispatch attempts over its lifetime.

Every copy consumes preparation, refreshing it when necessary. The final shared
account lifecycle still reads account/books/quote and revalidates risk. A synchronous
readiness check and atomic journal claim occur before the entry side effect. Concurrent
preparations return their own bundles rather than trusting a mutable shared cache.

Follower context loss blocks only that follower and remains blocked through unrelated
book refreshes or rearming. Explicit restoration requires fresh account evidence and
creates a new context generation. Restoring a context never catches up an already
activated event. Leader context loss or global authentication/channel/mapping loss
invalidates the fleet session. Known owned fills retain scoped protection after ordinary
entry revocation; integrity loss blocks unsafe recovery operations.

These context bindings are explicitly `LOCAL_FIXTURE`: verified synthetic account
snapshots, not authenticated Vest tab attestations. Real login/navigation/context
monitoring and complete provider inventory evidence must be implemented in Phase 4.

## Authenticated fixture channel

`authenticatedOfflineBridge` provisions separate request/response HMAC keys through
trusted in-memory closures. Keys are not exported, persisted or logged. Messages bind
session, owner/controller/browser generations, direction, sender, receiver, sequence,
body and expiry. Unknown operations and malformed payloads are rejected before effects.

An explicitly account-bound backing port permits concurrent account lanes; shared
ports retain SERIAL compatibility and are refused by the fan-out coordinator. The
receiver orders conflicting account work through actual underlying settlement.
Responses may finish out of order but must match their exact pending request. Requests
must arrive in allocation order; reordered transport traffic fails closed. Consumed
messages cannot be replayed.

Pending exchanges are bounded (64 by default) and lifetime message identities are
bounded (4,096 requests by default). Exhaustion, tampering, loss of correlation,
capability/session change, expiry or rollback quarantine the channel. Revocation cannot
undo an already submitted effect; its durable exposure remains subject to reconciliation.

This is a tested authentication protocol for fixtures. Provisioning real browser peers,
transport isolation, login/navigation notifications and credential-canary coverage are
separate work. No socket listener or new runtime network capability was added here.

## Evidence and remaining product work

Readiness tests cover preparation binding, stale evidence, revised accounts, clone/
mutation refusal, expiry/revocation, restart, local restoration and global rollback.
Channel tests cover concurrency, ordering, replay, spoof/tamper, swapped responses,
revocation, stale traffic, generation changes and capacity bounds. Integration tests
exercise independent protected followers through the authenticated fixture channel.

The dashboard remains the legacy simulator. Original Vest integration and event
propagation are Phase 4; dashboard repairs and measured latency are Phase 5; connected
security/release review and separately authorized live proof remain Phases 6–7.
Passing `OFF-READINESS`, `OFF-CHANNEL` or `OFF-FANOUT` proves fixtures only.
`VEST-LIFECYCLE` and all live gates remain unproven or locked.
