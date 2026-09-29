# Initial validation report

Date: 2026-09-29. Scope: local simulation-only initial implementation.

| Check                      | Result                                                                             |
| -------------------------- | ---------------------------------------------------------------------------------- |
| Node runtime               | 24.19.0                                                                            |
| pnpm                       | 11.25.0                                                                            |
| Frozen lockfile install    | Passed; all six workspace projects current                                         |
| TypeScript strict checking | Passed                                                                             |
| ESLint                     | Passed                                                                             |
| Prettier check             | Passed                                                                             |
| Vitest                     | **40 tests passed, 3 files passed**                                                |
| Preview CLI                | Passed; all ten independently sized accounts displayed                             |
| JSON preview               | Passed                                                                             |
| Partial-failure CLI        | Seven filled, account 08 rejected, 09–10 blocked                                   |
| Gap CLI                    | Ten filled, then ten permanently breached after adverse synthetic gap              |
| Retry CLI                  | Identical recorded outcome; no second entry                                        |
| SQLite audit inspection    | Submission/fill/close/price/flatten/connect events present; 54 events in retry run |

## Test coverage

Gross formulas; decimal input validation; independent account sizing; costs; reserve,
margin, leverage and freshness rejection; varied-buffer safety invariant; long/short
wins; full-fleet stop losses; gap breach; partial close accounting; funding and funding
breach; withdrawals; disabled-account handling; controller and adapter deduplication;
payload conflicts; partial failures; ambiguous responses; timeouts; price drift; opposing
fleet exposure; false fill acknowledgements; concurrency and emergency halt; journal
restart; incomplete submission recovery gate; secret-field exclusion; malformed adapter
account identity.

The CLI initially hit a sandbox IPC restriction in the `tsx` executable. Scripts now
use `node --import tsx`, which runs TypeScript without that CLI IPC server. The actual
preview and scenario commands then passed; no sandbox escalation was used.

## Example preview

Synthetic NDX price 30,400, long, 80-point stop/target, 40% all-in risk, 50x leverage,
with the explicit example cost assumptions:

| Accounts   | Buffer | All-in budget | Quantity ($/point) | Notional, rounded for display |
| ---------- | -----: | ------------: | -----------------: | ----------------------------: |
| 01         | $14.55 |         $5.82 |           0.067228 |                     $2,043.73 |
| 02–10 each | $10.00 |         $4.00 |           0.046205 |                     $1,404.63 |

These are reproducible simulation results, not live quotes or trading recommendations.

## Not validated / not delivered

- No Vest credentials, live orders, authenticated API calls or private endpoint probes.
- No verified Instant API/copy authorization, live market symbol or market specifications.
- No exchange paper environment, small real account or multi-account real validation.
- No dashboard or network controller service.
- No persistent simulator state recovery, service multi-process coordination, queued
  emergency flatten or operator recovery/reset workflow.

Next technical step: persistent simulator/reconciliation recovery and queued emergency
controls, followed by a local dashboard. Live integration remains gated by the facts
register and the user's requested pre-integration review.
