import { createHash } from 'node:crypto';
import {
  D,
  intentSchema,
  riskConfigSchema,
  isFresh,
  accountSchema,
  protectionOrderSchema,
  type ExecutionState,
  type ProtectionRequest,
  type Account,
  type TradeIntent,
  type RiskConfig,
  type Quote,
} from '../../core/src/index.ts';
import {
  sizeTrade,
  protectionPrices,
  type RiskPreview,
} from '../../risk-engine/src/index.ts';
import {
  evaluateFleetExposure,
  type ExposureViolation,
} from '../../risk-engine/src/exposure.ts';
import type { ExecutionAdapter, ChildResult } from './adapter.ts';
import { Journal } from './journal.ts';
import { validateResult } from './adapter.ts';

const hash = (value: unknown) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');
export interface FleetPreview {
  previewId: string;
  createdAt: number;
  intent: TradeIntent;
  quote: Quote;
  accounts: Account[];
  orders: RiskPreview[];
  exposureViolations: ExposureViolation[];
}
export class FleetController {
  private previews = new Map<string, FleetPreview>();
  private busy = false;
  private circuitOpen: boolean;
  private config: RiskConfig;
  constructor(
    private readonly adapter: ExecutionAdapter,
    config: RiskConfig,
    private readonly journal: Journal,
    private readonly clock: () => number = Date.now,
    private readonly timeoutMs = 1000,
  ) {
    if (adapter.mode !== 'SIMULATION')
      throw new Error('LIVE_EXECUTION_DISABLED');
    if (!Number.isInteger(timeoutMs) || timeoutMs <= 0)
      throw new Error('INVALID_TIMEOUT');
    this.config = riskConfigSchema.parse(config);
    this.circuitOpen = journal.halted();
  }
  private halt() {
    this.circuitOpen = true;
    this.journal.halt();
  }
  requestHalt() {
    this.halt();
  }
  private async deadline<T>(promise: Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        promise,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error('TIMEOUT')),
            this.timeoutMs,
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
  private transition(
    masterTradeId: string,
    result: ChildResult,
    state: ExecutionState,
  ) {
    result.state = state;
    this.journal.child(masterTradeId, result);
    this.journal.log({
      timestamp: this.clock(),
      masterTradeId,
      accountId: result.accountId,
      requestId: result.requestId,
      filledSize: result.filledSize,
      entryPrice: result.entryPrice,
      status: state,
      adapter: this.adapter.name,
      ...(result.stopPrice ? { stop: result.stopPrice } : {}),
      ...(result.targetPrice ? { target: result.targetPrice } : {}),
    });
  }
  private protectionMatches(
    order: ReturnType<typeof protectionOrderSchema.parse>,
    request: ProtectionRequest,
  ) {
    return (
      order.orderId === request.requestId &&
      order.requestId === request.requestId &&
      order.masterTradeId === request.masterTradeId &&
      order.accountId === request.accountId &&
      order.entryRequestId === request.entryRequestId &&
      order.symbol === request.symbol &&
      order.positionSide === request.positionSide &&
      order.type === request.type &&
      order.reduceOnly === true &&
      order.status === 'ACTIVE' &&
      new D(order.filledSize).isZero() &&
      new D(order.quantity).eq(request.quantity) &&
      new D(order.triggerPrice).eq(request.triggerPrice)
    );
  }
  private async verifyProtection(request: ProtectionRequest) {
    const order = protectionOrderSchema.parse(
      await this.deadline(
        this.adapter.getProtectionOrder(request.accountId, request.requestId),
      ),
    );
    if (!this.protectionMatches(order, request))
      throw new Error('PROTECTION_UNCONFIRMED');
  }
  private async cleanupAccount(accountId: string): Promise<'FLAT' | 'UNKNOWN'> {
    let status: 'FLAT' | 'UNKNOWN' = 'UNKNOWN';
    try {
      await this.deadline(this.adapter.flattenAccount(accountId));
      const after = accountSchema.parse(
        await this.deadline(this.adapter.getAccountState(accountId)),
      );
      const open = await this.deadline(this.adapter.getOpenOrders(accountId));
      if (
        after.accountId === accountId &&
        !after.positions.length &&
        !open.length &&
        after.executionStatus !== 'UNKNOWN'
      )
        status = 'FLAT';
    } catch {
      /* Preserve uncertainty; flatten failure never becomes success. */
    }
    try {
      this.journal.log({
        timestamp: this.clock(),
        masterTradeId: 'UNSAFE_ENTRY_CLEANUP',
        accountId,
        status: `CLEANUP_${status}`,
        adapter: this.adapter.name,
      });
    } catch {
      /* The caller will surface journal failure. */
    }
    return status;
  }
  async preview(
    input: TradeIntent,
    selected?: string[],
  ): Promise<FleetPreview> {
    const intent = intentSchema.parse(input);
    const accounts = await this.deadline(this.adapter.listAccounts());
    const ids = selected ?? accounts.map((a) => a.accountId);
    if (
      ids.length === 0 ||
      new Set(ids).size !== ids.length ||
      ids.some((id) => !accounts.some((a) => a.accountId === id))
    )
      throw new Error('INVALID_ACCOUNT_SELECTION');
    const quote = await this.deadline(this.adapter.getQuote());
    const included = accounts.filter((a) => ids.includes(a.accountId));
    const createdAt = this.clock();
    const exposureViolations = evaluateFleetExposure(intent, accounts);
    const orders = included.map((a) => {
      const r = sizeTrade(a, intent, quote, this.config, createdAt);
      if (exposureViolations.length) {
        r.approved = false;
        r.reasons.push(...new Set(exposureViolations.map((v) => v.code)));
      }
      return r;
    });
    const body = {
      createdAt,
      intent,
      quote,
      accounts: included,
      orders,
      exposureViolations,
    };
    const preview = { previewId: hash(body), ...body };
    for (const [id, old] of this.previews) {
      if (!isFresh(old.createdAt, createdAt, this.config.maxPreviewAgeMs))
        this.previews.delete(id);
    }
    this.previews.set(preview.previewId, structuredClone(preview));
    this.journal.log({
      timestamp: createdAt,
      masterTradeId: preview.previewId,
      status: 'PREVIEWED',
      adapter: this.adapter.name,
    });
    return preview;
  }
  async execute(
    masterTradeId: string,
    previewId: string,
  ): Promise<ChildResult[]> {
    if (!/^[a-zA-Z0-9_-]{1,100}$/.test(masterTradeId))
      throw new Error('INVALID_TRADE_ID');
    if (this.busy) throw new Error('CONTROLLER_BUSY');
    // A retry of an existing master ID never dispatches, even after restart.
    const preview = this.previews.get(previewId);
    if (!preview) {
      return this.journal.replay(masterTradeId, previewId);
    }
    const claim = this.journal.claim(masterTradeId, previewId);
    if (!claim.fresh) return this.journal.replay(masterTradeId, previewId);
    this.busy = true;
    const results: ChildResult[] = [];
    let stopped = this.circuitOpen;
    try {
      for (const [index, planned] of preview.orders.entries()) {
        const start = this.clock();
        const requestId = hash([masterTradeId, planned.accountId]);
        const result: ChildResult = {
          requestId,
          accountId: planned.accountId,
          status: 'REJECTED',
          filledSize: '0',
          entryPrice: null,
          fees: '0',
          error: null,
          state: 'REJECTED',
          protectionOrderIds: [],
        };
        let actual = planned;
        if (
          stopped ||
          this.circuitOpen ||
          !planned.approved ||
          !isFresh(preview.createdAt, start, this.config.maxPreviewAgeMs)
        ) {
          result.error =
            stopped || this.circuitOpen
              ? 'CIRCUIT_OPEN'
              : !planned.approved
                ? planned.reasons.includes('CROSS_ACCOUNT_HEDGE_GUARD')
                  ? 'CROSS_ACCOUNT_HEDGE_GUARD'
                  : 'PREVIEW_REJECTED'
                : 'PREVIEW_EXPIRED';
        } else {
          let submitted = false;
          let entryConfirmed = false;
          try {
            const state = await this.deadline(
              this.adapter.getAccountState(planned.accountId),
            );
            const quote = await this.deadline(this.adapter.getQuote());
            const fleet = await this.deadline(this.adapter.listAccounts());
            const before = preview.accounts[index];
            actual = sizeTrade(
              state,
              preview.intent,
              quote,
              this.config,
              this.clock(),
            );
            const mismatch =
              !before ||
              state.revision !== before.revision ||
              state.balance !== before.balance ||
              state.equity !== before.equity ||
              state.drawdown.floor !== before.drawdown.floor;
            const exposureViolations = evaluateFleetExposure(
              preview.intent,
              fleet,
            );
            if (
              this.circuitOpen ||
              mismatch ||
              exposureViolations.length > 0 ||
              !actual.approved ||
              !isFresh(
                preview.createdAt,
                this.clock(),
                this.config.maxPreviewAgeMs,
              ) ||
              new D(quote.price)
                .minus(preview.quote.price)
                .abs()
                .gt(this.config.maxPriceMovePoints) ||
              new D(actual.quantity).gt(planned.quantity)
            ) {
              result.error =
                exposureViolations[0]?.code ?? 'PRETRADE_REVALIDATION_FAILED';
            } else {
              result.status = 'UNKNOWN';
              result.error = null;
              this.transition(masterTradeId, result, 'ENTRY_SUBMITTING'); // Durable BEFORE entry side effect.
              submitted = true;
              try {
                // An entry acknowledgement alone can never establish a protected trade.
                validateResult(
                  await this.deadline(
                    this.adapter.placeOrder({
                      requestId,
                      masterTradeId,
                      accountId: state.accountId,
                      intent: preview.intent,
                      preview: actual,
                      quote,
                      config: this.config,
                    }),
                  ),
                  requestId,
                  state.accountId,
                );
              } catch {
                /* Attempt authoritative lookup; never resend a market entry. */
              }
              const rawLedger = await this.deadline(
                this.adapter.getOrder(requestId),
              );
              const ledger = rawLedger
                ? validateResult(rawLedger, requestId, state.accountId)
                : null;
              const after = accountSchema.parse(
                await this.deadline(
                  this.adapter.getAccountState(state.accountId),
                ),
              );
              const position = after.positions.find(
                (p) => p.entryRequestId === requestId,
              );
              if (
                ledger?.status === 'REJECTED' &&
                after.accountId === state.accountId &&
                after.positions.length === 0
              ) {
                Object.assign(result, ledger);
                result.state = 'REJECTED';
              } else {
                if (ledger?.status === 'FILLED')
                  Object.assign(result, ledger, { status: 'UNKNOWN' });
                if (
                  !ledger ||
                  ledger.status !== 'FILLED' ||
                  !ledger.entryPrice ||
                  after.accountId !== state.accountId ||
                  !position ||
                  after.positions.length !== 1 ||
                  position.symbol !== preview.intent.symbol ||
                  position.side !== preview.intent.side ||
                  !new D(position.quantity).eq(actual.quantity) ||
                  !new D(ledger.filledSize).eq(actual.quantity) ||
                  !new D(ledger.entryPrice).eq(position.entryPrice) ||
                  !new D(position.leverage).eq(preview.intent.leverage) ||
                  after.status !== 'ACTIVE'
                )
                  throw new Error('ENTRY_RECONCILIATION_FAILED');
                entryConfirmed = true;
                this.transition(
                  masterTradeId,
                  result,
                  'ENTRY_FILLED_UNPROTECTED',
                );
                // Preserve the preview's cost envelope; unexpected fill/fee overruns fail closed.
                if (
                  new D(position.entryPrice)
                    .minus(quote.price)
                    .abs()
                    .gt(this.config.slippagePointsPerSide) ||
                  new D(ledger.fees).gt(
                    new D(actual.entryFee).plus(actual.accountCost),
                  ) ||
                  !new D(after.balance).eq(
                    new D(state.balance).minus(ledger.fees),
                  )
                )
                  throw new Error('FILL_RISK_CHANGED');
                const prices = protectionPrices(
                  position.entryPrice,
                  preview.intent,
                );
                result.stopPrice = prices.stopPrice;
                result.targetPrice = prices.targetPrice;
                const requests: ProtectionRequest[] = (
                  ['STOP_LOSS', 'TAKE_PROFIT'] as const
                ).map((type) => ({
                  requestId: hash([requestId, type]),
                  masterTradeId,
                  accountId: state.accountId,
                  entryRequestId: requestId,
                  symbol: preview.intent.symbol,
                  positionSide: preview.intent.side,
                  quantity: actual.quantity,
                  type,
                  triggerPrice:
                    type === 'STOP_LOSS'
                      ? prices.stopPrice
                      : prices.targetPrice,
                  reduceOnly: true,
                }));
                for (const request of requests) {
                  if (this.circuitOpen)
                    throw new Error('HALTED_DURING_PROTECTION');
                  result.protectionOrderIds.push(request.requestId);
                  this.transition(
                    masterTradeId,
                    result,
                    'PROTECTION_SUBMITTING',
                  );
                  this.journal.log({
                    timestamp: this.clock(),
                    masterTradeId,
                    accountId: request.accountId,
                    requestId: request.requestId,
                    entryRequestId: requestId,
                    orderId: request.requestId,
                    protectionType: request.type,
                    triggerPrice: request.triggerPrice,
                    reduceOnly: true,
                    requestedSize: request.quantity,
                    status: 'PROTECTION_SUBMITTING',
                    adapter: this.adapter.name,
                  });
                  try {
                    await this.deadline(
                      this.adapter.placeProtectionOrder(request),
                    );
                  } catch {
                    /* A lost response is resolved only by authoritative exact-ID lookup. */
                  }
                  await this.verifyProtection(request);
                }
                // Re-read both protections, the entry ledger, and the position after both submissions.
                for (const request of requests)
                  await this.verifyProtection(request);
                const open = (
                  await this.deadline(
                    this.adapter.getOpenOrders(state.accountId),
                  )
                ).map((o) => protectionOrderSchema.parse(o));
                if (
                  open.length !== 2 ||
                  !requests.every((r) =>
                    open.some((o) => this.protectionMatches(o, r)),
                  )
                )
                  throw new Error('PROTECTION_BOOK_MISMATCH');
                const currentLedger = await this.deadline(
                  this.adapter.getOrder(requestId),
                );
                const confirmedLedger = currentLedger
                  ? validateResult(currentLedger, requestId, state.accountId)
                  : null;
                const finalState = accountSchema.parse(
                  await this.deadline(
                    this.adapter.getAccountState(state.accountId),
                  ),
                );
                const finalPosition = finalState.positions[0];
                if (
                  this.circuitOpen ||
                  !confirmedLedger ||
                  confirmedLedger.status !== 'FILLED' ||
                  !new D(confirmedLedger.filledSize).eq(actual.quantity) ||
                  confirmedLedger.entryPrice !== ledger.entryPrice ||
                  finalState.accountId !== state.accountId ||
                  finalState.status !== 'ACTIVE' ||
                  finalState.positions.length !== 1 ||
                  !finalPosition ||
                  finalPosition.entryRequestId !== requestId ||
                  finalPosition.symbol !== preview.intent.symbol ||
                  finalPosition.side !== preview.intent.side ||
                  !new D(finalPosition.quantity).eq(actual.quantity) ||
                  !new D(finalPosition.leverage).eq(preview.intent.leverage) ||
                  finalPosition.entryPrice !== position.entryPrice ||
                  finalPosition.protectionStatus !== 'ACTIVE'
                )
                  throw new Error('PROTECTION_RECONCILIATION_FAILED');
                result.status = 'FILLED';
                result.error = null;
                this.transition(masterTradeId, result, 'PROTECTED');
              }
            }
          } catch {
            result.status = submitted ? 'UNKNOWN' : 'REJECTED';
            result.state = submitted ? 'UNKNOWN' : 'REJECTED';
            result.error = submitted
              ? entryConfirmed
                ? 'PROTECTION_UNCONFIRMED'
                : 'EXECUTION_UNCERTAIN'
              : 'ACCOUNT_READ_FAILED';
            if (submitted) {
              // Halt and reduce exposure even if journaling has failed. Do not hide uncertainty after cleanup.
              this.circuitOpen = true;
              try {
                this.journal.halt();
              } catch {
                /* Cleanup must still run. */
              }
              result.cleanupStatus = await this.cleanupAccount(
                planned.accountId,
              );
            }
          }
        }
        if (result.error === 'CIRCUIT_OPEN') result.state = 'HALTED';
        this.journal.child(masterTradeId, result);
        this.journal.log({
          timestamp: this.clock(),
          masterTradeId,
          accountId: planned.accountId,
          requestId,
          symbol: preview.intent.symbol,
          direction: preview.intent.side,
          requestedSize: actual.quantity,
          filledSize: result.filledSize,
          entryPrice: result.entryPrice,
          ...(result.stopPrice ? { stop: result.stopPrice } : {}),
          ...(result.targetPrice ? { target: result.targetPrice } : {}),
          fees: result.fees,
          status: result.state,
          error: result.error,
          adapter: this.adapter.name,
          latency: this.clock() - start,
        });
        results.push(result);
        // Disabled/pre-rejected accounts are intentionally skipped. Execution failures halt remaining dispatch.
        if (planned.approved && result.status !== 'FILLED') {
          stopped = true;
          this.halt();
        }
      }
      this.journal.finish(masterTradeId, results);
      return results;
    } catch {
      this.halt();
      throw new Error('JOURNAL_OR_CONTROLLER_FAILURE');
    } finally {
      this.busy = false;
    }
  }
  async flattenAll(): Promise<
    Array<{ accountId: string; status: 'FLAT' | 'UNKNOWN' }>
  > {
    this.halt(); // Entries remain blocked even if flattening fails.
    if (this.busy) throw new Error('EXECUTION_IN_PROGRESS_RETRY_FLATTEN');
    this.busy = true;
    try {
      const accounts = await this.deadline(this.adapter.listAccounts());
      const results: Array<{ accountId: string; status: 'FLAT' | 'UNKNOWN' }> =
        [];
      for (const a of accounts) {
        let status: 'FLAT' | 'UNKNOWN' = 'UNKNOWN';
        try {
          await this.deadline(this.adapter.flattenAccount(a.accountId));
          const after = await this.deadline(
            this.adapter.getAccountState(a.accountId),
          );
          const open = await this.deadline(
            this.adapter.getOpenOrders(a.accountId),
          );
          // Unresolved submissions may still fill; an empty position snapshot cannot prove finality.
          if (
            after.accountId === a.accountId &&
            after.positions.length === 0 &&
            open.length === 0 &&
            after.executionStatus !== 'UNKNOWN' &&
            !this.journal.unresolvedAccount(a.accountId)
          )
            status = 'FLAT';
        } catch {
          /* Preserve uncertainty and attempt remaining accounts. */
        }
        results.push({ accountId: a.accountId, status });
        this.journal.log({
          timestamp: this.clock(),
          masterTradeId: 'EMERGENCY_FLATTEN',
          accountId: a.accountId,
          status,
          adapter: this.adapter.name,
        });
      }
      return results;
    } finally {
      this.busy = false;
    }
  }
}
