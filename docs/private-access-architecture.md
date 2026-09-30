# Private simulation access architecture

One provisioned owner controls one execution instance and its ten synthetic accounts.
The phone signs directly into that host. There is no shared cloud control plane,
public signup, funded account connection or Vest login.

Customer execution hosts target Windows and macOS. The current implementation uses
Linux-specific host identity and Unix permission checks, so it does not yet support
native Windows/macOS dashboard startup. The required portability and native
acceptance work is tracked in [desktop host support](desktop-host-support.md).

## Boundaries

The production loader accepts an exact HTTPS `*.ts.net` origin, a locally assigned
Tailscale IPv4 address in 100.64.0.0/10, protected configuration/key files, a matching
valid certificate and stable host/runtime identity. Direct Node TLS avoids a forwarded
identity trust boundary. Default startup remains 127.0.0.1 HTTP with existing local
mutation tokens and exact Host/Origin checks. Remote use is an explicit configuration.

The host access credential is randomly generated, stored separately with owner-only
permissions, and represented in configuration by a salted scrypt verifier. The
server never logs credentials, cookies or request bodies. Sign-in attempts and active
sessions are bounded. Cookies are opaque, Secure, HttpOnly, SameSite=Strict and host
scoped. Only token hashes exist in the process-local session map. Sessions expire
at an absolute deadline, are individually revocable through logout, can all be
revoked, and disappear on server restart. Authentication does not cancel accepted
execution: the host still completes and protects the job.

Every private API requires a valid session bound to the configured owner and
instance. Every mutation requires the exact Origin plus a session-specific CSRF
header. There is no CORS wildcard or trust in forwarded headers. Ownership is
resolved from the server, never from browser account/owner/instance claims. Commands
are scoped to the configured owner, instance and active simulation session.

Pairing is unnecessary: the administrator provisions the owner and instance locally,
and the phone authenticates directly. No pairing token, reassignment or remote
registration path exists. A future control plane would need separately reviewed
expiring single-use pairing and tenant isolation.

## Execution ownership and recovery

The existing exclusive runtime lock remains the execution fence. Stable local
identity and private configuration bind the runtime to the host machine ID and
canonical directory. A copied configuration or moved runtime is not automatically
rebound. Host administrators must preserve unique machine identities; this is a
single-host fence, not a distributed lease or a defense against a malicious host
administrator deliberately rewriting identities.

Recognized pre-identity simulator journals are adopted in place under the lock.
Identity publication progresses ADOPTING → ACTIVE around idempotent journal transactions.
The immutable legacy binding preserves placeholder command IDs/hashes and aliases;
legacy previews cannot execute, interrupted acceptance becomes UNKNOWN, and all
adopted journals halt. Missing, malformed or foreign identity-era data is rejected.

A conflicting or crash-retained lock prevents startup. No timer, PID probe, browser
reload or network reconnect takes ownership. Shutdown blocks new work, waits for
accepted work, closes the adapter/journal, then releases only its own lock. Recovery
requires confirming the previous owner is stopped and preserving evidence before
explicit operator action. There is no automatic failover or re-arm.

Saved positions and circuit state survive restart. Books are reconciled first and
restored sessions stay HALTED. Interrupted accepted commands become UNKNOWN.
Reconciliation may clean unsafe exposure but never erases the original unsafe result.
The existing risk sizing, hedge guard, fill-anchored reduce-only protection, journal
claims and emergency flatten are unchanged.

See [host operations](private-phone-access.md) and [validation](mobile-private-validation.md).
