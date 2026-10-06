# Manual local review and release

There is no runtime updater or remote configuration. The current production artifact is inert; these steps prepare a reviewable local build and do not enable Vest trading.

## Update procedure

1. Identify the useful upstream behavior and confirm that it is needed. Treat Better Vest as external research only; do not install it in the trading profile, merge upstream changes automatically or copy protected source without permission.
2. Independently implement the behavior or review a permitted patch in this repository.
3. Run relevant tests, inspect the actual diff and resolve independent security/concurrency review findings where required.
4. Run `pnpm verify:functional`. Inspect its report, source fingerprints and unresolved gates. A green regression suite does not close a missing provider proof.
5. Review the exact local artifact and obtain human release approval. Commit, push or tag only when requested. Keep a known reviewed revision available for rollback.
6. Load only the approved local build into the dedicated profile after the connected implementation and profile requirements have been proven. Loading an inert build is not permission to connect or trade.

A running application must never download or execute an update. Rebuilding, reviewing and loading remain deliberate development/operator actions.

## Current verification

```sh
pnpm security:check
pnpm verify:functional
```

The verification command runs the security checks, local build, type checking, lint, formatting and offline regressions. It writes evidence under `dist/`. Use the exact report for the reviewed source; do not reuse a report after code changes.

Synthetic secret-canary tests cover malformed provider payloads and errors, follower snapshots, audit records, SQLite files, repair failures, latency records, channel inspection, local API errors and fixture dashboard browser storage. These tests use fake markers, not real credentials. They do not prove authenticated Vest browser storage or whole-profile network containment.

Remaining connected release requirements include exact provider origins/endpoints and operation schemas, authenticated context lifecycle, network containment, dependency/license review, required desktop platforms, recovery review and human approval. The [checklist](implementation-checklist.md) records those open gates.

## Recovery procedure

- Lock new entries when identity, authentication, channel integrity or reconciliation becomes uncertain. A lock cannot retract an order already submitted.
- Inspect each follower's durable submission, fill, exposure and protection state. UNKNOWN remains reserved and reconcile-only.
- Reconcile using the same event, account and attempt identities. Never generate a replacement event merely to bypass uncertainty.
- Add an exit or flatten only when current ownership and supported conditional execution can be proven. An uncertain protection submission must not be duplicated.
- After restart, inspect restored outcomes and books while LOCKED. Re-arm deliberately only after the envelope and account set are verified.
- Retain sanitized local evidence for review. Do not export credentials or raw authenticated provider payloads.

Before funded execution, the recovery procedures must be proven against the actual provider in separately authorized trials. Full workspace access and passing fixture tests do not authorize such trials.
