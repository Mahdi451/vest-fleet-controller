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
  type RiskPreview,
} from '../../risk-engine/src/index.ts';
import {
  evaluateFleetExposure,
  type ExposureViolation,
} from '../../risk-engine/src/exposure.ts';
import type { ExecutionAdapter, ChildResult } from './adapter.ts';
import { Journal } from './journal.ts';
import { validateResult } from './adapter.ts';
import { executeAccount, protectionMatches } from './account-lifecycle.ts';
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
    return protectionMatches(order, request);
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
        const entryBlocked = () => this.circuitOpen;
        const result = await executeAccount.call(
          {
            adapter: this.adapter,
            config: this.config,
            journal: this.journal,
            clock: this.clock,
            deadline: <T>(promise: Promise<T>) => this.deadline(promise),
            get circuitOpen() {
              return entryBlocked();
            },
            get protectionBlocked() {
              return entryBlocked();
            },
            dispatchAuthority: this.dispatchAuthority,
            metrics: this.metrics,
            transition: (id, result, state) =>
              this.transition(id, result, state),
            verifyProtection: (request) => this.verifyProtection(request),
            protectionMatches: (order, request) =>
              this.protectionMatches(order, request),
            onUnsafeEntry: async (accountId) => {
              this.circuitOpen = true;
              try {
                this.journal.halt();
              } catch {
                /* Cleanup must still run. */
              }
              return this.cleanupAccount(accountId);
            },
          },
          masterTradeId,
          preview,
          planned,
          index,
          executionStarted,
          stopped,
        );
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
