# Local containment checkpoint

This implements the first containment stage of the
[security-first adoption plan](security-first-adoption-plan.md). Live funded execution
remains disabled. This is an independently implemented local boundary, not an installation
or derivative build of Better Vest.

## Artifact scope

The local artifact is deliberately inert: immutable locked/offline status and explicit
execution refusals, with approved policy files and a hash inventory. It has no trading
transport, browser launcher, dashboard server, remote-access listener, extension,
session credential or runtime dependency. It cannot place a trade or arm live execution.

The simulator dashboard, Tailscale access, manual observer and alternative DOM executors
remain research/test tools in the source repository. They are excluded from this artifact;
they have not become secure live tools just because the build exists. Their final removal
or consolidation still requires replacement coverage and preservation of owner edits.

The simulator's payout method and its test were removed. New audit writes no longer
declare payout fields. Existing SQLite rows are preserved unchanged; a regression reopens
a synthetic historical journal and verifies both its records and halted state. No real
runtime journal or browser profile was opened or modified by this work.

## Validation and release rules

`pnpm security:check` checks policy baselines, protected execution source and the closed
local entry graph. `pnpm build:local` runs security validation before generating and checking
the inert artifact. The normal `pnpm check` also runs security validation. Validation
stays local: `main` removed GitHub Actions to avoid private-repository charges, and
this branch preserves that decision. No workflow is introduced by containment.

Exact API/WS endpoint and browser permission lists start empty. Approved network metadata
does not itself implement network access or approve an authenticated request. Unknown
policy fields, hosts, routes or permissions fail rather than silently expanding capabilities.
Changes to these baselines, graph rules and release paths require owner review; tests and
CODEOWNERS do not enforce human approval without repository branch protection.

Production entry dependencies are inspected separately from the wider research repository.
The inert build permits only the syntax and capabilities necessary for locked status and
refusals. It rejects broader imports, dynamic loading, network primitives, native/process
powers and prohibited financial capabilities. Generated code, unexpected artifact files
and inventory hashes are checked as well. Negative fixtures exercise forbidden additions
instead of only testing the unchanged source.

Static checks are guardrails, not a sandbox or proof that arbitrary JavaScript is harmless.
For example, computed global-property names can evade the wider source blacklist;
they are rejected by the closed syntax of the inert artifact.
They do not certify all repository tools, installed development dependencies, official
Vest code, authenticated browser state or whole-profile network isolation. Expanding the
inert artifact into a real execution layer requires a new reviewed boundary and tests;
loosening the present allowlist is not a substitute.

No automatic updater, remote configuration or runtime code-download path is introduced.
There is no live enable environment variable. Updates remain reviewed local changes,
tested and audited before owner approval and manual build/load.

## Current fixture proof and connected gates

Memory-only arming, prepared concurrent follower lanes, authenticated local fixture channels and durable event identities are implemented and tested offline. Current-position repairs use separate operator identities and shared atomic root reservations; UNKNOWN stays reserved and never causes a blind resend. Followers are not forced back into an old leader position after closing.

Linux offline fixtures can now run their worker, loopback provider and entire Chromium tree inside kernel namespaces. Real headless browser and child-process TCP/UDP canaries verify that host networking is unavailable. A separate private owner-bound profile lease is tested but not integrated with Chromium. Neither result approves production Vest networking or a persistent authenticated profile.

The remaining connected gates are:

1. Authenticated provider evidence, stable account/context identity and genuine leader/order identities.
2. Exact deliberately reviewed trading/read operations, network scopes, units and protection/remainder semantics.
3. Production dedicated-profile integration, approved egress enforcement, lifecycle locking and credential containment.
4. Independent review of the exact connected artifact and manual release/recovery procedure.
5. Separate authorization for scoped live trials after prerequisite proof. Fixtures and an inert build provide no live evidence.

See the [next authenticated checkpoint](next-authenticated-checkpoint.md). The current no-foreground/no-chart instruction remains in force; no historical observer launch is automatic.

All current checks run in the background on local or synthetic fixtures. No foreground
windows, authenticated Vest requests or real trading charts are needed for this stage.

## Verified checkpoint

On 2026-10-05 on Linux, security validation, local build, typecheck, lint, formatting
and whitespace checks passed. The full sequential suite passed 471 tests with four
skips, including 53 security tests and the historical audit preservation regression.
Headless browser tests used local/intercepted synthetic fixtures, not authenticated Vest.

Independent read-only review found no blocking containment issue. Windows/macOS native
platform validation and enforcement of private-repository branch approval are still pending;
no commit, deployment, extension installation or live execution was performed.

The generated artifact is `dist/local-trading-mqN0FK` for this checkpoint. Build output
directories are unique and never merged into an existing build. To recheck this exact
artifact locally, run `pnpm security:check dist/local-trading-mqN0FK`.
