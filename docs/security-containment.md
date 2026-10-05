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

## Next implementation gates

1. Memory-only, short-lived arming and constrained recovery authority, tested offline
   at the sole sequential dispatch boundary.
2. Authenticated local browser channel, exact account/client identity and provider-order
   evidence; no generic route, function or executable-code command.
3. Original observation/drift flow that proposes controller intents and never automatically
   reopens a follower after a stop, manual close or breach.
4. Dedicated-profile and independent egress proof under the strict domain policy.
5. Reviewed artifact and explicit authorization for a scoped live trial, only after all
   release gates pass. No fixture or locked build provides live execution evidence.

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
