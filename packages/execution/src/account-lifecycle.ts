import { createHash } from 'node:crypto';
import {
  D,
  isFresh,
  accountSchema,
  protectionOrderSchema,
  type RiskConfig,
  type ProtectionRequest,
  type ExecutionState,
} from '../../core/src/index.ts';
import {
  sizeTrade,
  assessFilledRisk,
  protectionPrices,
  type RiskPreview,
} from '../../risk-engine/src/index.ts';
import { evaluateFleetExposure } from '../../risk-engine/src/exposure.ts';
import {
  validateResult,
  type ExecutionAdapter,
  type ChildResult,
  type OrderRequest,
} from './adapter.ts';
import type { Journal, RevalidationDiagnostic } from './journal.ts';
import type { FleetPreview } from './controller.ts';
import type { OfflineDispatchAuthorizer } from './offline-authority.ts';
const hash = (value: unknown) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');
export interface AccountExecutionContext {
  adapter: ExecutionAdapter;
  config: RiskConfig;
  journal: Pick<Journal, 'child' | 'log'>;
  clock(): number;
  deadline<T>(promise: Promise<T>): Promise<T>;
  readonly circuitOpen: boolean;
  readonly protectionBlocked: boolean;
  dispatchAuthority?: OfflineDispatchAuthorizer | undefined;
  metrics: {
    entries: number;
    partialFills: number;
    protectionFailures: number;
    lastFillLatencyMs: number;
    lastProtectionLatencyMs: number;
  };
  transition(
    masterTradeId: string,
    result: ChildResult,
    state: ExecutionState,
  ): void;
  verifyProtection(request: ProtectionRequest): Promise<void>;
  protectionMatches(
    order: ReturnType<typeof protectionOrderSchema.parse>,
    request: ProtectionRequest,
  ): boolean;
  onUnsafeEntry(accountId: string): Promise<'FLAT' | 'UNKNOWN'>;
  beforeSubmit?(request: OrderRequest): void;
  onFailure?(error: unknown): void;
}
export function protectionMatches(
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

/** Shared account lifecycle. Fleet scheduling and failure scope belong to its owner. */
export async function executeAccount(
  this: AccountExecutionContext,
  masterTradeId: string,
  preview: FleetPreview,
  planned: RiskPreview,
  index: number,
  executionStarted: number,
  stopped: boolean,
  suppliedRequestId?: string,
): Promise<ChildResult> {
  const start = this.clock();
  const childStarted = performance.now();
  let revalidation: RevalidationDiagnostic | undefined;
  const requestId =
    suppliedRequestId ?? hash([masterTradeId, planned.accountId]);
  const result: ChildResult = {
    requestId,
    accountId: planned.accountId,
    status: 'REJECTED',
    filledSize: '0',
    entryPrice: null,
    fees: '0',
    error: null,
    state: 'REJECTED',
    intent: preview.intent,
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
    let entryStarted = 0;
    let protectionStarted = 0;
    try {
      const validationStarted = performance.now();
      const state = await this.deadline(
        this.adapter.getAccountState(planned.accountId),
      );
      const quote = await this.deadline(this.adapter.getQuote());
      const fleet = await this.deadline(this.adapter.listAccounts());
      if (
        this.dispatchAuthority &&
        (state.accountId !== planned.accountId ||
          !isFresh(
            state.lastSyncTimestamp,
            this.clock(),
            this.config.maxDataAgeMs,
          ) ||
          !isFresh(quote.timestamp, this.clock(), this.config.maxDataAgeMs))
      ) {
        this.dispatchAuthority.invalidateIdentity();
        throw new Error('OFFLINE_IDENTITY_UNCERTAIN');
      }
      const before = preview.accounts[index];
      const validationNow = this.clock();
      actual = sizeTrade(
        state,
        preview.intent,
        quote,
        this.config,
        validationNow,
      );
      const mismatch =
        !before ||
        state.revision !== before.revision ||
        state.balance !== before.balance ||
        state.equity !== before.equity ||
        state.drawdown.floor !== before.drawdown.floor;
      const exposureViolations = evaluateFleetExposure(preview.intent, fleet);
      const gateReasons: RevalidationDiagnostic['gateReasons'] = [];
      if (this.circuitOpen) gateReasons.push('CIRCUIT_OPEN');
      if (!before) gateReasons.push('ACCOUNT_SNAPSHOT_MISSING');
      if (before && state.revision !== before.revision)
        gateReasons.push('ACCOUNT_REVISION_CHANGED');
      if (before && state.balance !== before.balance)
        gateReasons.push('ACCOUNT_BALANCE_CHANGED');
      if (before && state.equity !== before.equity)
        gateReasons.push('ACCOUNT_EQUITY_CHANGED');
      if (before && state.drawdown.floor !== before.drawdown.floor)
        gateReasons.push('DRAWDOWN_FLOOR_CHANGED');
      if (exposureViolations.length > 0) gateReasons.push('FLEET_EXPOSURE');
      if (!actual.approved) gateReasons.push('RISK_PREVIEW_REJECTED');
      // Preserve the final preview check after sizing, including time spent validating.
      const checkedAt = this.clock();
      const previewFresh = isFresh(
        preview.createdAt,
        checkedAt,
        this.config.maxPreviewAgeMs,
      );
      if (!previewFresh)
        gateReasons.push('PREVIEW_EXPIRED_DURING_REVALIDATION');
      const priceMoved = new D(quote.price)
        .minus(preview.quote.price)
        .abs()
        .gt(this.config.maxPriceMovePoints);
      if (priceMoved) gateReasons.push('PRICE_MOVE_LIMIT');
      const quantityIncreased = new D(actual.quantity).gt(planned.quantity);
      if (quantityIncreased) gateReasons.push('QUANTITY_INCREASE');
      revalidation = {
        gateReasons,
        riskReasons: actual.reasons as RevalidationDiagnostic['riskReasons'],
        previewAgeMs: checkedAt - preview.createdAt,
        quoteAgeMs: validationNow - quote.timestamp,
        accountAgeMs: validationNow - state.lastSyncTimestamp,
        queueDelayMs: childStarted - executionStarted,
        validationDurationMs: performance.now() - validationStarted,
      };
      if (
        this.circuitOpen ||
        mismatch ||
        exposureViolations.length > 0 ||
        !actual.approved ||
        !previewFresh ||
        priceMoved ||
        quantityIncreased
      ) {
        result.error =
          exposureViolations[0]?.code ?? 'PRETRADE_REVALIDATION_FAILED';
      } else {
        result.status = 'UNKNOWN';
        result.error = null;
        this.transition(masterTradeId, result, 'ENTRY_SUBMITTING'); // Durable BEFORE entry side effect.
        const entryRequest = {
          requestId,
          masterTradeId,
          accountId: state.accountId,
          intent: preview.intent,
          preview: actual,
          quote,
          config: this.config,
        };
        this.dispatchAuthority?.assertEntry(entryRequest, preview.previewId);
        this.beforeSubmit?.(entryRequest);
        submitted = true;
        entryStarted = performance.now();
        this.metrics.entries++;
        try {
          // An entry acknowledgement alone can never establish a protected trade.
          validateResult(
            await this.deadline(this.adapter.placeOrder(entryRequest)),
            requestId,
            state.accountId,
          );
        } catch {
          /* Attempt authoritative lookup; never resend a market entry. */
        }
        const rawLedger = await this.deadline(this.adapter.getOrder(requestId));
        const ledger = rawLedger
          ? validateResult(rawLedger, requestId, state.accountId)
          : null;
        const after = accountSchema.parse(
          await this.deadline(this.adapter.getAccountState(state.accountId)),
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
          const terminalPartial =
            ledger?.status === 'PARTIALLY_FILLED' &&
            ledger.remainderCanceled === true &&
            new D(ledger.filledSize).gt(0) &&
            new D(ledger.filledSize).lt(actual.quantity);
          if (
            ledger?.status === 'FILLED' ||
            ledger?.status === 'PARTIALLY_FILLED'
          )
            Object.assign(result, ledger, { status: 'UNKNOWN' });
          if (
            !ledger ||
            (ledger.status !== 'FILLED' && !terminalPartial) ||
            !ledger.entryPrice ||
            after.accountId !== state.accountId ||
            !position ||
            after.positions.length !== 1 ||
            position.symbol !== preview.intent.symbol ||
            position.side !== preview.intent.side ||
            !new D(position.quantity).eq(ledger.filledSize) ||
            (!terminalPartial &&
              !new D(ledger.filledSize).eq(actual.quantity)) ||
            !new D(ledger.entryPrice).eq(position.entryPrice) ||
            !new D(position.leverage).eq(preview.intent.leverage) ||
            after.status !== 'ACTIVE'
          )
            throw new Error('ENTRY_RECONCILIATION_FAILED');
          entryConfirmed = true;
          protectionStarted = performance.now();
          this.metrics.lastFillLatencyMs = Math.max(
            0,
            protectionStarted - entryStarted,
          );
          if (terminalPartial) this.metrics.partialFills++;
          this.journal.log({
            timestamp: this.clock(),
            masterTradeId,
            accountId: state.accountId,
            requestId,
            status: 'ENTRY_CONFIRMED',
            adapter: this.adapter.name,
            fillLatencyMs: this.metrics.lastFillLatencyMs,
          });
          result.entryWasPartial = terminalPartial;
          this.transition(masterTradeId, result, 'ENTRY_FILLED_UNPROTECTED');
          // Preserve the preview's cost envelope; unexpected fill/fee overruns fail closed.
          if (
            new D(position.entryPrice)
              .minus(quote.price)
              .abs()
              .gt(this.config.slippagePointsPerSide) ||
            new D(ledger.fees).gt(
              new D(actual.entryFee).plus(actual.accountCost),
            ) ||
            !new D(after.balance).eq(new D(state.balance).minus(ledger.fees))
          )
            throw new Error('FILL_RISK_CHANGED');
          const filledRisk = assessFilledRisk(
            after,
            preview.intent,
            this.config,
            ledger.fees,
            actual.totalPlannedLoss,
          );
          result.actualPlannedLoss = filledRisk.totalLoss;
          result.remainingAfterStop = filledRisk.remainingAfterStop;
          if (!filledRisk.approved) throw new Error('FILL_RISK_CHANGED');
          this.dispatchAuthority?.recordConfirmedFill(
            result,
            after,
            ledger,
            this.config.maxDataAgeMs,
          );
          const prices = protectionPrices(position.entryPrice, preview.intent);
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
            quantity: ledger.filledSize,
            type,
            triggerPrice:
              type === 'STOP_LOSS' ? prices.stopPrice : prices.targetPrice,
            reduceOnly: true,
          }));
          for (const request of requests) {
            if (this.protectionBlocked)
              throw new Error('HALTED_DURING_PROTECTION');
            result.protectionOrderIds.push(request.requestId);
            this.transition(masterTradeId, result, 'PROTECTION_SUBMITTING');
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
            if (this.dispatchAuthority) {
              const protectionAccount = accountSchema.parse(
                await this.deadline(
                  this.adapter.getAccountState(state.accountId),
                ),
              );
              this.dispatchAuthority.recordConfirmedFill(
                result,
                protectionAccount,
                ledger,
                this.config.maxDataAgeMs,
              );
              this.dispatchAuthority.assertProtection(request);
            }
            try {
              await this.deadline(this.adapter.placeProtectionOrder(request));
            } catch {
              /* A lost response is resolved only by authoritative exact-ID lookup. */
            }
            await this.verifyProtection(request);
          }
          // Re-read both protections, the entry ledger, and the position after both submissions.
          for (const request of requests) await this.verifyProtection(request);
          const open = (
            await this.deadline(this.adapter.getOpenOrders(state.accountId))
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
            await this.deadline(this.adapter.getAccountState(state.accountId)),
          );
          const finalPosition = finalState.positions[0];
          if (
            this.protectionBlocked ||
            !confirmedLedger ||
            confirmedLedger.status !== ledger.status ||
            confirmedLedger.remainderCanceled !== ledger.remainderCanceled ||
            !new D(confirmedLedger.filledSize).eq(ledger.filledSize) ||
            confirmedLedger.entryPrice !== ledger.entryPrice ||
            finalState.accountId !== state.accountId ||
            finalState.status !== 'ACTIVE' ||
            finalState.positions.length !== 1 ||
            !finalPosition ||
            finalPosition.entryRequestId !== requestId ||
            finalPosition.symbol !== preview.intent.symbol ||
            finalPosition.side !== preview.intent.side ||
            !new D(finalPosition.quantity).eq(ledger.filledSize) ||
            !new D(finalPosition.leverage).eq(preview.intent.leverage) ||
            finalPosition.entryPrice !== position.entryPrice ||
            finalPosition.protectionStatus !== 'ACTIVE'
          )
            throw new Error('PROTECTION_RECONCILIATION_FAILED');
          result.status = 'FILLED';
          result.error = null;
          this.transition(masterTradeId, result, 'PROTECTED');
          this.metrics.lastProtectionLatencyMs = Math.max(
            0,
            performance.now() - protectionStarted,
          );
          this.journal.log({
            timestamp: this.clock(),
            masterTradeId,
            accountId: state.accountId,
            requestId,
            status: 'PROTECTION_VERIFIED',
            adapter: this.adapter.name,
            protectionLatencyMs: this.metrics.lastProtectionLatencyMs,
            actualPlannedLoss: result.actualPlannedLoss!,
            remainingAfterStop: result.remainingAfterStop!,
          });
        }
      }
    } catch (error) {
      this.onFailure?.(error);
      result.status = submitted ? 'UNKNOWN' : 'REJECTED';
      result.state = submitted ? 'UNKNOWN' : 'REJECTED';
      result.error = submitted
        ? entryConfirmed
          ? 'PROTECTION_UNCONFIRMED'
          : 'EXECUTION_UNCERTAIN'
        : 'ACCOUNT_READ_FAILED';
      if (submitted) {
        if (entryConfirmed) this.metrics.protectionFailures++;
        // The owner decides cleanup and failure scope; uncertainty remains visible.
        result.cleanupStatus = await this.onUnsafeEntry(planned.accountId);
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
    ...(revalidation ? { revalidation } : {}),
  });
  return result;
}
