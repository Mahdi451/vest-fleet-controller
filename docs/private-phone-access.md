# Private phone access: Linux reference installation

**SIMULATION ONLY.** No Vest account, password, token or funded execution is used.
This guide describes the existing **Ubuntu 24.04 LTS x86-64 reference route**,
Node.js 24.x and pnpm 11.25.0. Customer hosts target **Windows and macOS**; use the
[native setup guide](native-host-setup.md) for their identity, protected storage,
startup and diagnostics. Native automated and physical acceptance are tracked
separately in the [desktop host support gate](desktop-host-support.md). Customers
must not be required to install Linux or WSL to use the product.

Linux integration tests and Chromium emulation run in the development environment;
a clean Ubuntu installation and a real phone/tailnet trial remain unverified. This
guide is retained as reference evidence, not Windows/macOS onboarding instructions.

## 1. Prepare the host and private network

Install the OS tools with `sudo apt update` then
`sudo apt install git openssl ca-certificates curl`. Install **Node.js 24.x** using
[the official Node download instructions](https://nodejs.org/en/download), selecting
the 24.x line rather than the latest release. Once Node/npm are available, install
the pinned package manager with `npm install --global pnpm@11.25.0`; use a user-owned
Node installation so this needs no sudo. Verify `node --version` and `pnpm --version`.
The project deliberately pins pnpm 11.25.0; [generic pnpm installation instructions](https://pnpm.io/installation)
may select a newer major release. Use a dedicated ordinary OS user, disk encryption
and adequate free space. Install Tailscale using its [Linux installation instructions](https://tailscale.com/docs/install/linux),
and enroll the host and phone in your private tailnet. Configure tailnet access policy
so only your approved devices can reach this host's TCP port **4173**. Do not use
router port forwarding, a public proxy or Tailscale Funnel. The app binds only the
configured Tailscale IPv4 address; public-interface binding is rejected.

The host must stay awake for continuous access. Sleep stops verification and execution;
the phone will block entries when evidence ages or connectivity fails. This is not
an always-available hosted service. Waking does not establish fresh protection by itself.

## 2. Clone, install and verify locally

### Upgrade an existing Linux reference runtime

Earlier versions could create `.runtime/dashboard` with mode `0755`; this version
requires owner-only `0700`. Startup deliberately rejects the old permissions without
changing records. This is an explicit in-place permissions migration, not a reset:

1. Gracefully stop the original dashboard and verify no other process owns this
   runtime. Preserve an encrypted or owner-private backup of the complete directory,
   including SQLite WAL/SHM. A retained crash lock requires the separate ownership
   recovery procedure; do not delete or archive it merely to change permissions.
2. From the original source directory, inspect the actual directory with
   `ls -ld -- .runtime/dashboard` and `stat -- .runtime/dashboard`. Confirm it is
   a regular directory owned by your current `id -u`, not a symlink, with the
   original host/path and records. Stop for unexpected ownership or permissions.
3. Only after that review, run `chmod 700 -- .runtime/dashboard` as its existing
   owner, without `sudo`, relocation, recursive record changes or identity edits.
4. Run `pnpm host:doctor --runtime .runtime/dashboard`, then restart against the
   same runtime. Confirm original owner/instance, retained journals and HALTED
   recovery. Changing permissions does not resolve UNKNOWN or authorize re-arm.

Existing journal contents, Linux machine hashes and identity bindings are preserved.
Do not use a fresh runtime to bypass a failed upgrade or a safety halt.

### Fresh installation

```sh
git clone https://github.com/Mahdi451/vest-fleet-controller.git
cd vest-fleet-controller
pnpm install --frozen-lockfile
pnpm exec playwright install chromium
pnpm check
pnpm dashboard
```

Open `http://127.0.0.1:4173` locally, confirm SIMULATION and review the ten synthetic
accounts. This exact loopback address remains the default; remote phone access requires
explicit private configuration. Stop with Ctrl+C before private provisioning. Both
routes use `.runtime/dashboard`; do not run two owners against that directory.

## 3. Obtain private HTTPS certificates

Enable MagicDNS and HTTPS certificates using [Tailscale's HTTPS instructions](https://tailscale.com/docs/how-to/set-up-https-certificates).
Choose the host's exact fully qualified `machine.tailnet.ts.net` name and obtain its
Tailscale IPv4 with `tailscale ip -4`. Tailscale certificate names enter public
Certificate Transparency logs; choose a machine name without personal information.
Certificates obtained through `tailscale cert` need renewal; check certificate expiry
before maintenance and repeat issuance before expiry.

```sh
mkdir -p .runtime/tls
chmod 700 .runtime/tls
# Replace the example with the host's exact Tailscale DNS name.
tailscale cert --cert-file .runtime/tls/host.crt --key-file .runtime/tls/host.key machine.tailnet.ts.net
chmod 600 .runtime/tls/host.key
```

If issuance requires sudo, transfer ownership of the files to the dedicated app user
and restrict the key to mode 600. Do not run the dashboard as root. A self-signed
certificate used by automated tests is not the trusted phone deployment route.

## 4. Provision an owner and instance

Replace the hostname and IP below with your own. All paths must point to your host.

```sh
pnpm setup:private --origin https://machine.tailnet.ts.net:4173 --bind 100.100.100.100 --cert "$PWD/.runtime/tls/host.crt" --key "$PWD/.runtime/tls/host.key" --runtime "$PWD/.runtime/dashboard"
```

Setup preserves/generates stable owner and execution-instance UUIDs. It saves
`private-access.json` and `access-secret.txt` as owner-only files in the runtime.
It validates the assigned private IP, exact HTTPS origin/port, certificate validity,
hostname/key match and host/runtime binding. Existing provisioning is not overwritten.
The server stores a salted verifier, not the plain secret, in its configuration.
Read `access-secret.txt` privately on the host and transfer it through a trusted
password manager to your own phone. Never paste it into git, issue comments, URLs,
screenshots or diagnostic logs. This is our host-access secret, never a Vest credential.

Provisioning does not arm a restored simulation. No pairing service is needed: this
owner/instance is provisioned locally and the phone signs directly into it.

## 5. Start and sign in

```sh
pnpm dashboard --private-config "$PWD/.runtime/dashboard/private-access.json"
```

On the approved phone with Tailscale connected, open the exact configured HTTPS URL,
including `:4173`. Confirm the browser trusts its certificate; do not bypass warnings.
Enter the host access secret into the private simulation sign-in form. The cookie is
Secure, HttpOnly and SameSite=Strict, expires after eight hours and is revoked by
restart. Mutations require a separate session-specific CSRF token and exact origin.
The app does not accept forwarded identity headers or arbitrary browser owner IDs.

Compare the displayed owner and execution-instance UUIDs against `identity.json` on
the host. Confirm the SIMULATION badge, synthetic quote/accounts and current evidence
status. The same server process owns the simulator; there is no separate worker to
launch or phone-side execution engine. One exclusive `controller.lock` identifies the
active OS process. Authentication or server reachability alone does not prove protection.

## 6. Install and exercise the phone workflow

Use the supported browser's Add to Home Screen menu. The manifest and icons support
standalone display. Confirm SIMULATION remains visible in the installed window.
The app deliberately has no service worker or offline trading delivery.

Select accounts, refresh preview, inspect independent risk on Accounts, return to
Trade and confirm one entry. Review PROTECTED results and both simulated exits. Turn
phone networking off, verify entries block, reconnect and query the same command.
Inspect Activity, flatten and reconcile; entries stay HALTED. Log out and verify
private state is no longer accessible. Record phone model, OS/browser versions,
screen-lock behavior and Home Screen result before calling physical acceptance passed.

## 7. Health, shutdown, restart and reboot

Authenticated `/api/health` reports SAFE/DEGRADED/HALTED; `/api/state` additionally
reports verification age, identity and durable commands. Review these in the UI.
Refresh preview to refresh synthetic quote evidence. Reconcile verifies current books
and never re-arms a halt. `UNKNOWN` is never safely flat or successful merely because
cleanup ran.

For normal shutdown press Ctrl+C (or send SIGTERM to the identified process). New
work is blocked; accepted work is settled and its journal saved before the owned lock
is released. Wait for the process to exit before restarting with the same command.
On the first upgrade from a recognized older local simulator, identity adoption
runs in place under the same exclusive lock. It durably halts each existing journal,
binds legacy placeholder commands without changing IDs/hashes, and converts PENDING
to UNKNOWN. A durable ADOPTING marker makes interrupted adoption resumable with the
same owner/instance IDs. Malformed, foreign or missing records fail closed. Do not
choose a fresh directory as recovery; it creates a separate simulator and does not
resolve the old one.

Restart retains positions, balances, circuit state and journals, invalidates phone
sessions, reconciles and stays HALTED. Sign in and inspect before any explicit new
simulation. Reset archives the previous journal; unresolved UNKNOWN/PENDING commands
prevent reset. No automatic re-arm, stale-lock takeover or failover exists.

After host reboot start manually using the same command. An ungraceful reboot can
leave the runtime lock. Do not enable automatic lock deletion or reset at boot.
This first deployment has no auto-start service; an operator verifies identity and
recovery first. Hardware sleep/reboot acceptance must be performed on the actual host.

## 8. Crash recovery and a retained lock

A lock is evidence of a previous execution owner, not disposable cache. Do not delete
journals, session manifests, identity files or locks to make startup pass.

1. Disconnect remote control and stop any related service. Read the lock's PID and
   ownership token privately; inspect the host's process list and command lines.
2. Establish that the previous process is stopped, including any other host that might
   hold a copied runtime. PID absence alone cannot authorize failover across hosts.
3. Preserve a protected copy of the complete runtime (including SQLite WAL/SHM files
   if present) for investigation. Do not restore a backup as authority to replay work.
4. Only after ownership review, explicitly archive the retained lock rather than
   destroying it; keep the evidence outside the active `controller.lock` name.
5. Restart against the original runtime. PENDING becomes UNKNOWN, restored books are
   reconciled and entries stay HALTED. Inspect commands, positions and protection.
6. Use flatten/reconcile for cleanup. UNKNOWN remains unresolved; this build deliberately
   has no record-rewriting/re-arm shortcut. Investigate the journal and keep that runtime
   halted until an explicit reviewed recovery procedure exists.

Never silently move or clone the runtime to another host. Machine ID and canonical
path bindings reject copies/moves. They assume a trusted administrator and unique OS
machine IDs, not a distributed lease system.

## 9. Revoke access and update

Logout revokes that phone session. `/api/revoke-sessions` is an authenticated exact-origin
CSRF-protected POST with `{}` that revokes all sessions. Stopping/restarting the server
also invalidates all sessions. Removing a phone from your tailnet denies network access.
To revoke the entire instance, stop the host and set `active` to `false` in the protected
configuration; production startup rejects revoked instances. Do not change owner/instance
UUIDs to transfer a runtime. Credential rotation requires an intentional host maintenance
operation: generate a new random secret and salted verifier, preserve identities and
bindings, then restart. Public registration and remote reassignment are absent.

Before update, flatten/reconcile and inspect unresolved records, shut down gracefully,
and preserve the complete runtime and current commit reference in protected storage.
Run `git pull --ff-only`, `pnpm install --frozen-lockfile`, and `pnpm check`, then restart.
Do not update while an accepted command is still running. A failed update stays stopped;
rollback application code deliberately without rolling back journals to authorize replay.
Renew TLS certificates before expiry and restart gracefully to load renewed files.

## 10. Files, diagnostics and troubleshooting

Runtime files: `.runtime/dashboard/identity.json`, `private-access.json`,
`access-secret.txt`, `controller.lock`, `active-session.json` and session UUID `.sqlite`
journals. TLS files: `.runtime/tls/`. These are ignored by git and must stay private.
Audit events are allowlisted journal records. Startup diagnostics go to the terminal;
if captured, keep logs owner-only and avoid credential-bearing HTTP traces.

- Cannot connect: confirm process, Tailscale connectivity/policy, assigned IP, exact
  hostname/port and trusted unexpired certificate. Public exposure is not a fix.
- Sign-in rejected: verify secret privately; bounded failures temporarily throttle login.
  Expired/revoked sessions require sign-in. No token belongs in a URL.
- Origin/CSRF denial: use the exact configured URL, not an IP, alias or public proxy.
- Stale evidence: refresh preview; new entries remain blocked until evidence is fresh.
- Lock conflict: another owner or retained crash evidence exists; use the recovery procedure.
- HALTED/UNKNOWN: inspect Activity and reconcile/flatten. Restart is not arming permission.
- Disk/persistence error: stop accepting entries, preserve evidence and repair storage.
  Never remove safety records to bypass the error.
- Host/path/identity mismatch: restore the correct original binding; no automatic takeover.

Vest-connected execution remains blocked until Issue #1's permission and visible-capability
review is complete. Physical phone, clean-host onboarding and actual sleep/reboot evidence
must be added to the [validation report](mobile-private-validation.md) before invitation readiness.
