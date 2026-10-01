# Combined specification and project plan

Source: user's opening handoff protocol and Sections 1–14 supplied 2026-09-29.
No separate Section 0 was supplied; the opening protocol served as the handoff.
Implementation was authorized only after Section 14.

Current priority (2026-10-01): [audit and prove the permitted browser connection and
execution evidence path](vest-execution-gap-audit.md). Pause visual polish/installers.
Initial copying starts from our application's master command, not manual leader-trade
monitoring. Owner-authorized manual read-only inspection precedes review of applicable
automated-execution terms/capabilities and a separately approved one-account trial. No connected execution or real orders are enabled here.

## Goal

Build a reliable local engineering project to manage ten $500 Vest Capital Instant
funded accounts and eventually copy trade through explicitly permitted execution paths.
The valuable features are account management, independent risk sizing, previews,
execution fan-out, reconciliation, drawdown protection, simulation, logging and emergency
controls. Do not treat these perpetual products as CME NQ futures.

## Milestones

| Milestone           | Initial status                                     | Completion requirement                                                                                    |
| ------------------- | -------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| M0 Research         | Evidence register produced; major facts unresolved | Browser automation/copy permission and account scope confirmed before M5                                  |
| M1 Core             | Implemented and tested                             | Domain schemas, account model, formulas, costs, drawdown and independent sizing                           |
| M2 Simulator        | Initial simulator implemented and tested           | Ten accounts and requested core scenarios; model limitations documented                                   |
| M3 Fleet controller | Initial implementation                             | Selection, previews, mock fan-out, identity, journal, immediate reconciliation; recovery workflow remains |
| M4 Dashboard        | Local simulator dashboard implemented              | Leverage/margin allocation, fleet previews, entry controls and coordinated flatten; no live adapter       |
| M5 Vest integration | Blocked intentionally                              | Explicitly supported execution path, verified auth/rules/metadata and user review                         |
| M6 Validation       | Unit/integration/simulator stage only              | Paper/test if available, one tiny account, small fleet, then larger fleet validation                      |

The initial delivery supplied the CLI. A follow-up added a working local browser dashboard
and actual PNG screenshots in the README. The user clarified that percentages mean equity
allocated as margin; `MARGIN_PERCENT` now supports this independently from drawdown-risk modes.

## Requirement mapping

| Specification    | Delivery                                                                                  |
| ---------------- | ----------------------------------------------------------------------------------------- |
| Sections 1–3, 14 | Simulation-only boundary and dated `vest-facts.md` classifications                        |
| Section 4        | Domain/risk/controller/adapter/simulator packages; future adapter gates                   |
| Section 5        | Account snapshots and pure gross/all-in sizing tests                                      |
| Section 6        | TradeIntent, selection, preview, deterministic child IDs, mock fan-out and reconciliation |
| Section 7        | Configurable fee/slippage/funding/account cost and $2 reserve checks                      |
| Section 8        | Initial ten-account fixtures and quote-driven scenarios                                   |
| Section 9        | CLI and local dashboard with actual screenshots                                           |
| Section 10       | Allowlisted audit, SQLite reservation/replay, explicit uncertainty and circuit halt       |
| Section 11       | TypeScript/pnpm workspace, lint/format/test tooling, private repository on GitHub         |
| Sections 12–13   | Tested initial implementation and detailed README; no live implementation                 |

## Remaining gates and recommended next step

The private repository is `Mahdi451/vest-fleet-controller`; the initial implementation
and detailed README are maintained on `main`.

Use the [prototype completion checklist](prototype-todo.md) for the current ordered
tasks, stopping conditions and definition of a Vest-connected prototype.

1. Continue M3 with a reviewed operator re-arm workflow. Durable simulator snapshots, halted restart, periodic reconciliation and terminal partial fills are implemented; see [reliability audit](reliability-audit.md). Dashboard flatten coordinates with active batches.
2. Obtain direct current Instant terms and staff/source permalinks for unresolved facts.
   Add evidence without promoting observations into permanent account rules.
3. Extend dashboard recovery and synchronization using the proven shared core.
4. Stop before M5 and present facts, unresolved questions, architecture, structure,
   risk/simulator behavior, test results and staged validation plan for review.

No live trades, private endpoint reverse engineering, committed credentials, fabricated
official rules, or automatic expansion to all ten funded accounts.

## Direction change — 2026-09-29

Funded API implementation is removed from this fleet's plan: the current official FAQ
excludes Evaluation, Live Funded and Instant API trading. Do not wait for an undocumented
API or probe Capital endpoints. The next candidate is permitted visible browser UI,
sequentially, with an official native copier preferred if compatible and available.

The [browser investigation](browser-execution.md) records public FAQ/terms evidence,
the missing authenticated session, account-scope ambiguity and automation blockers.
Fixture-only browser adapter/coordinator work is safe to develop now. Production UI
selectors, concurrent contexts, session restoration and any funded trial remain gated.
