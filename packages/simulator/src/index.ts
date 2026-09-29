import {
  D,
  accountSchema,
  quoteSchema,
  riskConfigSchema,
  initialFleet,
  markAccount,
  direction,
  positive,
  nonnegative,
  decimal,
  type Account,
  type RiskConfig,
  type Quote,
} from '../../core/src/index.ts';
import { evaluateFleetExposure } from '../../risk-engine/src/exposure.ts';
import { costsFor, sizeTrade } from '../../risk-engine/src/index.ts';
import type {
  ExecutionAdapter,
  OrderRequest,
  OrderResult,
} from '../../execution/src/adapter.ts';
import { createHash } from 'node:crypto';
import type { AuditEvent } from '../../execution/src/journal.ts';

export type Fault = 'REJECT' | 'TIMEOUT_BEFORE_FILL' | 'AMBIGUOUS_AFTER_FILL';
export class MockVestAdapter implements ExecutionAdapter {
  readonly name = 'MockVestAdapter';
  readonly mode = 'SIMULATION' as const;
  private connected = false;
  private accounts: Map<string, Account>;
  private quote: Quote;
  private orders = new Map<
    string,
    { fingerprint: string; result: OrderResult }
  >();
  private faults = new Map<string, Fault>();
  private config: RiskConfig;
  constructor(
    config: RiskConfig,
    private readonly clock: () => number = Date.now,
    fleet?: Account[],
    price = '30400',
    private readonly audit: (event: AuditEvent) => void = () => {},
  ) {
    this.config = riskConfigSchema.parse(config);
    const validated = (fleet ?? initialFleet(clock())).map((a) =>
      accountSchema.parse(a),
    );
    if (new Set(validated.map((a) => a.accountId)).size !== validated.length)
      throw new Error('DUPLICATE_ACCOUNT_ID');
    this.accounts = new Map(validated.map((a) => [a.accountId, a]));
    this.quote = quoteSchema.parse({
      symbol: 'NDX',
      price,
      timestamp: clock(),
    });
    for (const a of this.accounts.values()) markAccount(a, price, clock());
  }
  async connect() {
    this.connected = true;
    this.log('CONNECTED');
  }
  async disconnect() {
    this.connected = false;
    this.log('DISCONNECTED');
  }
  private log(status: string, fields: Partial<AuditEvent> = {}) {
    this.audit({
      timestamp: this.clock(),
      masterTradeId: 'SIMULATOR',
      adapter: this.name,
      status,
      ...fields,
    });
  }
  private ready() {
    if (!this.connected) throw new Error('ADAPTER_DISCONNECTED');
  }
  private account(id: string) {
    const a = this.accounts.get(id);
    if (!a) throw new Error('ACCOUNT_NOT_FOUND');
    return a;
  }
  async listAccounts() {
    this.ready();
    return structuredClone([...this.accounts.values()]);
  }
  async getAccountState(id: string) {
    this.ready();
    return structuredClone(this.account(id));
  }
  async getQuote() {
    this.ready();
    return structuredClone(this.quote);
  }
  async getOrder(id: string) {
    this.ready();
    return structuredClone(this.orders.get(id)?.result ?? null);
  }
  injectFault(id: string, fault: Fault) {
    this.account(id);
    this.faults.set(id, fault);
    this.log('FAULT_INJECTED', { accountId: id, error: fault });
  }
  setEnabled(id: string, enabled: boolean) {
    const a = this.account(id);
    a.enabled = enabled;
    a.revision++;
    this.log(enabled ? 'ACCOUNT_ENABLED' : 'ACCOUNT_DISABLED', {
      accountId: id,
    });
  }
  async placeOrder(order: OrderRequest): Promise<OrderResult> {
    this.ready();
    const fingerprint = createHash('sha256')
      .update(JSON.stringify(order))
      .digest('hex');
    const previous = this.orders.get(order.requestId);
    if (previous) {
      if (previous.fingerprint !== fingerprint)
        throw new Error('IDEMPOTENCY_CONFLICT');
      return structuredClone(previous.result);
    }
    const a = this.account(order.accountId);
    const result: OrderResult = {
      requestId: order.requestId,
      accountId: a.accountId,
      status: 'REJECTED',
      filledSize: '0',
      entryPrice: null,
      fees: '0',
      error: null,
    };
    const record = () => {
      this.orders.set(order.requestId, {
        fingerprint,
        result: structuredClone(result),
      });
      this.log(result.status, {
        masterTradeId: order.masterTradeId,
        accountId: a.accountId,
        requestId: order.requestId,
        symbol: order.intent.symbol,
        direction: order.intent.side,
        requestedSize: order.preview.quantity,
        filledSize: result.filledSize,
        entryPrice: result.entryPrice,
        fees: result.fees,
        error: result.error,
        stop: order.preview.stop,
        target: order.preview.target,
      });
      return structuredClone(result);
    };
    const check = sizeTrade(
      a,
      order.intent,
      this.quote,
      this.config,
      this.clock(),
    );
    const exposureViolations = evaluateFleetExposure(order.intent, [
      ...this.accounts.values(),
    ]);
    if (
      !check.approved ||
      exposureViolations.length > 0 ||
      !new D(check.quantity).eq(order.preview.quantity) ||
      JSON.stringify(order.config) !== JSON.stringify(this.config) ||
      order.preview.stop !== check.stop ||
      order.preview.target !== check.target
    ) {
      result.error =
        exposureViolations[0]?.code ?? 'PRETRADE_REVALIDATION_FAILED';
      return record();
    }
    const fault = this.faults.get(a.accountId);
    this.faults.delete(a.accountId);
    if (fault === 'REJECT') {
      a.executionStatus = 'REJECTED';
      result.error = 'SIMULATED_REJECTION';
      return record();
    }
    if (fault === 'TIMEOUT_BEFORE_FILL') {
      a.executionStatus = 'UNKNOWN';
      a.revision++;
      result.status = 'UNKNOWN';
      result.error = 'SIMULATED_TIMEOUT';
      return record();
    }
    const fee = costsFor(a, this.config);
    const fill = new D(this.quote.price).plus(
      new D(this.config.slippagePointsPerSide).mul(
        direction(order.intent.side),
      ),
    );
    const entryFee = fill
      .mul(check.quantity)
      .mul(fee.entryFeeRate)
      .plus(fee.accountCost);
    a.balance = new D(a.balance).minus(entryFee).toFixed();
    a.realizedPnl = new D(a.realizedPnl).minus(entryFee).toFixed();
    a.leverage = order.intent.leverage;
    a.positions.push({
      symbol: order.intent.symbol,
      side: order.intent.side,
      quantity: check.quantity,
      entryPrice: fill.toFixed(),
      stop: check.stop,
      target: check.target,
      leverage: order.intent.leverage,
      requestId: order.requestId,
    });
    a.executionStatus = 'FILLED';
    markAccount(a, this.quote.price, this.clock());
    result.status = 'FILLED';
    result.filledSize = check.quantity;
    result.entryPrice = fill.toFixed();
    result.fees = entryFee.toFixed();
    record();
    if (fault === 'AMBIGUOUS_AFTER_FILL')
      return {
        ...result,
        status: 'UNKNOWN',
        filledSize: '0',
        entryPrice: null,
        error: 'SIMULATED_AMBIGUOUS_RESPONSE',
      };
    return result;
  }
  private close(a: Account, quantity?: string) {
    const p = a.positions[0];
    if (!p) return;
    const qty =
      quantity === undefined
        ? new D(p.quantity)
        : new D(positive.parse(quantity));
    if (qty.gt(p.quantity)) throw new Error('CLOSE_EXCEEDS_POSITION');
    const fill = D.max(
      '0.00000001',
      new D(this.quote.price).minus(
        new D(this.config.slippagePointsPerSide).mul(direction(p.side)),
      ),
    );
    const gross = fill.minus(p.entryPrice).mul(qty).mul(direction(p.side));
    const exitFee = fill.mul(qty).mul(costsFor(a, this.config).exitFeeRate);
    const net = gross.minus(exitFee);
    a.balance = new D(a.balance).plus(net).toFixed();
    a.realizedPnl = new D(a.realizedPnl).plus(net).toFixed();
    if (qty.eq(p.quantity)) a.positions = [];
    else p.quantity = new D(p.quantity).minus(qty).toFixed();
    markAccount(a, this.quote.price, this.clock());
    this.log(a.status === 'BREACHED' ? 'BREACHED_CLOSE' : 'CLOSED', {
      accountId: a.accountId,
      requestId: p.requestId,
      symbol: p.symbol,
      direction: p.side,
      filledSize: qty.toFixed(),
      marketPrice: fill.toFixed(),
      fees: exitFee.toFixed(),
      balance: a.balance,
      equity: a.equity,
    });
  }
  async closePosition(id: string, quantity?: string) {
    this.ready();
    this.close(this.account(id), quantity);
  }
  async flattenAccount(id: string) {
    this.ready();
    this.close(this.account(id));
  }
  async updatePrice(price: string) {
    this.ready();
    this.quote = quoteSchema.parse({
      symbol: 'NDX',
      price,
      timestamp: this.clock(),
    });
    this.log('MARKET_UPDATE', { marketPrice: price });
    for (const a of this.accounts.values()) {
      markAccount(a, price, this.clock());
      const p = a.positions[0];
      if (!p) continue;
      const trigger =
        p.side === 'LONG'
          ? new D(price).lte(p.stop) || new D(price).gte(p.target)
          : new D(price).gte(p.stop) || new D(price).lte(p.target);
      if (a.status === 'BREACHED' || trigger) this.close(a);
    }
  }
  async applyFunding(longRatePerHour: string, hours: string) {
    this.ready();
    decimal.parse(longRatePerHour);
    nonnegative.parse(hours);
    // Scenario input. Positive rate debits longs and credits shorts. Not Vest's formula.
    for (const a of this.accounts.values()) {
      const charge = a.positions.reduce(
        (sum, p) =>
          sum.plus(
            new D(p.quantity)
              .mul(this.quote.price)
              .mul(longRatePerHour)
              .mul(hours)
              .mul(direction(p.side)),
          ),
        new D(0),
      );
      a.balance = new D(a.balance).minus(charge).toFixed();
      a.realizedPnl = new D(a.realizedPnl).minus(charge).toFixed();
      markAccount(a, this.quote.price, this.clock());
      this.log('FUNDING_SETTLED', {
        accountId: a.accountId,
        funding: charge.toFixed(),
        balance: a.balance,
        equity: a.equity,
      });
      if (a.status === 'BREACHED') this.close(a);
    }
  }
  async withdrawProfit(id: string, grossDebit: string, profitShare: string) {
    this.ready();
    positive.parse(grossDebit);
    positive.parse(profitShare);
    const a = this.account(id),
      amount = new D(grossDebit),
      share = new D(profitShare);
    if (
      share.gt(1) ||
      a.status !== 'ACTIVE' ||
      a.executionStatus === 'UNKNOWN' ||
      a.positions.length > 0 ||
      amount.gt(new D(a.balance).minus(a.startingBalance)) ||
      new D(a.remainingDrawdown)
        .minus(amount)
        .lt(this.config.minimumRemainingDrawdownAfterStop)
    )
      throw new Error('UNSAFE_WITHDRAWAL');
    a.balance = new D(a.balance).minus(amount).toFixed();
    markAccount(a, this.quote.price, this.clock());
    this.log('WITHDRAWAL', {
      accountId: id,
      withdrawalGross: grossDebit,
      withdrawalNet: amount.mul(share).toFixed(),
      balance: a.balance,
      equity: a.equity,
    });
    return {
      grossDebit,
      netPayout: amount.mul(share).toFixed(),
      floor: a.drawdown.floor,
    };
  }
}
