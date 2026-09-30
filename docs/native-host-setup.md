# Windows and macOS simulation host setup

**SIMULATION ONLY.** This is a source-based development beta, with native host
implementation and acceptance work tracked in [Issue #1](https://github.com/Mahdi451/vest-fleet-controller/issues/1).
Native CI and physical-device evidence determine release readiness; these instructions
alone do not establish a supported customer release. Windows installers and signed
Mac packages are scheduled near final release, not required for this development beta.

The target machines are **Windows 11 x64** and **macOS 15 or later**, on Apple silicon
or Intel. Use the native runtime matching the machine architecture. GitHub's Windows
Server 2025 runner provides Windows integration evidence; it is not physical Windows
11 acceptance. The phone displays controls; the desktop owns the simulator and journal.
No Vest account, login, cookie, API token or funded trade is involved.

## 1. Install development prerequisites

Install Git and [Node.js 24.x](https://nodejs.org/en/download), selecting the 24.x line
and the correct native architecture. Install [pnpm](https://pnpm.io/installation)
at the repository's pinned **11.25.0**, rather than the current generic installer version.
Use an ordinary dedicated OS user for the application. Administrator permission may
be needed for OS installers; the dashboard itself must run as that ordinary user.

Windows PowerShell:

```powershell
node --version
npm.cmd install --global pnpm@11.25.0
pnpm.cmd --version
git clone https://github.com/Mahdi451/vest-fleet-controller.git
Set-Location vest-fleet-controller
pnpm.cmd install --frozen-lockfile
pnpm.cmd exec playwright install chromium
pnpm.cmd check
```

The `.cmd` form avoids PowerShell's script-execution-policy restriction without
changing that policy. Use PowerShell for this guide, not WSL. Reopen the terminal if
an installer added commands to PATH. Git for Windows supplies OpenSSL for the TLS
test fixtures; keep its normal installation. No OpenSSL command is needed for the
application's production Tailscale certificate flow.

macOS Terminal:

```sh
node --version
npm install --global pnpm@11.25.0
pnpm --version
git clone https://github.com/Mahdi451/vest-fleet-controller.git
cd vest-fleet-controller
pnpm install --frozen-lockfile
pnpm exec playwright install chromium
pnpm check
```

Git may prompt for Apple's command-line tools. Use a user-owned Node installation if
global npm installation needs permission; do not run the dashboard with `sudo`.
Native architecture and versions must be recorded in the acceptance evidence.

## 2. Choose and preserve the runtime

**Existing users:** keep the original `.runtime/dashboard` or previously configured
runtime on its original machine, under the same OS user and canonical path. Do not
move it into a new location as part of this upgrade. A new path creates another
simulator; it does not recover old commands or positions. Binding checks reject
different users, host identities and canonical paths. Cloning an OS machine identity
or runtime is unsupported and never authorizes another execution owner.

**Fresh users:** place runtime data outside the source/install directory and cloud
sync folders. Suggested locations are:

| Platform | Fresh runtime location                                                    |
| -------- | ------------------------------------------------------------------------- |
| Windows  | `%LOCALAPPDATA%\VestFleetController\runtime` on local NTFS                |
| macOS    | `~/Library/Application Support/VestFleetController/runtime` on local APFS |

Avoid shared/network/removable filesystems, symlink/junction-based workarounds and
folders shared with other OS users. The application creates protected directories
and validates OS ownership and permissions; Windows uses actual ACLs, not `chmod`.
Existing unsafe permissions fail closed rather than being silently rewritten.

Choose exactly one of the following runtime assignments and retain it for every
startup, diagnostic and private configuration operation.

Windows, fresh runtime:

```powershell
$runtime = Join-Path $env:LOCALAPPDATA 'VestFleetController\runtime'
pnpm.cmd dashboard --runtime "$runtime"
```

Windows, existing default runtime, from the original repository directory:

```powershell
$runtime = (Resolve-Path '.runtime\dashboard').Path
pnpm.cmd dashboard --runtime "$runtime"
```

macOS, fresh runtime:

```sh
runtime="$HOME/Library/Application Support/VestFleetController/runtime"
pnpm dashboard --runtime "$runtime"
```

macOS, existing default runtime, from the original repository directory:

```sh
runtime="$PWD/.runtime/dashboard"
pnpm dashboard --runtime "$runtime"
```

The unchanged no-flag default is `.runtime/dashboard`. It is not automatically
moved to a per-user location. A retained lock or identity mismatch must be investigated
against the original runtime rather than bypassed with a fresh directory.

Open **http://127.0.0.1:4173**, confirm SIMULATION and the ten synthetic accounts,
and record the displayed owner/instance identity. Keep the terminal running.
Press **Ctrl+C** and wait for full process exit before provisioning private access.
Accepted work settles before shutdown releases the owned lock. Preserve the runtime
created here; all subsequent steps use it.

## 3. Run the host preflight

Windows:

```powershell
pnpm.cmd host:doctor --runtime "$runtime"
```

macOS:

```sh
pnpm host:doctor --runtime "$runtime"
```

Doctor checks the host/runtime binding, permissions and retained-owner diagnostics.
With private configuration it also checks network/TLS readiness. It reads without
creating records, repairing permissions, deleting locks, reconciling or arming a
simulation. Its output is redacted; do not replace it with credential-bearing HTTP
traces or dumps of configuration/secret files. A missing runtime is reported as
uninitialized; unsafe storage fails preflight. Neither establishes execution readiness
or gives permission to reset existing records.

## 4. Configure the private network

Install Tailscale on the desktop and phone, sign in to the intended private tailnet,
and authorize only the approved devices to reach this host's TCP **4173**. Follow
the official [Windows installation](https://tailscale.com/docs/install/windows) or
[macOS installation](https://tailscale.com/docs/install/mac). On Mac, the standalone
variant is the documented recommended option. Enable its **Settings → CLI integration**;
the [official CLI instructions](https://tailscale.com/docs/reference/tailscale-cli?tab=macos)
explain installation of the `tailscale` launcher. The App Store variant instead
bundles the CLI at `/Applications/Tailscale.app/Contents/MacOS/Tailscale`; use that
quoted executable path where these examples use `tailscale`.

Windows uses the installed executable. If `tailscale` is missing from PATH, locate
`tailscale.exe` in its installation folder; the default is normally
`C:\Program Files\Tailscale\tailscale.exe`. PowerShell invokes a quoted executable
with `&`, as in `& 'C:\Program Files\Tailscale\tailscale.exe' status`.

Enable MagicDNS and HTTPS certificates in the tailnet admin console using
[Tailscale's HTTPS instructions](https://tailscale.com/docs/how-to/set-up-https-certificates).
Record the host's exact `machine.tailnet.ts.net` name and its IPv4 from `tailscale ip -4`.
Certificate names appear in public Certificate Transparency records, so avoid personal
information in the hostname. Do not use router forwarding, Tailscale Funnel, a public
proxy or an insecure HTTP/certificate-warning fallback. The app accepts only the exact
configured HTTPS origin and an assigned Tailscale IPv4 bind address.

## 5. Issue and protect TLS files

Create TLS files beneath the already protected runtime, under the same OS user.
Replace the example hostname with the host's exact Tailscale DNS name. The certificate
command and explicit file options are defined in the
[Tailscale CLI reference](https://tailscale.com/docs/reference/tailscale-cli#cert).

Windows:

```powershell
$tailscale = Join-Path $env:ProgramFiles 'Tailscale\tailscale.exe'
& $tailscale status
& $tailscale ip -4
$hostName = 'machine.tailnet.ts.net'
$tlsDirectory = Join-Path $runtime 'tls'
New-Item -ItemType Directory -Path $tlsDirectory -Force | Out-Null
$cert = Join-Path $tlsDirectory 'host.crt'
$key = Join-Path $tlsDirectory 'host.key'
& $tailscale cert "--cert-file=$cert" "--key-file=$key" $hostName
pnpm.cmd host:protect --path "$key"
```

macOS:

```sh
tailscale status
tailscale ip -4
host_name='machine.tailnet.ts.net'
tls_directory="$runtime/tls"
umask 077
mkdir -p "$tls_directory"
cert="$tls_directory/host.crt"
key="$tls_directory/host.key"
tailscale cert --cert-file="$cert" --key-file="$key" "$host_name"
pnpm host:protect --path "$key"
```

Stop if issuance fails. If OS authorization is required, follow Tailscale's native
authorization process, then return to the application's ordinary user before
hardening/checking the files. Do not start the dashboard with elevated authority.
`host:protect` explicitly restricts one freshly generated TLS private key; it does
not repair runtime directories or rewrite identity, journals, locks or recovery state.

Files issued with `tailscale cert` require operator renewal. Check expiry before
maintenance, renew before expiration, protect the renewed key again and restart
gracefully to load the files. The application rejects expired, mismatched or unsafe
TLS material; disabling verification is not a recovery option.

## 6. Provision private access

Replace `100.100.100.100` with the host's actual assigned Tailscale IPv4.

Windows:

```powershell
pnpm.cmd setup:private --origin "https://${hostName}:4173" --bind '100.100.100.100' --cert "$cert" --key "$key" --runtime "$runtime"
$privateConfig = Join-Path $runtime 'private-access.json'
pnpm.cmd host:doctor --runtime "$runtime" --private-config "$privateConfig"
pnpm.cmd dashboard --private-config "$privateConfig"
```

macOS:

```sh
pnpm setup:private --origin "https://${host_name}:4173" --bind 100.100.100.100 --cert "$cert" --key "$key" --runtime "$runtime"
private_config="$runtime/private-access.json"
pnpm host:doctor --runtime "$runtime" --private-config "$private_config"
pnpm dashboard --private-config "$private_config"
```

Setup preserves the local owner/instance and creates owner-only `private-access.json`
and `access-secret.txt`; existing provisioning is not overwritten. It validates the
origin, assigned IP, certificate, private key and identity binding. Read the secret
privately on the host and transfer it through a trusted password manager to your phone.
Never print it into logs, pass it on a command line, put it in a URL, screenshot it or
commit it. The configuration stores a salted verifier. This secret grants access to
the simulator, not to Vest. No pairing service or remote reassignment is involved.

An existing simulation restarts **HALTED**. Provisioning and successful sign-in do not
arm it. Inspect/reconcile/flatten restored books first. If all records are resolved,
**New simulation** is an explicit fresh-session action that preserves earlier journals;
it is not a re-arm of the previous balances or a workaround for UNKNOWN.

## 7. Sign in and verify the phone

With Tailscale connected on the phone, open the configured HTTPS hostname including
`:4173`. The browser must trust the certificate without any bypass. Sign in using
the host access secret. Compare displayed owner and instance UUIDs with the protected
host `identity.json`; confirm SIMULATION, the correct fleet and verification age.
Controller reachability alone does not establish fresh/protected account evidence.

Use Add to Home Screen from a supported mobile browser and confirm SIMULATION remains
visible in standalone mode. Run the [desktop/phone sanity checklist](desktop-phone-sanity-check.md)
and record actual devices/versions. Browser emulation cannot check real phone sleep,
Home Screen installation or host power behavior. This app has no service worker,
offline mutation queue or blind reconnect retry.

## 8. Operate, restart and recover

The dashboard process also owns execution; no second worker or auto-start service is
needed. Reconcile checks books without re-arming. Keep FLATTEN ALL reachable, and read
individual outcomes: UNKNOWN is unresolved even after successful cleanup.

For normal shutdown, press Ctrl+C once and wait for process exit. Do not close the
terminal or launch a replacement while accepted work is settling. Restart with the
same runtime/private configuration and OS user. Phone sessions are invalidated on
restart; restored balances/positions and circuit state remain, entries stay HALTED,
and books reconcile. Nothing executes while the simulator is stopped.

Sleep pauses host work and can make phone evidence stale or disconnected. Waking
does not prove protection or authorize new entries; refresh/reconcile and inspect.
After reboot, restart manually. A retained crash lock prevents automatic takeover.
In a new terminal, reassign the original runtime/configuration variables or use their
saved absolute paths; never select a fresh path to make restart succeed.

For a retained lock:

1. Run doctor against the original runtime. Inspect the recorded PID and the exact
   owning process using Windows Task Manager or macOS Activity Monitor. Stop any
   related launcher/service and disconnect remote control.
2. Establish that the previous execution owner is stopped. PID absence alone is not
   authority for takeover if another machine or copied runtime could still execute.
3. Preserve a protected copy of the whole runtime, including SQLite WAL/SHM files.
4. Only after authoritative ownership review, explicitly archive the retained
   `controller.lock` under a different filename and preserve it as evidence.
5. Start against the original runtime. Inspect HALTED recovery, durable command
   identity, positions and protection. PENDING becomes UNKNOWN; do not resubmit it.
6. Flatten/reconcile where appropriate. Unresolved records remain preserved and block
   unsafe reset. This beta provides no journal-rewriting or automatic re-arm shortcut.

Do not delete runtime records to bypass a lock or halt. Do not restore older journals
as permission to replay accepted work. A copied/moved runtime requires an explicit
future migration/recovery design, not changed owner IDs or a new identity file.

## 9. Revocation, updates and diagnostics

Logout revokes the current phone session and clears private browser state. A graceful
server restart revokes every session. Remove a lost phone from the tailnet to deny
network access as well. For full-instance revocation, stop the server and deliberately
set `active` to `false` in its protected private configuration; startup then rejects
that instance. Preserve owner/instance binding. Credential rotation is deliberate host
maintenance, not deleting provisioning files and assigning a fresh owner.

Before updating, inspect/flatten/reconcile, ensure accepted work has finished, shut
down gracefully and preserve the complete runtime and current commit reference.
From the source directory, run `git pull --ff-only`, `pnpm install --frozen-lockfile`
and `pnpm check` (`pnpm.cmd` in PowerShell), then doctor and restart with the same
runtime. A failed update stays stopped; rolling back application code does not roll
back journals or authorize another entry.

Runtime files include `identity.json`, `private-access.json`, `access-secret.txt`,
`controller.lock`, `active-session.json`, UUID `.sqlite` journals and optional WAL/SHM
files. Audit events live in SQLite; startup diagnostics go to the terminal. Keep files
and any captured diagnostics private, outside git and cloud sync. Doctor is the first
diagnostic; avoid secret-bearing network traces. Permission, host/path, TLS, disk or
unresolved-command failures must be repaired without removing safety records.

Vest-connected execution remains blocked until the permission and visible-capability
review defined in Issue #1 is completed.
