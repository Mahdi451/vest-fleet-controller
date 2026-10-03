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
`Take Profit $`, and `Stop Loss $` on Account 01's BTC ticket. It did not record a
position-row layout or the flatten control. Until those are read from a live row, a
position panel that is not an explicit row stays unparsed and fails closed, and
flatten clicks only a single visible `Close` button in Active Positions. Absence of
the "market is closed" phrase, together with one Buy/Long button, is the recorded
signal that the market was open. Two windows on the same login were observed to adopt
each other's selected account after reload, so this primitive halts when more than one
trading page is open instead of trying to keep them apart.
