# Desktop and physical-phone sanity checks

Use this checklist after [native host setup](native-host-setup.md), for **simulation
only**. Complete a separate record for Windows 11 x64, macOS Apple silicon and macOS
Intel that will be offered to users. Native CI, Chromium emulation and source code are
supporting evidence; they do not check these physical-device conditions.

**Current physical-device results: not recorded here.** Leave boxes/evidence blank
until the named checks are actually performed. Screenshots must show the running
simulator and exclude secrets, cookies, CSRF tokens and private configuration.

## Acceptance record

| Field                                                | Actual observation |
| ---------------------------------------------------- | ------------------ |
| Date/operator                                        |                    |
| Application commit                                   |                    |
| Desktop model/OS/build/architecture                  |                    |
| Node/pnpm versions                                   |                    |
| Filesystem and runtime's original canonical location |                    |
| Phone model/OS                                       |                    |
| Browser/version                                      |                    |
| Home Screen installation method                      |                    |
| Native CI run/link and runner OS                     |                    |
| Expected owner/instance IDs checked privately        |                    |
| Protected journal/evidence location                  |                    |
| Defects and follow-up issue                          |                    |

## A. Installation and execution ownership

- [ ] Fresh native development setup follows the guide without Linux or WSL.
- [ ] Doctor reports expected host/runtime identity and safe permissions without
      writing records, repairing a lock or changing circuit state.
- [ ] Loopback startup exposes the simulator at `http://127.0.0.1:4173`; the default
      route does not bind a LAN/public interface.
- [ ] Configured private HTTPS uses the desktop's assigned Tailscale IPv4 and exact
      hostname/port; the phone trusts its certificate without warnings/bypass.
- [ ] A second dashboard using the same runtime is rejected, with the original
      process and simulator still authoritative.
- [ ] Wrong OS user, moved/copied runtime or mismatched private configuration fails
      closed. Use disposable test copies only; preserve the authoritative runtime.
- [ ] TLS private key, host-access secret and runtime records have protected native
      permissions. No secret appears in terminal diagnostics or uploaded evidence.

## B. Sign-in, Home Screen and phone layout

- [ ] A signed-out phone sees the sign-in surface and cannot read fleet/command state.
- [ ] Sign-in reaches the expected owner/instance and synthetic ten-account fleet.
- [ ] SIMULATION stays prominent on Trade, Accounts, Activity and installed Home
      Screen launch; the interface cannot be mistaken for live Vest trading.
- [ ] Portrait and landscape fit the actual phone without horizontal page overflow,
      clipped numbers or unreachable important controls. Record widths/orientation.
- [ ] Risk cards, protection/result labels and phone touch targets remain readable.
- [ ] FLATTEN ALL is reachable while scrolling and in degraded/disconnected display.

## C. One accepted simulated entry

For this test only, explicitly start a fresh simulation after confirming all previous
records are resolved. Keep the previous journals. Reconnect/restart does not itself
authorize this step.

- [ ] Refresh preview, inspect individual risk and confirm one LONG or SHORT within
      the five-second preview window.
- [ ] Record the durable command ID privately. There is exactly one accepted command
      for that intent and at most one entry per selected account.
- [ ] Accounts and Activity show PROTECTED only when fill-anchored reduce-only stop
      and target evidence is verified. REJECTED, UNKNOWN and HALTED remain distinct.
- [ ] Double taps and rapid repeat taps do not produce a second command/trade.
- [ ] An expired preview is visibly blocked; changing inputs invalidates it.
- [ ] Flatten and reconcile reach confirmed flat results; entries remain HALTED.
      Cleanup does not rewrite an earlier unsafe result as PROTECTED.

## D. Phone suspension, offline state and two tabs

Run each case on a fresh resolved simulation or preserve the same recorded command
when checking recovery. Never create a replacement entry to investigate uncertainty.

- [ ] Disable phone connectivity before entry: the action blocks/fails closed. Restore
      connectivity and verify no delayed offline trade arrives.
