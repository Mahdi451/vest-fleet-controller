# Goal: prove the local Vest event copier is functional

The [implementation checklist](implementation-checklist.md) is the working plan and
completion record. The [fan-out design](fanout-adoption-plan.md) defines the architecture.
Account 01 leads; prepared Accounts 02–10 execute independently. Isolated follower
failures do not block unrelated valid followers. Global identity, communication,
authentication, event/journal integrity and hedge failures stop new submissions.

Retain the existing risk engine and durable Journal; refactor execution for concurrent
account lanes without introducing a second risk/protection engine. Independently
implement useful Better Vest behavior without installing it or copying protected source.
Copy genuine leader events; never force follower positions to match the leader after exits.

## Proof categories

| Category             | Automation                              | Evidence needed                                            |
| -------------------- | --------------------------------------- | ---------------------------------------------------------- |
| Offline foundation   | Local checks and synthetic tests        | Actual acceptance cases for each implementation checkpoint |
| Vest integration     | Automatable with original integration   | Authoritative account-scoped provider observations         |
| Security and release | Checks plus independent/owner review    | Exact artifact, policies, recovery and platform validation |
| Funded trials        | Repeatable after separate authorization | Approved one-account and concurrent-fleet trial evidence   |

All current work/tests stay in the background. No foreground windows, real Vest charts,
authenticated provider requests or funded trades are authorized by this goal. Do not
commit/push, install a live extension or re-enable GitHub Actions as a report side effect.
Preserve owner edits, browser profiles and runtime records.

## Automated report

[security/functional-gates.json](../security/functional-gates.json) tracks 39 gates with
explicit prerequisites. `OFF-FANOUT` replaces the retired sequential requirement and
starts UNPROVEN. Event identity, readiness, repairs and latency now have separate pending
gates. Passing old sequential fixtures cannot close these new gates.

Run `pnpm verify:functional` for six fixed local commands: security, locked local build,
typecheck, lint, formatting and regression. Tests run without file parallelism to avoid
fixture resource contention; that runner setting does not impose sequential account
execution. Normal tests exclude `tests/authorized-live/**`. The catalog cannot choose
programs, arbitrary arguments, network destinations or live-enable configuration.

Each run writes a fresh `dist/functional-proof-<id>/report.json` with normalized results
and source fingerprints before/after execution. Relevant changes during a run invalidate
evidence. No raw subprocess output, stacks, account records, profiles or secrets are
stored. Invalid catalog fields, dependency cycles and unknown prerequisites fail closed.

`localChecksPassed` means all six commands passed, not product completion.
`offlineGatesComplete` additionally requires every offline gate to pass. Gates without
implemented checks remain UNPROVEN. Vest gates remain UNPROVEN, human gates REVIEW_REQUIRED
and funded gates AUTHORIZATION_REQUIRED. The offline reporter always states
`functional=false`, `liveState=LOCKED`, `authorizesLive=false`.

A report is a local observation, not a signature, an approval store or a tamper-proof
audit. Automated checks cannot approve policy changes, human reviews or funded execution.
Gate checks should only be enabled after corresponding acceptance tests actually exist.

## Existing evidence and remaining work

The historical report at
`dist/functional-proof-0f2e9b45-ffa3-4e41-95b8-4b63bf5700a5/report.json` passed six commands
against the earlier source/catalog. It is not current fan-out evidence. Existing risk,
observed-position hedge, recovery, containment and synthetic controller-invocation
arming tests remain useful foundations. The unfinished channel prototype is unvalidated.

Implement the checklist in order: durable events/outcomes → independent lanes →
readiness/arming/channel → original Vest integration → visibility/latency/repairs →
connected security/release candidate → separately approved provider trials.

Completion requires the requested concurrent behavior, authoritative provider evidence,
relevant tests, resolved independent review findings, inspected diff and owner release
approval. Native platform validation, real browser authentication, provider fill/protection
semantics and whole-profile egress remain unproven. No readiness flag or environment
variable permits live trading.
