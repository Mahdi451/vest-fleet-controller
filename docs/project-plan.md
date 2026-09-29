# Combined specification and project plan

Source: user's opening handoff protocol and Sections 1–14 supplied 2026-09-29.
No separate Section 0 was supplied; the opening protocol served as the handoff.
Implementation was authorized only after Section 14.

## Goal

Build a reliable local engineering project to manage ten $500 Vest Capital Instant
funded accounts and eventually copy trade through explicitly permitted execution paths.
The valuable features are account management, independent risk sizing, previews,
execution fan-out, reconciliation, drawdown protection, simulation, logging and emergency
controls. Do not treat these perpetual products as CME NQ futures.

## Milestones

| Milestone           | Initial status                                     | Completion requirement                                                                                    |
| ------------------- | -------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| M0 Research         | Evidence register produced; major facts unresolved | Official Instant/funded API/copy rules confirmed before M5                                                |
| M1 Core             | Implemented and tested                             | Domain schemas, account model, formulas, costs, drawdown and independent sizing                           |
| M2 Simulator        | Initial simulator implemented and tested           | Ten accounts and requested core scenarios; model limitations documented                                   |
| M3 Fleet controller | Initial implementation                             | Selection, previews, mock fan-out, identity, journal, immediate reconciliation; recovery workflow remains |
| M4 Dashboard        | Deferred                                           | Local React/Vite controls after reliability work; clear simulation indicator and prominent flatten        |
| M5 Vest integration | Blocked intentionally                              | Explicitly supported execution path, verified auth/rules/metadata and user review                         |
| M6 Validation       | Unit/integration/simulator stage only              | Paper/test if available, one tiny account, small fleet, then larger fleet validation                      |

The initial requested deliverable includes a working CLI rather than a polished
dashboard. Future UI must show quote, direction, leverage choices, risk mode/value,
stop and target, account balance/floor/buffer/enabled status, and per-account calculated
orders. Controls: preview, long all, short all, prominent minimal-interaction flatten all.

## Requirement mapping

| Specification    | Delivery                                                                                  |
| ---------------- | ----------------------------------------------------------------------------------------- |
| Sections 1–3, 14 | Simulation-only boundary and dated `vest-facts.md` classifications                        |
| Section 4        | Domain/risk/controller/adapter/simulator packages; future adapter gates                   |
| Section 5        | Account snapshots and pure gross/all-in sizing tests                                      |
| Section 6        | TradeIntent, selection, preview, deterministic child IDs, mock fan-out and reconciliation |
| Section 7        | Configurable fee/slippage/funding/account cost and $2 reserve checks                      |
| Section 8        | Initial ten-account fixtures and quote-driven scenarios                                   |
| Section 9        | Preview CLI now; dashboard deferred                                                       |
| Section 10       | Allowlisted audit, SQLite reservation/replay, explicit uncertainty and circuit halt       |
| Section 11       | TypeScript/pnpm workspace, lint/format/test tooling, private repository on GitHub         |
| Sections 12–13   | Tested initial implementation and detailed README; no live implementation                 |

## Remaining gates and recommended next step

The private repository is `Mahdi451/vest-fleet-controller`; the initial implementation
and detailed README are maintained on `main`.

1. Continue M3 with persistent simulator snapshots, controlled restart/reconciliation,
   and a queued emergency operation that handles a batch already in progress.
2. Obtain direct current Instant terms and staff/source permalinks for unresolved facts.
   Add evidence without promoting observations into permanent account rules.
3. Build M4 local dashboard using the proven shared core.
4. Stop before M5 and present facts, unresolved questions, architecture, structure,
   risk/simulator behavior, test results and staged validation plan for review.

No live trades, private endpoint reverse engineering, committed credentials, fabricated
official rules, or automatic expansion to all ten funded accounts.
