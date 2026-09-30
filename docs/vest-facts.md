# Vest facts and integration gate

Research date: **2026-09-29** (America/Los_Angeles). Public documentation only;
no authenticated Vest calls, account-token requests, private endpoint probes, or trades.
Update on the same date: current public FAQ and terms were read in Work Browser; the
browser was signed out. This replaces the earlier retrieval limitations where noted.
This is an evidence register, not a statement that older evaluation rules govern Instant accounts.
Publication dates are unknown unless stated below; all sources were checked on the research date.

## CONFIRMED

### Current funded UI documentation — browser-verified 2026-09-29

Source: [current official FAQ](https://next.vestmarkets.com/faq), expanded question
headings below; publication date not shown. Browser-visible evidence, not search excerpts.

| Finding                                                                              | FAQ question / scope                                                                                                          |
| ------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| API trading is unavailable in Evaluation.                                            | Is API trading supported on Funded Accounts?                                                                                  |
| API trading is unavailable on Live Funded accounts.                                  | Same answer.                                                                                                                  |
| API trading is unavailable on Instant accounts.                                      | Explicitly included in the same answer. No funded API adapter is planned.                                                     |
| Up to ten funded accounts may be active; Instant accounts count.                     | How many Live Funded Accounts can I have at once? Evaluation accounts are described as uncapped.                              |
| Opposite-side same-market positions across funded accounts are a prohibited example. | Are any trading strategies prohibited? General strategy permission does not establish browser automation permission.          |
| Post-fill SL/TP management is described on position rows.                            | How do I set or adjust a stop loss or take profit on an open position? This is not verification of reduce-only/OCO semantics. |
| Portfolio/market views provide open-order management.                                | How do I manage open orders? Exact funded controls have not been inspected.                                                   |

The [prop terms](https://next.vestmarkets.com/prop-terms-of-service), visibly updated
2026-09-28, section 2 contain a single-Account restriction. The definition's relationship
to the FAQ's ten funded accounts needs written clarification. Do not assume it overrides
or exempts funded subaccounts. Section 5 prohibits manipulation/abusive coordination;
it does not explicitly approve this browser workflow. The
[general Site terms](https://next.vestmarkets.com/terms-of-service), visibly updated
2026-03-06, describe the standard exchange with a different jurisdiction scope.
Confirm which agreement applies rather than substituting the exchange for Capital.

| Finding                                                                                                                                                                                                                  | Scope and source                                                                                                                                                           |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Vest offers perpetual derivatives across asset categories.                                                                                                                                                               | [About Vest](https://docs.vestmarkets.com/welcome/about-vest-markets). Do not use CME NQ contract multipliers.                                                             |
| Published Silver/Gold/Platinum rules use fixed floors derived from starting balance; touching the floor closes an account.                                                                                               | [Risk rules](https://docs.vestmarkets.com/vest-capital/risk-rules). Their listed floors are $4,700/$9,400/$23,500. This does not verify the $500 Instant tier.             |
| Those rules also describe a daily loss limit, based on 4% of balance plus 50% of positive unrealized profit at the daily snapshot.                                                                                       | [Risk rules](https://docs.vestmarkets.com/vest-capital/risk-rules). Both limits apply; Instant applicability and exact daily baseline remain unresolved.                   |
| Evaluation and funded accounts are separate; passing closes the evaluation and creates a same-size funded account.                                                                                                       | [Funded accounts](https://docs.vestmarkets.com/vest-capital/funded-accounts).                                                                                              |
| General funded withdrawal docs describe on-demand requests, normally 24-hour processing, transfer to the primary account, and a 90% split.                                                                               | [Withdrawals](https://docs.vestmarkets.com/vest-capital/withdrawals). Not verified for Instant 95% plans.                                                                  |
| Capital FAQ documents leverage up to 50x.                                                                                                                                                                                | [FAQ](https://docs.vestmarkets.com/vest-capital/faq-and-refunds). Product/market restrictions still require confirmation.                                                  |
| A standard exchange v2 API is documented, with production/development URLs, delegated signing, primary address, registration API key, and account-group header. Its stated API transaction fee is 1 basis point (0.01%). | [Vest API](https://docs.vestmarkets.com/vest-api). The current FAQ explicitly excludes funded/Instant API use.                                                             |
| General funding docs describe continuous settlement and an 8-hour displayed average.                                                                                                                                     | [Funding](https://docs.vestmarkets.com/trading/fees-and-rates/funding-rate). Instant-specific settlement and rate treatment remain unresolved.                             |
| Non-crypto weekend opening restrictions are published, including NQ.                                                                                                                                                     | [Exchange notices](https://docs.vestmarkets.com/exchange-notices), notice dated 2026-07-29, effective 2026-07-31. Exact timezone/DST interpretation requires confirmation. |
| The homepage recognizes Instant accounts and discloses that their balances/results are virtual, with nonbinding trade ideas; external routing is discretionary.                                                          | [Homepage disclosures](https://www.vestmarkets.com/). Application terminology must not imply a participant-owned live brokerage account.                                   |

## LIKELY

| Finding                                                                               | Evidence and limitation                                                                                                                                                                            |
| ------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The user's $500 Instant accounts have a fixed $490 floor; profits enlarge the buffer. | User observations supplied 2026-09-29: $500/$10 buffer and $504.55/$14.55 buffer. Consistent with general fixed-floor documentation, but no official Instant rule located. Simulator fixture only. |
| Ten funded accounts are operationally available to this user.                         | User reports owning ten on 2026-09-29; the personal fleet has not been inspected. The public FAQ limit and agreement-scope question are recorded above.                                            |

## UNVERIFIED

| Question                                                                              | Current evidence / required resolution                                                                                                                                            |
| ------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Native copier status and availability                                                 | Prior report only; no authoritative release or supported integration contract found.                                                                                              |
| Browser automation and same-direction cross-account copy permissions                  | Obtain explicit permissions covering this exact account product and owner fleet. Public exchange API documentation alone is insufficient.                                         |
| NQ UI to NDX-USD-PERP mapping, tick size, size step, minimum size, multiplier, margin | Naming convention is documented, exact mapping is not. `NDX` will be a simulation-only domain symbol.                                                                             |
| Instant drawdown, fixed vs trailing, equity basis and equality boundary               | $490 is a user-observed fixture. Confirm fees, funding, unrealized P&L and withdrawals in the failure calculation.                                                                |
| Instant daily loss rule, reset clock and daylight saving behavior                     | Do not import evaluation daily-loss rules into Instant automatically.                                                                                                             |
| Instant payout split, minimums, caps, profit debit vs net payout, floor after payout  | User observed 95%; current public sources conflict by product.                                                                                                                    |
| NQ execution fee of 0.0025% each side                                                 | User observed one trade. General API docs say 0.01% per transaction, which may be a different execution path. No permanent fee default justified.                                 |
| Full fee schedule and funding                                                         | Fee page could not be retrieved; verify applicable market, session, account and execution channel. Funding changes with market/time.                                              |
| Instant leverage options and margin/liquidation rules                                 | User UI offered 10/20/30/40/50x. Exact limits and liquidation buffer not verified.                                                                                                |
| Other termination conditions and correlated-market hedging                            | Same-market opposite exposure is now explicitly addressed by the FAQ. Correlated-market scope and complete Instant agreement applicability remain unresolved. Preserve the guard. |

Capital-backend speculation is outside the browser investigation.
Research-only endpoint strings supplied by the user: `GET /v3/capital/limits`,
`GET /v3/capital/accounts`, `POST /v3/auth/account-token`, `/v3/positions/open`,
and `max_funded`. These were not called and are not implementation contracts.

## OUTDATED / CONTRADICTED

- Earlier uncertainty about funded API availability is superseded by the current FAQ:
  API execution is unavailable for Evaluation, Live Funded and Instant accounts. Claims
  of a forthcoming release are not a delivery commitment or implementation basis.
- Earlier uncertainty about the ten-funded-account FAQ and explicit opposite-side hedge
  prohibition is superseded by the browser-visible answers above. Agreement/account
  scope still needs clarification; disabled-account exclusion is our project rule only.

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

## Browser execution UNVERIFIED blockers

- Browser automation permission for the user’s Instant fleet.
- Native copier availability and a supported integration contract.
- Concurrent funded browser sessions and any session-count restriction.
- Per-tab account-context isolation and cross-tab account-selection effects.
- Safest multi-account UI workflow and exact account identity controls.
- Visible fill/order correlation, full precision, reduce-only/OCO guarantees and terminal partial fills.

See [browser investigation and architecture](browser-execution.md) for the read-only
inspection matrix, original fixture implementation and supervised-testing gates.

## Source retrieval limitations and next evidence

Earlier research could not retrieve the prop terms. The current public FAQ, prop terms
and Site terms were subsequently rendered and read in Work Browser on 2026-09-29;
that earlier access limitation no longer applies to those pages. Web-search retrieval
still failed, and no authenticated account session was available. Missing automation
permission remains a blocker, not implied approval. Obtain dated written permission,
resolve account/contract scope and complete read-only funded UI inspection before
considering an execution implementation. No Capital endpoint is an implementation source.

## Hedge-policy requirement update — 2026-09-29

**CONFIRMED update:** the current official FAQ now explicitly gives opposite-side
same-market funded positions as prohibited coordination. Browser-read 2026-09-29,
under “Are any trading strategies prohibited?” This supersedes the prior unverified
staff report. Same-owner copying permission and correlated-symbol scope remain unresolved.

**Confirmed project instruction, not a Vest factual claim:** user instruction dated
2026-09-29 requires `CROSS_ACCOUNT_HEDGE_GUARD = ENABLED`. Enabled funded accounts may
share the same market direction or be flat, but new opposing same-market entries must
be rejected. Disabled accounts are ignored by this guard per the user's explicit scope;
unselected enabled accounts still count. This is not evidence that Vest exempts disabled
accounts, or that same-direction copying/automation is currently authorized.

Same-direction copying and opposite-direction hedging are distinct behaviors. NQ/NDX
local aliases share one guard identity; the destination market mapping remains unverified. Economically
related markets such as NQ and SPX may raise a separate correlated-hedging issue, but its
scope is **UNVERIFIED**. No automatic correlated-market blocking is enabled. The risk
engine provides an additive rule extension point for a later verified policy.
