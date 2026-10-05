# Single-account Vest execution

`executeOneAccount()` in `packages/browser-execution/src/single-account.ts` is the
browser primitive for one funded account. Fleet sequencing, dashboard controls, and
Accounts 02–10 are not this module's job.

The orchestration branch should call:

```ts
executeOneAccount(page, request, intentLog, { now, maxHeaderAgeMs });
```

`page` is a `VestExecutionPage`. `vestExecutionPage()` adapts one Playwright page.
`request.action` is `LONG`, `SHORT`, or `FLATTEN`.

The result `state` is one of `FLAT`, `ENTRY_UNKNOWN`, `OPEN_UNPROTECTED`,
`OPEN_PROTECTED`, `CONFIRMED_FLAT`, or `HALTED`. `haltFleet: true` means the caller
must not continue to another account. `OPEN_UNPROTECTED` with `MISSING_STOP` is that
halt. `code` is the machine-readable reason. `entrySubmissions` is how many Buy/Sell
clicks this call made; a replay of the same intent id makes none.

## What is read, not remembered

Account comes from the banner button whose name matches `Account N`. A switch counts
only after that button is read again and matches. Leverage is taken from the open
leverage menu on that account, then read back from the selected `Nx` button.
Allocation counts only when the percent field matches, and the order is refused when
`Order Value` is missing or above `maxOrderValue`. The entry click happens once, after
a second read of account, symbol, leverage, percent, order value, and the button.
Stop and target are offsets from the position's average entry, then read back from the
working exits.

## Not yet proven on the live page

Inspection on 2026-10-03 recorded the account banner, `Buy/Long`, `Sell/Short`, the
`Nx` leverage menu, `25%` `50%` `75%` `100%`, `Order Value $…`, `Amount USD`,
`Take Profit $`, and `Stop Loss $` on Account 01's BTC ticket. A later read of that
same profile on `/trade/BTC-PERP` showed Account 01, the heading "No positions yet",
and column headers Market, Value, Open Price, Mid Price, PnL, Fail Price, TP/SL,
Funding, and Fee. The table had no body row and no action button. A position panel
that is not that empty heading stays unparsed, and flatten does not click a page-level
`Close` button. Absence of the "market is closed" phrase, together with one Buy/Long
button, is the recorded signal that the market was open. Two windows on the same login
were observed to adopt each other's selected account after reload, so this primitive
halts when more than one trading page is open instead of trying to keep them apart.