- [ ] Disconnect immediately after an accepted command: the host completes/protects
      its accepted work, and reconnect recovers the same command without another POST.
- [ ] Reload immediately after submit, close/reopen the browser and background/foreground
      the phone: status recovery retains identity and does not duplicate the entry.
- [ ] Lock the phone screen during a pending command, then unlock. The original
      command is recovered, stale evidence is identified and no second trade appears.
- [ ] Open two tabs/windows, submit once and refresh/recover status in the other.
      Both observe the same accepted intent, with no duplicate entry.
- [ ] Distinguish controller unreachable from reachable-but-stale account evidence.
      A green network heartbeat alone does not label protection safe.

A deterministically lost HTTP response is covered by the private-browser automation.
For a physical lost-response demonstration, use approved test tooling on this simulator
and document exactly what was dropped. A network toggle alone is not proof the server
accepted the command or the response was lost.

## E. Sleep, restart and crash recovery

Use an isolated simulation test runtime for deliberate crash/fault cases. Do not
edit journals or delete records to create a passing result. Existing deterministic
tests create unsafe/circuit/UNKNOWN states; do not imitate them by corrupting a
personal runtime. Record the native automated run for those fault cases and separately
record actual physical sleep/reboot behavior.

- [ ] Sleep the desktop while the phone is connected. Entry becomes stale/disconnected;
      wake/reconnect does not dispatch a delayed or duplicated intent.
- [ ] Graceful Ctrl+C during accepted work waits for settlement and persistence,
      releases only its own lock, and leaves no second execution owner.
- [ ] Restart the same process/runtime with protected simulated positions: balances,
      positions and command history survive; reconciliation runs and entries remain HALTED.
- [ ] Reboot the actual desktop after graceful shutdown, start manually against the
      same runtime, sign in again and confirm preserved identity and HALTED recovery.
- [ ] Deliberate crash/ungraceful restart leaves a retained lock and prevents automatic
      takeover. After authoritative owner review, archive the lock, preserve all
      journals/WAL/SHM files and verify recovery stays HALTED.
- [ ] Pending/UNKNOWN outcomes remain unresolved and prevent unsafe new entries/reset;
      reconnect/restart never converts uncertainty into success or blindly retries it.
- [ ] Native fault tests preserve an existing circuit halt and classify unsafe positions
      conservatively, attempting cleanup without erasing the earlier unsafe outcome.

## F. Logout and access revocation

- [ ] Logout clears private account/command content and protected endpoints reject
      the old session.
- [ ] Returning to a suspended/private page while signed out hides old fleet content
      before any fresh authenticated read completes.
- [ ] Expired authentication requires sign-in, without replaying old entries.
- [ ] Server restart revokes every session; removed/revoked phone access cannot read
      account state or submit mutations.
- [ ] Native automated malicious-origin, missing-CSRF, wrong-owner/instance/account/ID,
      payload-conflict and expired/stale-command cases pass for the tested commit.

## Evidence and decision

| Check group                                            | PASS / FAIL / NOT RUN | Evidence / defect |
| ------------------------------------------------------ | --------------------- | ----------------- |
| Installation/ownership                                 |                       |                   |
| HTTPS/sign-in/Home Screen/layout                       |                       |                   |
| Preview/entry/protection/flatten                       |                       |                   |
| Offline/screen lock/reload/two tabs                    |                       |                   |
| Physical sleep/reboot                                  |                       |                   |
| Native automated crash/unsafe/UNKNOWN/circuit recovery |                       |                   |
| Logout/revocation/security                             |                       |                   |

Any failed or unrun required physical check leaves that platform/device acceptance
open. Publish only sanitized observations and evidence links to Issue #1; keep runtime
records and secrets private. Do not mark browser emulation or Windows Server CI as
physical Windows 11/phone validation.

Vest-connected execution remains blocked until the permission and visible-capability
review defined in Issue #1 is completed.
