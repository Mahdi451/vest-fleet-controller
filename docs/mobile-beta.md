# Mobile simulation beta

This build runs synthetic accounts and prices only. It has no Vest connection and
is not affiliated with Vest. Trade, Accounts and Activity share the existing risk
engine, sequential controller, SQLite journal and simulator.

## Phone use

Open the dashboard, review its SIMULATION label and instance identity, choose
accounts and sizing, refresh the preview, review account risk and confirm the entry.
Only approved accounts participate. PROTECTED means both simulated reduce-only exits
were verified; REJECTED, UNKNOWN and HALTED are separate outcomes. Emergency
FLATTEN ALL remains available while entries are blocked. Reconcile checks the books;
it never automatically re-arms a halt.

The manifest declares standalone display, scope `/`, start URL `/`, branded 192/512px
icons and a 180px Apple touch icon. On supported browsers use Add to Home Screen
(Safari Share menu on iOS, browser installation menu on Android). Private phone use
requires [authenticated HTTPS](private-phone-access.md). Desktop loopback HTTP is
for local testing. Browser install behavior and background suspension vary by device.

There is **no service worker, asset cache, Background Sync or offline trading queue**.
Every API response is no-store. An unavailable connection blocks entry. Reconnect
only reads existing command status; it never automatically sends an entry.

## Freshness and command safety

Production preview and quote/account/reconciliation evidence ages are limited to
5,000ms by `config/example.yaml`. The server checks timestamps and expiry again on
entry. A reachable server can still have stale synthetic evidence. The display shows
verification time, evidence age, existing SAFE/DEGRADED/HALTED health, disconnected
state and command status. Refreshing a preview explicitly refreshes synthetic prices
and reconciles books; a network heartbeat does not refresh venue evidence or establish
protection. Browser suspension or a lost connection invalidates the entry preview.

The server issues a canonical command at preview time. Its hash covers owner,
instance, simulation session, controller preview, normalized intent and selected fleet.
The envelope records expiry, selection and PREVIEWED/PENDING/COMPLETE/UNKNOWN status
in the existing execution journal. The canonical ID is also the controller master ID,
so deterministic child IDs and controller idempotency remain authoritative.

The browser persists command identity before POST. Duplicate IDs with the same hash
return status; changed hashes conflict. Legacy master IDs become durable aliases to
the canonical command, so changing an alias cannot create another entry for the same
preview. Acceptance is saved as PENDING before dispatch. Lost responses, reloads and
other tabs recover with GET requests. PREVIEWED after a lost response is not proof
that an in-flight request cannot arrive: wait for server expiry and read status again.
Expired entries are rejected, rather than delivered later.

A crash after acceptance restores PENDING as UNKNOWN and halts. Reconciliation or
successful cleanup cannot rewrite that uncertainty as success. UNKNOWN records block
new entry and simulation reset, including the startup reset flag. Preserve records
for operator investigation; do not delete them to bypass safety state.

## Acceptance evidence

See [the validation report](mobile-private-validation.md) for commands, counts,
rendered screenshots and limitations. Chromium device emulation is not physical
Safari/Android validation. Actual trusted phone HTTPS, Home Screen installation,
screen lock and host sleep/reboot remain hardware acceptance work until recorded.
