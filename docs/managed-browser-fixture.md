# Managed headless fixture browser

`createManagedFixture()` owns a dedicated temporary Chromium profile and a private loopback fixture server. It always launches headless. It neither attaches to an existing browser nor opens a Vest page, trading chart, extension, remote debugging endpoint or authenticated provider connection.

This is **SYNTHETIC / OFFLINE_FIXTURE evidence only**. It proves that the independently designed copier can drive named operations across real browser pages. It does not prove a supported Vest transport, actual venue account identity or live correctness.

## Boundary

- Ten generated fixture pages each have a private stable account binding, context UUID and browser generation. Before and after an operation, actual page/session identity must match that binding.
- Named page bindings call the owned simulator. The returned adapter supports account/position/order reads, entry and stop/target submissions, cancellation, and provider-atomic owned add/reduce/close/protection changes. It exposes no arbitrary route, URL, network request, Page, Browser or JavaScript evaluation handle.
- Each controller-issued operation has a private one-use invocation identity bound to its account, operation and payload. Unsolicited or replayed page calls are refused. Browser replies must match the normalized receipt actually returned by the host-side provider callback; a page cannot manufacture a successful response.
- The managed transport starts LOCKED. `armFixture()` is deliberate and memory-only; the controller separately arms its risk envelope. Restart creates a new profile/generation and never restores authority or submits a trade. Locking during pending arming revokes that arming attempt.
- Same-account work remains ordered until underlying provider callbacks settle. Another account can finish while one account's provider work is blocked. A timeout does not prove that the original operation will never finish.
- A lost follower page, renderer-crash notification or failed identity read invalidates that follower. Leader loss, unexpected navigation/origin, unexpected pages, browser loss or transport integrity failure stops new work globally. Controller lifecycle subscribers apply the corresponding existing halt/context policy.
- An unowned generic flatten is refused. Mutation correctness remains enforced atomically by the synthetic provider rather than by a page check alone.
- Bootstrap/account reads do not manufacture leader events. Event identity and no-reopen rules remain owned by the journal/coordinator.

Only the internally created origin and exact generated page/script paths are allowed by browser HTTP routing. Other requests and WebSockets are blocked; service workers are disabled. Chromium background-network, component-update, sync and default-app suppression flags are fixed. Routing proves the controlled context boundary; it does **not** prove process-wide absence of every Chromium background packet. Whole-profile/process network containment remains a separate connected security requirement.

The launcher requires an already available local test browser. It has no browser installation or updater helper. Startup failure refuses locally. Shutdown closes the browser and server and removes the temporary profile.

## Tests and limits

`tests/managed-browser.test.ts` launches real headless fixture pages and exercises independent protected entries, replay without resend, follower versus leader loss, identity/navigation failure, denied outbound attempts, pending account isolation, owned reductions/protection changes, sanitized errors and restart locking. Test-only launch observation may inspect handles; those handles are absent from the runtime API.

Real Vest pages, symbols, units, stable IDs, accepted-event feeds, credentials, network scopes and execution semantics are still unproven. Nothing in this fixture enables or authorizes funded trading. See the [provider evidence contract](provider-evidence-contract.md) and [implementation checklist](implementation-checklist.md).
