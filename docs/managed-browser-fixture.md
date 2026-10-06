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

Only the internally created origin and exact generated page/script paths are allowed by browser HTTP routing. Other requests and WebSockets are blocked; service workers are disabled. Chromium background-network, component-update, sync and default-app suppression flags are fixed. Routing proves the controlled context boundary; it does **not** prove process-wide absence of every Chromium background packet. The separate Linux contained launcher below adds process-tree isolation for offline fixtures. Connected-provider containment remains unproven.

The launcher requires an already available local test browser. It has no browser installation or updater helper. Startup failure refuses locally. Shutdown confirms browser closure and closes the server. Temporary profiles are removed after confirmed closure; an unconfirmed closure preserves the profile and reports a fixed error.

## Tests and limits

`tests/managed-browser.test.ts` launches real headless fixture pages and exercises independent protected entries, replay without resend, follower versus leader loss, identity/navigation failure, denied outbound attempts, pending account isolation, owned reductions/protection changes, sanitized errors and restart locking. Test-only launch observation may inspect handles; those handles are absent from the runtime API.

Real Vest pages, symbols, units, stable IDs, accepted-event feeds, credentials, network scopes and execution semantics are still unproven. Nothing in this fixture enables or authorizes funded trading. See the [provider evidence contract](provider-evidence-contract.md) and [implementation checklist](implementation-checklist.md).

## Linux whole-tree offline containment

`createContainedFixture()` starts the fixed fixture worker, its private loopback server and Chromium descendants together inside fresh Linux user, network, IPC and PID namespaces. The host controller communicates only over private framed standard-input/output pipes. There is no arbitrary command, browser argument, URL, attachment or fallback launcher interface.

The launcher clears inherited environment variables, drops capabilities, forbids further user namespaces, and supplies fresh temporary writable directories. Its read-only mounts include the local Node binary, browser distribution, necessary system libraries/fonts, dependency directory and explicitly listed source directories/files. The repository root, `.git`, `.runtime`, `.env`, host `/run`, host home, host `/proc` and existing browser profiles are not mounted. Namespace-local `/proc` verifies a network namespace distinct from the host, only a loopback interface, and matching namespace membership for all visible descendants. Failed prerequisites, isolation, proof or pipe integrity refuse execution. Unexpected global browser lifecycle loss halts the wrapper and terminates its owned worker. Launcher or parent loss tears down the owned PID namespace; shutdown waits for the launcher.

`tests/browser-containment.test.ts` establishes positive controls using actual headless Chromium TCP and WebRTC STUN UDP requests to disposable host-owned loopback canaries. The same targets receive no packets from the namespace-contained browser and separately spawned Node descendant. These tests also prove namespace-local account reads and protected follower execution through private pipes, startup refusal without fallback, and authority revocation/process-tree removal after launcher loss. No public domain or Vest session is contacted.

This is Linux-specific **synthetic fixture evidence**, not an approved connected trading deployment. It depends on locally available Bubblewrap, Linux user/network/PID namespaces and an already installed Playwright browser. It contains no installation/download helper. The namespace intentionally has no path to Vest. Production browser isolation, a deliberately approved Vest network policy and real provider identity/event evidence remain separate blockers.

## Owned persistent profile integration: offline fixtures only

`acquireManagedProfile()` creates an application-owned profile outside Git with private root/profile permissions and private owner/machine binding metadata. It refuses existing unbound profiles, another owner, symlink paths or contents, weakened root permissions, and an existing/stale lease. An exclusive no-follow lease binds a fresh generation and starts LOCKED. Release verifies the lease inode and original nonce before removing only that lease; profile data survives release. Stale leases require deliberate external inspection rather than automatic adoption.

`createContainedFixture()` optionally accepts a strict `ownedProfile` directory/owner binding. The host leases it before launching and maps **only its Chromium data directory** read/write at a fixed namespace path. Owner metadata and the lease remain outside the namespace. The worker receives a boolean mode flag, uses a fixed loopback fixture port for stable browser storage origin, and accepts no arbitrary profile path, URL or browser arguments.

Every launch starts LOCKED. A clean close releases the lease only after a confirmed browser-closure receipt, successful launcher exit and verification that the captured owned process tree has terminated. Process identities include start times to avoid confusion after PID reuse. Forced, interrupted or unconfirmed closure retains the lease, including after the process tree has been killed. There is no automatic recovery, stale-lease deletion or deletion of Chromium singleton markers.

`tests/managed-profile.test.ts` uses disposable directories to prove binding, permissions, exclusivity and replacement/symlink refusal. `tests/contained-profile.test.ts` launches actual headless Chromium twice inside the offline namespace. A fixed fake cookie and local-storage marker survive clean restart, whereas arming and synthetic positions are not restored. It also proves protected follower execution using that profile, separation of metadata/lease mounts, and retained leases after killed workers or unconfirmed closure.

The persistence probe is fixture test plumbing. A worker-private launch observer captures only the exact fixed profile context during the single initial launch and restores the launcher in `finally`. A narrow SEED/CHECK operation verifies the generated leader page identity and uses only fixed synthetic markers. It returns four booleans; keys, values, paths, URLs, JavaScript callbacks and browser handles cannot be supplied or exported. It refuses temporary profiles or revoked lifecycle authority. The protected execution module has no browser-storage capability, and production security policies remain unchanged.

This proves **synthetic offline browser persistence**, not actual Vest authentication storage or production profile deployment. Connected account identity, reconciliation and credential handling still require separately authorized evidence. The filesystem checks protect against mistaken adoption and detectable replacement; they do not establish isolation from an attacker already controlling the same operating-system user.
