# Windows and macOS customer hosts

Customer execution hosts must support **Windows and macOS natively**. The phone is
an authenticated remote control for the engine running on that customer's computer.
Customers must not need Ubuntu, WSL, a Linux virtual machine or a Linux VPS to use
the product. Linux remains useful for development and reference testing.

## Current status

The mobile interface, HTTPS/session authentication, command journal and simulator
are implemented. A small host-storage boundary now adds native Windows/macOS support:

- Stable Windows MachineGuid and macOS IOPlatformUUID bindings preserve owner/instance
  identity. Existing Linux machine hashes are unchanged; missing identity fails closed.
- Windows verifies the current SID and actual protected DACLs through native handles;
  macOS verifies ownership, modes and extended ACLs on the open file descriptor.
- Private publication and exclusive locks preserve records and reject links, unsafe
  permissions and competing owners. Windows flushes and publication verification
  support process-crash tests; sudden power-loss rename durability is not claimed.
- [Native setup](native-host-setup.md) documents per-user storage, private HTTPS,
  startup/shutdown, diagnostics and conservative recovery.
- [Native CI](../.github/workflows/native-host.yml) covers Windows Server 2025 x64,
  macOS 15 ARM64/Intel and Ubuntu regression. Run results must be recorded before
  claiming automated acceptance; workflow configuration alone is not evidence.

Physical Windows 11/Mac sleep/reboot and real phone acceptance remain open. Use the
[manual checklist](desktop-phone-sanity-check.md) to record those results.

## Next acceptance gate

1. Introduce a small platform boundary for host identity, protected storage and
   durable file handling. Preserve existing owner/runtime bindings, journals,
   exclusive locks and fail-closed behavior. Do not create another engine or rewrite
   proven risk/controller code. Obtain security/design review before implementing
   this boundary.
2. Provide native Windows and macOS installation, private HTTPS configuration,
   startup/shutdown, update, diagnostics and crash-recovery instructions. Retain
   localhost as the safe default. Do not require Linux compatibility layers.
3. Run relevant controller, journal, ownership, private-access, restart and browser
   tests on native Windows/macOS runners. Record OS/version/architecture separately;
   Linux mocks alone cannot establish native support.
4. Demonstrate real phone-to-desktop HTTPS sign-in, preview, one protected simulated
   entry, screen lock/reconnect with the same command, flatten and session revocation.
   Test actual desktop sleep/reboot and conservative recovery. Record evidence for
   each supported platform before advertising support or inviting users on it.

The existing five-second freshness policy, UNKNOWN handling, idempotency, circuit
breaker, hedge protections, reduce-only exits and emergency flatten remain mandatory.
A laptop sleeping makes its engine unavailable; native support must not introduce
queued offline entries, automatic failover or automatic re-arm.

## Release and timing

A platform is released only after its native acceptance passes. Windows and macOS
are both product targets; an initial validated platform may ship first with the other
explicitly pending. Exact supported versions/architectures are chosen and recorded
during native validation, not inferred from Node's general availability.

Desktop portability and device acceptance precede customer-host simulation readiness.
The earlier estimate of one or two acceptance sessions assumed the Linux reference
route; it does **not** estimate the Windows/macOS port. Re-estimate after platform and
security inspection. Vest feasibility, written permission, the one-account driver
and supervised fleet expansion remain later gates.

## Near-final release packaging

Final installers are deferred until features, security and recovery are nearly
finalized for the intended release. The current focus is native host portability,
setup and acceptance, not an installer or desktop-framework migration.

- Windows: signed `.exe` installer with the supported runtime/application bundled.
- macOS: equivalent signed/notarized `.app`, delivered through `.dmg` or a native package.
- Launcher: start the existing engine, open the dashboard, show status and stop gracefully.
- Storage/update: protect per-user secrets/runtime data separately from installation
  files; preserve identities, journals and unresolved commands across updates.
- Release validation: clean-machine install/launch/update/uninstall and recovery on
  each supported platform. No Git, Node, pnpm or Linux installation required of users.

See [the staged implementation plan](product-implementation-plan.md). A simulation
installer does not claim that blocked Vest-connected functionality is available.
