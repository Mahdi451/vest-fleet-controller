# Vest facts and integration gate

Research date: **2026-09-29** (America/Los_Angeles). Public documentation only;
no authenticated Vest calls, account-token requests, private endpoint probes, or trades.
This is an evidence register, not a statement that older evaluation rules govern Instant accounts.
Publication dates are unknown unless stated below; all sources were checked on the research date.

## CONFIRMED

| Finding                                                                                                                                                                                                                  | Scope and source                                                                                                                                                           |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Vest offers perpetual derivatives across asset categories.                                                                                                                                                               | [About Vest](https://docs.vestmarkets.com/welcome/about-vest-markets). Do not use CME NQ contract multipliers.                                                             |
| Published Silver/Gold/Platinum rules use fixed floors derived from starting balance; touching the floor closes an account.                                                                                               | [Risk rules](https://docs.vestmarkets.com/vest-capital/risk-rules). Their listed floors are $4,700/$9,400/$23,500. This does not verify the $500 Instant tier.             |
| Those rules also describe a daily loss limit, based on 4% of balance plus 50% of positive unrealized profit at the daily snapshot.                                                                                       | [Risk rules](https://docs.vestmarkets.com/vest-capital/risk-rules). Both limits apply; Instant applicability and exact daily baseline remain unresolved.                   |
| Evaluation and funded accounts are separate; passing closes the evaluation and creates a same-size funded account.                                                                                                       | [Funded accounts](https://docs.vestmarkets.com/vest-capital/funded-accounts).                                                                                              |
| General funded withdrawal docs describe on-demand requests, normally 24-hour processing, transfer to the primary account, and a 90% split.                                                                               | [Withdrawals](https://docs.vestmarkets.com/vest-capital/withdrawals). Not verified for Instant 95% plans.                                                                  |
| Capital FAQ documents leverage up to 50x.                                                                                                                                                                                | [FAQ](https://docs.vestmarkets.com/vest-capital/faq-and-refunds). Product/market restrictions still require confirmation.                                                  |
| A standard exchange v2 API is documented, with production/development URLs, delegated signing, primary address, registration API key, and account-group header. Its stated API transaction fee is 1 basis point (0.01%). | [Vest API](https://docs.vestmarkets.com/vest-api). No evidence here authorizes Instant-funded use.                                                                         |
| General funding docs describe continuous settlement and an 8-hour displayed average.                                                                                                                                     | [Funding](https://docs.vestmarkets.com/trading/fees-and-rates/funding-rate). Instant-specific settlement and rate treatment remain unresolved.                             |
| Non-crypto weekend opening restrictions are published, including NQ.                                                                                                                                                     | [Exchange notices](https://docs.vestmarkets.com/exchange-notices), notice dated 2026-07-29, effective 2026-07-31. Exact timezone/DST interpretation requires confirmation. |
| The homepage recognizes Instant accounts and discloses that their balances/results are virtual, with nonbinding trade ideas; external routing is discretionary.                                                          | [Homepage disclosures](https://www.vestmarkets.com/). Application terminology must not imply a participant-owned live brokerage account.                                   |

## LIKELY

| Finding                                                                               | Evidence and limitation                                                                                                                                                                            |
| ------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The user's $500 Instant accounts have a fixed $490 floor; profits enlarge the buffer. | User observations supplied 2026-09-29: $500/$10 buffer and $504.55/$14.55 buffer. Consistent with general fixed-floor documentation, but no official Instant rule located. Simulator fixture only. |
| Ten funded accounts are operationally available to this user.                         | User reports owning ten on 2026-09-29. Does not independently establish the contractual maximum or whether Instant accounts count toward it.                                                       |

## UNVERIFIED

| Question                                                                              | Current evidence / required resolution                                                                                                                                          |
| ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Maximum funded count; Instant inclusion; change from five to ten                      | Prior research reported staff confirmation, but no direct dated staff permalink was retrieved. Obtain current written confirmation.                                             |
| Native copier status and availability                                                 | Prior report only; no authoritative release or supported integration contract found.                                                                                            |
| Automation and cross-account copy permissions                                         | Obtain explicit permissions covering this exact account product and owner fleet. Public exchange API documentation alone is insufficient.                                       |
| Funded/evaluation API availability and roadmap                                        | Reportedly unavailable with future access planned. Neither current availability nor a promised date verified.                                                                   |
| Capital backend differs from standard exchange                                        | Prior report only. No inspection of private endpoints performed.                                                                                                                |
| Supported Capital authentication and account scoping                                  | Standard exchange authentication is documented; applicability to Capital is unknown.                                                                                            |
| NQ UI to NDX-USD-PERP mapping, tick size, size step, minimum size, multiplier, margin | Naming convention is documented, exact mapping is not. `NDX` will be a simulation-only domain symbol.                                                                           |
| Instant drawdown, fixed vs trailing, equity basis and equality boundary               | $490 is a user-observed fixture. Confirm fees, funding, unrealized P&L and withdrawals in the failure calculation.                                                              |
| Instant daily loss rule, reset clock and daylight saving behavior                     | Do not import evaluation daily-loss rules into Instant automatically.                                                                                                           |
| Instant payout split, minimums, caps, profit debit vs net payout, floor after payout  | User observed 95%; current public sources conflict by product.                                                                                                                  |
| NQ execution fee of 0.0025% each side                                                 | User observed one trade. General API docs say 0.01% per transaction, which may be a different execution path. No permanent fee default justified.                               |
| Full fee schedule and funding                                                         | Fee page could not be retrieved; verify applicable market, session, account and execution channel. Funding changes with market/time.                                            |
| Instant leverage options and margin/liquidation rules                                 | User UI offered 10/20/30/40/50x. Exact limits and liquidation buffer not verified.                                                                                              |
| Cross-account hedging prohibition and other termination conditions                    | Prior report only. Current prop terms link returned no readable body; full contractual conditions were not verified. Treat opposing fleet exposure as blocked in the prototype. |
| API numeric rate limits and reliable idempotency semantics                            | Published API shows rate-limit and duplicate errors, but no confirmed numeric quota or Capital retry contract was located.                                                      |

Research-only endpoint strings supplied by the user: `GET /v3/capital/limits`,
`GET /v3/capital/accounts`, `POST /v3/auth/account-token`, `/v3/positions/open`,
and `max_funded`. These were not called and are not implementation contracts.

## OUTDATED / CONTRADICTED

- A blanket 90% split conflicts with the user's observed Instant 95% UI; the
  [homepage](https://www.vestmarkets.com/) also advertises 80% in some sections.
  These are conflicting product descriptions, not proof of which agreement applies.
- General 50x documentation and homepage 100x marketing differ. Neither overrides
  the user's specific purchase terms or market limits.
- General 24/7 marketing is limited by the dated non-crypto weekend notice above.
- Old one-account/five-account claims are contradicted by the user's observed fleet,
  but their original dated sources were not supplied; do not mark them conclusively superseded.
- FAQ snapshot wording mentions equity and EST, while the risk page describes balance
  and ET. Confirm the daily-loss reference value and reset timezone before implementing it.
- Older funded pages describe real capital; newer homepage legal disclosures describe
  virtual participant accounts and discretionary use of signals. Do not equate a funded label
  with a guaranteed externally routed trade.

## Source retrieval limitations and next evidence

Reviewed official docs above and searched for current staff statements on funded limits,
copier and API access. No exact direct staff posts supporting those claims were retrieved.
[Current prop terms](https://next.vestmarkets.com/prop-terms-of-service) yielded no readable
body; the [classic path](https://trade.vestmarkets.com/prop-terms-of-service) and
[fee page](https://docs.vestmarkets.com/trading/fees-and-rates/fees) were inaccessible
to retrieval. These failures mean unknown, not permission or prohibition.

Before any live adapter: obtain current Instant terms, official account/market metadata,
permitted execution documentation, fees, funded authentication, copier/hedging rules,
rate limits, and server-side protection/retry behavior. Recheck all dated findings.
