# Original provider evidence contract

This is an independently designed **synthetic contract**, not a connected Vest adapter. It introduces no browser navigation, authentication access, network requests, venue URLs, routes, selectors, or external source code. `createConnectedProvider()` always refuses with `CONNECTED_PROVIDER_EVIDENCE_REQUIRED`.

## What is checked offline

`packages/browser-execution/src/bridge/provider-evidence.ts` accepts only strict `SYNTHETIC` / `OFFLINE_FIXTURE` records. Unknown fields and other environments are refused.

- A complete inventory must contain exactly the expected account IDs, with no duplicate, missing, or extra accounts. Every account must have a distinct, READY context correlated to the expected account ID, context ID, and generation.
- Inventory, identity proofs, account books, quotes, and economics must be fresh. Future capture timestamps are refused. Stale or uncertain contexts cannot establish readiness.
- Quantity and price units, currency, tick and quantity steps, minimum/maximum quantity, leverage limits, entry/exit fees, costs, slippage and funding assumptions, drawdown model, and protection semantics are explicit. Unknown units or missing metadata are refused. The declared economics are fixture facts; they are not statements about Vest.
- Entry evidence correlates account, context generation, request ID, symbol, and requested quantity. Filled quantity, fill price, terminal state, and remaining execution evidence must agree. An open or unknown partial remainder stays nonterminal. Only explicit cancellation with zero executable remainder sets `remainderCanceled`.
- Only bounded error codes pass normalization. Arbitrary provider error text is refused.
- Bootstrap snapshots establish a source cursor and return normalized inventory. Existing positions never manufacture entry events. Only the separate accepted-event envelope can enter the durable journal.
- Provider events require stable event IDs, the bound leader account/context/source/symbol, and a valid capture time. Existing journal behavior handles duplicates, sequence gaps, reordered arrival, pre-baseline refusal, and changed facts under an existing identity. A sequence gap is retained as `contiguous: false`, so the execution coordinator must refuse dispatch until its journal admission conditions are satisfied.

The normalized capability contract exposes named operations: account, position and order reads; entry, stop and target submission; cancellation; reduction; and flattening. It supplies no arbitrary route, URL, credential, or network method. This TypeScript interface is a design boundary, not proof that a connected implementation is safe. A future implementation must validate operation inputs and outputs and enforce its own network allowlist.

The intake does not dispatch trades or infer venue events from account state. It does not add retry, synchronization, or reopening behavior. Refusal errors are fixed codes; a connected integration must map account/context and channel integrity failures to the controller's existing global stop policy.

## Evidence still required before a connected adapter exists

These are current missing proofs, not supported production capabilities:

1. The actual Vest-owned transports and exact necessary trading/read operations, reviewed against the approved domain and endpoint lists.
2. Authenticated, stable provider account identifiers and independent account-bound contexts, including how identity and generation change on login loss, navigation, or reconnect.
3. A verified provider market mapping and actual quantity, price, fee, leverage, drawdown, tick, size, and protection semantics. The fixture's NDX and USD-per-point convention must not be assumed to match a Vest contract.
4. A genuine accepted leader event feed with stable provider identities, a baseline/resume cursor, ordering and gap behavior. Position snapshots alone are insufficient.
5. Provider-supported entry correlation and acknowledgement, fill, rejection, cancellation, and executable-remainder evidence. A partial fill needs proof that no additional fill can occur before it is treated as terminal.
6. Observed reduce-only stop/target and close/reduction behavior, including independent reconciliation after an uncertain response.
7. Measured authenticated provider latency and failure behavior. Fixture timing is not a venue latency measurement.

Obtaining those facts requires separately authorized authenticated testing within the user's browser constraints. This contract does not satisfy the connected-execution or funded-account gates.

## Validation

`pnpm exec vitest run tests/provider-evidence.test.ts` exercises inventory membership, context/generation binding, freshness, missing and unknown metadata, exact order correlation, partial remainder semantics, snapshot-only bootstrap, accepted event admission, replay, gaps, reordering and identity corruption. It makes no provider requests.
