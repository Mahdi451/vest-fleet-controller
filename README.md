<p align="center">
  <img src="docs/images/logo-concept.png" alt="Vest Fleet Controller — Independent fleet control" width="640" />
</p>

# Vest Fleet Controller

A private, locally controlled Vest copy trader in development. Account 01 leads;
Accounts 02–10 will copy genuine leader events through independent follower execution,
with account-specific risk limits and clear outcomes.

**Version 0.1.1 · Offline prototype · Live trading LOCKED**

The current dashboard and CLI operate on synthetic accounts and prices. They do not
connect to Vest or place live trades. This is an independent tool, not an official
Vest product.

## Current state

| Component                                            | Status                                                                             |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Simulation dashboard and CLI                         | Working with synthetic data                                                        |
| Risk engine, hedge guard and journal                 | Existing offline foundation; concurrent integration pending                        |
| Leader events and follower records                   | Phase 1 verified offline: durable identity, atomic claims and independent outcomes |
| Fast follower fan-out                                | Next implementation milestone                                                      |
| Session arming, readiness and secure browser channel | Production implementation and proof pending                                        |
| Vest execution and reconciliation                    | Not implemented or verified                                                        |
| Follower repair controls and latency metrics         | Pending                                                                            |
| Funded-account execution                             | Locked; requires separate evidence, review and authorization                       |

Phase 1 added **61 tests** covering duplicate events, competing processes, restart
recovery, safe retry eligibility, no-reopen records and storage integrity. Independent
review findings were resolved, and all six local verification checks passed at that
checkpoint. These results prove offline behavior only.

## Planned copy-trading flow

![Planned architecture: a validated Account 01 event fans out to independent followers, then their outcomes are monitored](docs/images/fanout-flow.png)

_Planned architecture, not a screenshot or proof of connected execution. The current
simulator still uses its legacy sequential controller._

Followers execute without waiting for another follower's fill or protection. An
isolated rejection or missing stop is reported for that account. Authentication,
identity, communication-integrity or fleet-risk failures stop new events globally.

We copy **leader events**, rather than continuously matching positions. A follower
that stops out, closes manually or is skipped stays flat until a genuine new leader
entry. UNKNOWN submissions require reconciliation; they never receive a blind retry.

## Security and control

- Local control with explicitly approved Vest origins, endpoints and operations.
- No runtime updater, remote configuration, telemetry or unrelated financial actions.
- Deliberate session arming, verified account identity, risk ceilings and hedge protection.
- Durable event identity and follower commands to prevent duplicate entries.
- No credential logging or persistence; uncertain account state fails closed.

These are the connected copier's requirements. The current production artifact is
inert; connected-runtime enforcement still needs implementation and verification.
Better Vest is a behavioral reference only: no dependency or protected-source reuse.

## Run the simulator

Requires **Node.js 24.x** and **pnpm 11.25.0**, plus access to this private repository.

```sh
git clone https://github.com/Mahdi451/vest-fleet-controller.git
cd vest-fleet-controller
pnpm install --frozen-lockfile
pnpm dashboard
```

Open **http://127.0.0.1:4173** manually. No Vest login is needed. Stop the service with
`Ctrl+C`. For trade controls, sizing, recovery, phone access and troubleshooting, use
the [simulation guide](docs/simulator-guide.md).

![Existing simulation dashboard with synthetic account risk previews](docs/images/dashboard-preview.png)

_Existing simulation dashboard capture. Account balances, prices and trades are
synthetic; the planned leader/follower controls are not shown._

## Verify locally

```sh
pnpm verify:functional
```

Runs security checks, the local build, type checking, lint, formatting and offline
regression tests. It writes a local proof report under `dist/`. Passing local checks
does not prove a functional Vest copier or authorize live trading; pending gates remain
visible in the report. Funded tests are excluded from ordinary verification.

## Next milestone and documentation

**Next: independent follower fan-out**, with per-account ordering, isolated failures
and pending/UNKNOWN exposure included in fleet hedge protection.

- [Implementation checklist](docs/implementation-checklist.md) — completed work, evidence and remaining phases.
- [Fan-out adoption plan](docs/fanout-adoption-plan.md) — execution architecture and simplification.
- [Event-record contracts](docs/copier-event-records.md) — Phase 1 guarantees and limits.
- [Functional proof](docs/functional-proof-goal.md) — automation, provider evidence and live gates.
- [Security containment](docs/security-containment.md) — current locked build and boundaries.
- [Simulation guide](docs/simulator-guide.md) — operating the existing prototype.

Older plans and captures are historical where they conflict with the current checklist.
Development and testing remain in the background, without opening Vest trading charts.
