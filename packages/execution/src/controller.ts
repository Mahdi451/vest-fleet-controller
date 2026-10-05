import { createHash } from 'node:crypto';
import {
  D,
  intentSchema,
  riskConfigSchema,
  isFresh,
  accountSchema,
  quoteSchema,
  remainingDrawdown,
  direction,
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
  assessFilledRisk,
  type RiskPreview,
} from '../../risk-engine/src/index.ts';
import {
  evaluateFleetExposure,
  type ExposureViolation,
} from '../../risk-engine/src/exposure.ts';
import type { ExecutionAdapter, ChildResult } from './adapter.ts';
import { Journal, type RevalidationDiagnostic } from './journal.ts';
import { validateResult } from './adapter.ts';
import type { OfflineDispatchAuthorizer } from './offline-authority.ts';

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
  private lastReconciliation: {
    timestamp: number;
    dataFresh: boolean;
    issues: Array<{ accountId: string; code: string }>;
  } | null = null;
  private knownAccountIds: Set<string> | null = null;
  private metrics = {
    entries: 0,
    partialFills: 0,
    protectionFailures: 0,
    reconciliationRuns: 0,
    reconciliationFailures: 0,
    divergences: 0,
    lastFillLatencyMs: 0,
    lastProtectionLatencyMs: 0,
    lastReconciliationLatencyMs: 0,
  };
  health() {
    const fresh =
      this.lastReconciliation !== null &&
      this.lastReconciliation.dataFresh &&
      isFresh(
        this.lastReconciliation.timestamp,
        this.clock(),
        this.config.maxDataAgeMs,
      );
    return {
      state: this.circuitOpen
        ? 'HALTED'
        : this.busy || !fresh
          ? 'DEGRADED'
          : 'SAFE',
      busy: this.busy,
      lastReconciledAt: this.lastReconciliation?.timestamp ?? null,
      issues: structuredClone(this.lastReconciliation?.issues ?? []),
      metrics: { ...this.metrics },
    };
  }
  /** Read authoritative books, halt on divergence, clean unsafe exposure without re-arming. */
  async reconcile() {
    if (this.busy) throw new Error('CONTROLLER_BUSY');
    this.busy = true;
    const started = performance.now();
    const issues: Array<{ accountId: string; code: string }> = [];
    const issue = (accountId: string, code: string) => {
      issues.push({ accountId, code });
      this.circuitOpen = true;
      this.dispatchAuthority?.revokeEntries();
    };
    this.metrics.reconciliationRuns++;
    let dataFresh = false;
    try {
      const quote = quoteSchema.parse(
        await this.deadline(this.adapter.getQuote()),
      );
      const accounts = (await this.deadline(this.adapter.listAccounts())).map(
        (a) => accountSchema.parse(a),
      );
      if (
        accounts.length === 0 ||
        new Set(accounts.map((a) => a.accountId)).size !== accounts.length
      )
        throw new Error('DUPLICATE_ACCOUNT_ID');
      if (this.knownAccountIds) {
        for (const id of this.knownAccountIds) {
          if (!accounts.some((a) => a.accountId === id))
            issue(id, 'ACCOUNT_MISSING');
        }
      }
      this.knownAccountIds ??= new Set(accounts.map((a) => a.accountId));
      dataFresh =
        isFresh(quote.timestamp, this.clock(), this.config.maxDataAgeMs) &&
        accounts.every((a) =>
          isFresh(a.lastSyncTimestamp, this.clock(), this.config.maxDataAgeMs),
        );
      const children = this.journal.allChildren();
      for (const original of accounts) {
        const id = original.accountId;
        try {
          const a = accountSchema.parse(
            await this.deadline(this.adapter.getAccountState(id)),
          );
          if (a.accountId !== id) throw new Error('ACCOUNT_IDENTITY_MISMATCH');
          const open = (
            await this.deadline(this.adapter.getOpenOrders(id))
          ).map((o) => protectionOrderSchema.parse(o));
          if (open.some((o) => o.accountId !== id || o.status !== 'ACTIVE'))
            throw new Error('ORDER_BOOK_MISMATCH');
          const p = a.positions[0];
          const orphan = open.filter(
            (o) =>
              !p ||
              o.entryRequestId !== p.entryRequestId ||
              o.positionSide !== p.side ||
              o.symbol !== p.symbol,
          );
          for (const order of orphan) {
            issue(id, 'ORPHAN_PROTECTION');
            this.dispatchAuthority?.verifyAccountEvidence(
              a,
              id,
              this.config.maxDataAgeMs,
            );
            this.dispatchAuthority?.assertCancel(order, children);
            await this.deadline(this.adapter.cancelOrder(id, order.orderId));
            const canceled = protectionOrderSchema.parse(
              await this.deadline(
                this.adapter.getProtectionOrder(id, order.orderId),
              ),
            );
            if (
              canceled.accountId !== id ||
              canceled.orderId !== order.orderId ||
              canceled.status !== 'CANCELED'
            )
              throw new Error('ORPHAN_CANCEL_UNCONFIRMED');
          }
          if (orphan.length) {
            const remaining = (
              await this.deadline(this.adapter.getOpenOrders(id))
            ).map((o) => protectionOrderSchema.parse(o));
            if (
              remaining.some((o) =>
                orphan.some((old) => old.orderId === o.orderId),
              )
            )
              throw new Error('ORPHAN_CANCEL_UNCONFIRMED');
          }
          if (
            children.some((c) => c.accountId === id && c.status === 'UNKNOWN')
          )
            issue(id, 'UNRESOLVED_REQUEST');
          if (p) {
            const child = children.find(
              (c) => c.requestId === p.entryRequestId && c.accountId === id,
            );
            const raw = await this.deadline(
              this.adapter.getOrder(p.entryRequestId),
            );
            const ledger = raw
              ? validateResult(raw, p.entryRequestId, id)
              : null;
            const expected = child?.intent
              ? protectionPrices(p.entryPrice, child.intent)
              : null;
            const positionMatches =
              child?.state === 'PROTECTED' &&
              child.intent &&
              expected &&
              child.intent.symbol === p.symbol &&
              child.intent.side === p.side &&
              new D(child.intent.leverage).eq(p.leverage) &&
              child.entryPrice !== null &&
              new D(child.entryPrice).eq(p.entryPrice) &&
              new D(child.filledSize).eq(p.quantity) &&
              ledger &&
              (ledger.status === 'FILLED' ||
                (ledger.status === 'PARTIALLY_FILLED' &&
                  ledger.remainderCanceled === true)) &&
              new D(ledger.filledSize).eq(p.quantity) &&
              ledger.entryPrice !== null &&
              new D(ledger.entryPrice).eq(p.entryPrice);
            const protectedPosition =
              positionMatches &&
              p.protectionStatus === 'ACTIVE' &&
              open.length === 2 &&
              (['STOP_LOSS', 'TAKE_PROFIT'] as const).every((type) =>
                open.some(
                  (o) =>
                    o.orderId === hash([p.entryRequestId, type]) &&
                    child.protectionOrderIds.includes(o.orderId) &&
                    o.requestId === o.orderId &&
                    o.type === type &&
                    o.entryRequestId === p.entryRequestId &&
                    o.positionSide === p.side &&
                    o.symbol === p.symbol &&
                    o.reduceOnly &&
                    new D(o.quantity).eq(p.quantity) &&
                    new D(o.filledSize).isZero() &&
                    new D(o.triggerPrice).eq(
                      type === 'STOP_LOSS'
                        ? expected.stopPrice
                        : expected.targetPrice,
                    ),
                ),
              );
            const unrealized = new D(quote.price)
              .minus(p.entryPrice)
              .mul(p.quantity)
              .mul(direction(p.side));
            const accountingMatches =
              new D(a.equity).eq(new D(a.balance).plus(unrealized)) &&
              new D(a.remainingDrawdown).eq(remainingDrawdown(a));
            const crossed =
              expected &&
              (p.side === 'LONG'
                ? new D(quote.price).lte(expected.stopPrice) ||
                  new D(quote.price).gte(expected.targetPrice)
                : new D(quote.price).gte(expected.stopPrice) ||
                  new D(quote.price).lte(expected.targetPrice));
            if (
              !protectedPosition ||
              !accountingMatches ||
              crossed ||
              a.status !== 'ACTIVE'
            ) {
              issue(
                id,
                !positionMatches
                  ? 'POSITION_DIVERGENCE'
                  : 'PROTECTION_DIVERGENCE',
              );
              await this.cleanupAccount(id);
            }
          } else {
            for (const child of children.filter(
              (c) => c.accountId === id && c.state === 'PROTECTED',
            )) {
              const exits = await Promise.all(
                child.protectionOrderIds.map(async (orderId) => {
                  const raw = await this.deadline(
                    this.adapter.getProtectionOrder(id, orderId),
                  );
                  return raw ? protectionOrderSchema.parse(raw) : null;
                }),
              );
              const exited = exits.some(
                (o) =>
                  o &&
                  o.accountId === id &&
                  o.entryRequestId === child.requestId &&
                  o.status === 'FILLED' &&
                  new D(o.filledSize).eq(child.filledSize),
              );
              if (!exited) issue(id, 'EXTERNAL_OR_UNVERIFIED_EXIT');
            }
          }
          const after = accountSchema.parse(
            await this.deadline(this.adapter.getAccountState(id)),
          );
          if (
            !issues.some((i) => i.accountId === id) &&
            after.revision !== a.revision
          )
            issue(id, 'RECONCILIATION_RACE');
        } catch {
          issue(id, 'ACCOUNT_RECONCILIATION_FAILED');
          await this.cleanupAccount(id);
        }
      }
      // A missing inventory member must not make its historical exposure disappear.
      for (const child of children)
        if (!accounts.some((a) => a.accountId === child.accountId))
          issue(child.accountId, 'ACCOUNT_MISSING');
    } catch {
      issue('FLEET', 'RECONCILIATION_FAILED');
    } finally {
      this.metrics.lastReconciliationLatencyMs = Math.max(
        0,
        performance.now() - started,
      );
      this.metrics.divergences += issues.length;
      if (issues.length) this.metrics.reconciliationFailures++;
      this.lastReconciliation = { timestamp: this.clock(), dataFresh, issues };
      this.busy = false;
    }
    try {
      if (issues.length) this.halt();
      this.journal.log({
        timestamp: this.clock(),
        masterTradeId: 'RECONCILIATION',
        status: issues.length ? 'RECONCILIATION_FAILED' : 'RECONCILED',
        adapter: this.adapter.name,
        reconciliationLatencyMs: this.metrics.lastReconciliationLatencyMs,
      });
      for (const item of issues)
        this.journal.log({
          timestamp: this.clock(),
          masterTradeId: 'RECONCILIATION',
          accountId: item.accountId,
          status: 'DIVERGENCE',
          error: item.code,
          adapter: this.adapter.name,
        });
    } catch {
      this.circuitOpen = true;
      try {
        this.journal.halt();
      } catch {
        /* Keep in-memory halt even if storage fails. */
      }
      throw new Error('RECONCILIATION_AUDIT_FAILED');
    }
    return this.health();
  }
  constructor(
    private readonly adapter: ExecutionAdapter,
    config: RiskConfig,
    private readonly journal: Journal,
    private readonly clock: () => number = Date.now,
    private readonly timeoutMs = 1000,
    private readonly dispatchAuthority?: OfflineDispatchAuthorizer,
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
    this.dispatchAuthority?.revokeEntries();
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
  private async authorizeFlatten(accountId: string) {
    if (!this.dispatchAuthority) return;
    const account = accountSchema.parse(
      await this.deadline(this.adapter.getAccountState(accountId)),
    );
    const open = (
      await this.deadline(this.adapter.getOpenOrders(accountId))
    ).map((o) => protectionOrderSchema.parse(o));
    if (
      account.accountId !== accountId ||
      !isFresh(
        account.lastSyncTimestamp,
        this.clock(),
        this.config.maxDataAgeMs,
      )
    ) {
      this.dispatchAuthority.invalidateIdentity();
      throw new Error('OFFLINE_IDENTITY_UNCERTAIN');
    }
    const children = this.journal.allChildren();
    for (const p of account.positions) {
      const child = children.find(
        (c) => c.requestId === p.entryRequestId && c.accountId === accountId,
      );
      const ledger = await this.deadline(
        this.adapter.getOrder(p.entryRequestId),
      );
      if (!child || !ledger) throw new Error('OFFLINE_RECOVERY_UNPROVEN');
      this.dispatchAuthority.recordConfirmedFill(
        child,
        account,
        ledger,
        this.config.maxDataAgeMs,
      );
    }
    this.dispatchAuthority.verifyAccountEvidence(
      account,
      accountId,
      this.config.maxDataAgeMs,
    );
    this.dispatchAuthority.assertFlatten(account, open, children);
    return { account, open, children };
  }
  private async cleanupAccount(accountId: string): Promise<'FLAT' | 'UNKNOWN'> {
    let status: 'FLAT' | 'UNKNOWN' = 'UNKNOWN';
    try {
      const proof = await this.authorizeFlatten(accountId);
      if (proof && this.dispatchAuthority) {
        this.dispatchAuthority.verifyAccountEvidence(
          proof.account,
          accountId,
          this.config.maxDataAgeMs,
        );
        this.dispatchAuthority.assertFlatten(
          proof.account,
          proof.open,
          proof.children,
        );
      }
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
    const executionStarted = performance.now();
    let stopped = this.circuitOpen;
    try {
      for (const [index, planned] of preview.orders.entries()) {
        const start = this.clock();
        const childStarted = performance.now();
        let revalidation: RevalidationDiagnostic | undefined;
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
                !isFresh(
                  quote.timestamp,
                  this.clock(),
                  this.config.maxDataAgeMs,
                ))
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
            const exposureViolations = evaluateFleetExposure(
              preview.intent,
              fleet,
            );
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
            if (exposureViolations.length > 0)
              gateReasons.push('FLEET_EXPOSURE');
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
            const quantityIncreased = new D(actual.quantity).gt(
              planned.quantity,
            );
            if (quantityIncreased) gateReasons.push('QUANTITY_INCREASE');
            revalidation = {
              gateReasons,
              riskReasons:
                actual.reasons as RevalidationDiagnostic['riskReasons'],
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
              this.dispatchAuthority?.assertEntry(
                entryRequest,
                preview.previewId,
              );
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
                  quantity: ledger.filledSize,
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
                  confirmedLedger.status !== ledger.status ||
                  confirmedLedger.remainderCanceled !==
                    ledger.remainderCanceled ||
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
          } catch {
            result.status = submitted ? 'UNKNOWN' : 'REJECTED';
            result.state = submitted ? 'UNKNOWN' : 'REJECTED';
            result.error = submitted
              ? entryConfirmed
                ? 'PROTECTION_UNCONFIRMED'
                : 'EXECUTION_UNCERTAIN'
              : 'ACCOUNT_READ_FAILED';
            if (submitted) {
              if (entryConfirmed) this.metrics.protectionFailures++;
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
          ...(revalidation ? { revalidation } : {}),
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
          const proof = await this.authorizeFlatten(a.accountId);
          if (proof && this.dispatchAuthority) {
            this.dispatchAuthority.verifyAccountEvidence(
              proof.account,
              a.accountId,
              this.config.maxDataAgeMs,
            );
            this.dispatchAuthority.assertFlatten(
              proof.account,
              proof.open,
              proof.children,
            );
          }
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
