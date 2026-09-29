import { createHash } from 'node:crypto';
import {
  D,
  intentSchema,
  riskConfigSchema,
  isFresh,
  type Account,
  type TradeIntent,
  type RiskConfig,
  type Quote,
} from '../../core/src/index.ts';
import { sizeTrade, type RiskPreview } from '../../risk-engine/src/index.ts';
import {
  evaluateFleetExposure,
  type ExposureViolation,
} from '../../risk-engine/src/exposure.ts';
import type { ExecutionAdapter, OrderResult } from './adapter.ts';
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
  ): Promise<OrderResult[]> {
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
    const results: OrderResult[] = [];
    let stopped = this.circuitOpen;
    try {
      for (const [index, planned] of preview.orders.entries()) {
        const start = this.clock();
        const requestId = hash([masterTradeId, planned.accountId]);
        const result: OrderResult = {
          requestId,
          accountId: planned.accountId,
          status: 'REJECTED',
          filledSize: '0',
          entryPrice: null,
          fees: '0',
          error: null,
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
              result.error = 'SUBMITTING';
              this.journal.child(masterTradeId, result); // Durable BEFORE side effect.
              this.journal.log({
                timestamp: this.clock(),
                masterTradeId,
                accountId: state.accountId,
                requestId,
                symbol: preview.intent.symbol,
                direction: preview.intent.side,
                requestedSize: actual.quantity,
                stop: actual.stop,
                target: actual.target,
                status: 'SUBMITTING',
                adapter: this.adapter.name,
              });
              submitted = true;
              const acknowledgement = await this.deadline(
                this.adapter.placeOrder({
                  requestId,
                  masterTradeId,
                  accountId: state.accountId,
                  intent: preview.intent,
                  preview: actual,
                  quote,
                  config: this.config,
                }),
              );
              Object.assign(
                result,
                validateResult(acknowledgement, requestId, state.accountId),
              );
              // Acknowledgement alone does not establish the position.
              const rawLedger = await this.deadline(
                this.adapter.getOrder(requestId),
              );
              const ledger = rawLedger
                ? validateResult(rawLedger, requestId, state.accountId)
                : null;
              const after = await this.deadline(
                this.adapter.getAccountState(state.accountId),
              );
              const position = after.positions.find(
                (p) => p.requestId === requestId,
              );
              if (
                ledger?.status === 'FILLED' &&
                position &&
                position.symbol === preview.intent.symbol &&
                position.side === preview.intent.side &&
                new D(position.quantity).eq(actual.quantity) &&
                ledger.filledSize === actual.quantity &&
                ledger.entryPrice === position.entryPrice &&
                after.status === 'ACTIVE' &&
                position.stop === actual.stop &&
                position.target === actual.target &&
                ledger.accountId === state.accountId &&
                ledger.requestId === requestId
              ) {
                Object.assign(result, ledger);
              } else if (
                ledger?.status === 'REJECTED' &&
                after.positions.length === 0
              )
                Object.assign(result, ledger);
              else {
                result.status = 'UNKNOWN';
                result.error = 'RECONCILIATION_REQUIRED';
              }
            }
          } catch {
            result.status = submitted ? 'UNKNOWN' : 'REJECTED';
            result.error = submitted
              ? 'EXECUTION_UNCERTAIN'
              : 'ACCOUNT_READ_FAILED';
          }
        }
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
          stop: actual.stop,
          target: actual.target,
          fees: result.fees,
          status: result.status,
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
          // Unresolved submissions may still fill; an empty position snapshot cannot prove finality.
          if (
            after.positions.length === 0 &&
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
