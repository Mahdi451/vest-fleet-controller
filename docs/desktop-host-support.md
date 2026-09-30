# Windows and macOS customer hosts

Customer execution hosts must support **Windows and macOS natively**. The phone is
an authenticated remote control for the engine running on that customer's computer.
Customers must not need Ubuntu, WSL, a Linux virtual machine or a Linux VPS to use
the product. Linux remains useful for development and reference testing.

## Current status

The mobile interface, HTTPS/session authentication, command journal and simulator
are implemented. However, native Windows/macOS dashboard startup is **not supported**.
The committed Linux route is not proof of desktop-platform compatibility:

- `machineBinding()` reads `/etc/machine-id`; macOS and Windows need an appropriate
  stable native host binding. Never replace a missing binding with a shared constant
  or silently assign new owner/instance IDs.
- Identity, configuration, keys and legacy adoption use Unix ownership/mode checks.
  Windows requires actual access-control enforcement and validation rather than
  accepting `chmod` as equivalent protection.
- Identity publication opens and synchronizes a directory. Durable publication,
  atomic replacement, file locks and path handling need native platform verification.
- Installation, certificate provisioning, startup, shutdown and diagnostics currently
  use Linux commands. Native Windows/macOS onboarding is missing.
- All recorded automated/runtime evidence is from a Linux development host and
  Chromium emulation. No native Windows or macOS acceptance is claimed.

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
explicitly pending. Exact supported versions/architectures and packaging are chosen
and recorded during that work, not inferred from Node's general availability.

Desktop portability and device acceptance precede customer-host simulation readiness.
The earlier estimate of one or two acceptance sessions assumed the Linux reference
route; it does **not** estimate the Windows/macOS port. Re-estimate after platform and
security inspection. Vest feasibility, written permission, the one-account driver
and supervised fleet expansion remain later gates.
