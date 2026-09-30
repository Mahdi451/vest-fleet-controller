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
  protectionRequestSchema,
  protectionOrderSchema,
  type ProtectionRequest,
  type ProtectionOrder,
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
import { z } from 'zod';
import { resultSchema } from '../../execution/src/adapter.ts';
import { createHash } from 'node:crypto';
import type { AuditEvent } from '../../execution/src/journal.ts';

const snapshotSchema = z
  .object({
    version: z.literal(1),
    config: riskConfigSchema,
    quote: quoteSchema,
    accounts: z.array(accountSchema).min(1),
    orders: z.array(
      z.object({ fingerprint: z.string(), result: resultSchema }).strict(),
    ),
    protection: z.array(
      z
        .object({ fingerprint: z.string(), order: protectionOrderSchema })
        .strict(),
    ),
  })
  .strict();

export type Fault =
  | 'REJECT'
  | 'TIMEOUT_BEFORE_FILL'
  | 'AMBIGUOUS_AFTER_FILL'
  | 'PARTIAL_FILL'
  | 'PARTIAL_FILL_PENDING';
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
  private protection = new Map<
    string,
    { fingerprint: string; order: ProtectionOrder }
  >();
  private protectionFaults = new Map<
    string,
    'REJECT' | 'TIMEOUT_BEFORE_CREATE' | 'AMBIGUOUS_AFTER_CREATE'
  >();
  private config: RiskConfig;
  constructor(
    config: RiskConfig,
    private readonly clock: () => number = Date.now,
    fleet?: Account[],
    price = '30400',
    private readonly audit: (event: AuditEvent) => void = () => {},
    private readonly persist: (snapshot: unknown) => void = () => {},
    savedSnapshot?: unknown,
  ) {
    this.config = riskConfigSchema.parse(config);
    if (savedSnapshot !== undefined) {
      const saved = snapshotSchema.parse(savedSnapshot);
      if (JSON.stringify(saved.config) !== JSON.stringify(this.config))
        throw new Error('SIMULATION_CONFIG_CHANGED');
      if (
        new Set(saved.accounts.map((a) => a.accountId)).size !==
          saved.accounts.length ||
        new Set(saved.orders.map((o) => o.result.requestId)).size !==
          saved.orders.length ||
        new Set(saved.protection.map((o) => o.order.orderId)).size !==
          saved.protection.length
      )
        throw new Error('INVALID_SIMULATION_SNAPSHOT');
      const ids = new Set(saved.accounts.map((a) => a.accountId));
      if (
        saved.orders.some((o) => !ids.has(o.result.accountId)) ||
        saved.protection.some((o) => !ids.has(o.order.accountId))
      )
        throw new Error('INVALID_SIMULATION_SNAPSHOT');
      this.accounts = new Map(saved.accounts.map((a) => [a.accountId, a]));
      this.quote = saved.quote;
      this.orders = new Map(saved.orders.map((o) => [o.result.requestId, o]));
      this.protection = new Map(
        saved.protection.map((o) => [o.order.orderId, o]),
      );
      return;
    }
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
  exportSnapshot() {
    return structuredClone({
      version: 1 as const,
      config: this.config,
      quote: this.quote,
      accounts: [...this.accounts.values()],
      orders: [...this.orders.values()],
      protection: [...this.protection.values()],
    });
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
    // Persist even intermediate unsafe states before emitting their audit event.
    // Restart always halts and reconciles; it never certifies a snapshot as protected.
    this.persist(this.exportSnapshot());
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
      JSON.stringify(order.config) !== JSON.stringify(this.config)
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
    const partial =
      fault === 'PARTIAL_FILL' || fault === 'PARTIAL_FILL_PENDING';
    const filledQuantity = partial
      ? new D(check.quantity)
          .div(2)
          .div(this.config.sizeStep)
          .floor()
          .mul(this.config.sizeStep)
          .toFixed()
      : check.quantity;
    if (new D(filledQuantity).lte(0)) {
      result.error = 'PARTIAL_BELOW_SIZE_STEP';
      return record();
    }
    const entryFee = fill
      .mul(filledQuantity)
      .mul(fee.entryFeeRate)
      .plus(fee.accountCost);
    a.balance = new D(a.balance).minus(entryFee).toFixed();
    a.realizedPnl = new D(a.realizedPnl).minus(entryFee).toFixed();
    a.leverage = order.intent.leverage;
    a.positions.push({
      symbol: order.intent.symbol,
      side: order.intent.side,
      quantity: filledQuantity,
      entryPrice: fill.toFixed(),
      protectionStatus: 'NONE',
      leverage: order.intent.leverage,
      entryRequestId: order.requestId,
    });
    a.executionStatus = 'UNKNOWN'; // A fill without confirmed protection is unsafe.
    this.log('ENTRY_FILLED_UNPROTECTED', {
      accountId: a.accountId,
      requestId: order.requestId,
      entryPrice: fill.toFixed(),
    });
    markAccount(a, this.quote.price, this.clock());
    result.status = partial ? 'PARTIALLY_FILLED' : 'FILLED';
    if (partial) result.remainderCanceled = fault === 'PARTIAL_FILL';
    result.filledSize = filledQuantity;
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
  injectProtectionFault(
    accountId: string,
    type: ProtectionRequest['type'],
    fault: 'REJECT' | 'TIMEOUT_BEFORE_CREATE' | 'AMBIGUOUS_AFTER_CREATE',
  ) {
    this.account(accountId);
    this.protectionFaults.set(`${accountId}:${type}`, fault);
    this.log('PROTECTION_FAULT_INJECTED', {
      accountId,
      protectionType: type,
      error: fault,
    });
  }
  private refreshProtection(accountId: string) {
    const a = this.account(accountId),
      p = a.positions[0];
    if (!p) return;
    const active = [...this.protection.values()]
      .map((item) => item.order)
      .filter(
        (o) =>
          o.accountId === accountId &&
          o.entryRequestId === p.entryRequestId &&
          o.status === 'ACTIVE',
      );
    p.protectionStatus =
      active.some((o) => o.type === 'STOP_LOSS') &&
      active.some((o) => o.type === 'TAKE_PROFIT')
        ? 'ACTIVE'
        : 'SUBMITTING';
    a.executionStatus = p.protectionStatus === 'ACTIVE' ? 'FILLED' : 'UNKNOWN';
    a.revision++;
  }
  private cancelProtection(order: ProtectionOrder) {
    if (order.status !== 'ACTIVE') return;
    order.status = 'CANCELED';
    const a = this.account(order.accountId),
      p = a.positions[0];
    if (p?.entryRequestId === order.entryRequestId) {
      p.protectionStatus = 'FAILED';
      a.executionStatus = 'UNKNOWN';
      a.revision++;
    }
    this.log('PROTECTION_CANCELED', {
      accountId: order.accountId,
      requestId: order.entryRequestId,
      orderId: order.orderId,
      protectionType: order.type,
    });
  }
  private cancelEntryProtection(accountId: string, entryRequestId: string) {
    for (const { order } of this.protection.values()) {
      if (
        order.accountId === accountId &&
        order.entryRequestId === entryRequestId
      )
        this.cancelProtection(order);
    }
  }
  async placeProtectionOrder(
    input: ProtectionRequest,
  ): Promise<ProtectionOrder> {
    this.ready();
    const request = protectionRequestSchema.parse(input);
    const fingerprint = createHash('sha256')
      .update(JSON.stringify(request))
      .digest('hex');
    const previous = this.protection.get(request.requestId);
    if (previous) {
      if (previous.fingerprint !== fingerprint)
        throw new Error('IDEMPOTENCY_CONFLICT');
      return structuredClone(previous.order);
    }
    const a = this.account(request.accountId),
      p = a.positions[0];
    const order: ProtectionOrder = {
      ...request,
      orderId: request.requestId,
      status: 'REJECTED',
      filledSize: '0',
      error: null,
    };
    const faultKey = `${request.accountId}:${request.type}`;
    const fault = this.protectionFaults.get(faultKey);
    this.protectionFaults.delete(faultKey);
    const duplicateType = [...this.protection.values()].some(
      (item) =>
        item.order.accountId === a.accountId &&
        item.order.entryRequestId === request.entryRequestId &&
        item.order.type === request.type,
    );
    const anchor = p
      ? new D(request.triggerPrice).minus(p.entryPrice).mul(direction(p.side))
      : new D(0);
    const market = new D(this.quote.price)
      .minus(request.triggerPrice)
      .mul(direction(request.positionSide));
    if (
      !p ||
      p.entryRequestId !== request.entryRequestId ||
      p.symbol !== request.symbol ||
      p.side !== request.positionSide ||
      !new D(p.quantity).eq(request.quantity) ||
      a.status !== 'ACTIVE' ||
      duplicateType ||
      (request.type === 'STOP_LOSS'
        ? anchor.gte(0) || market.lte(0)
        : anchor.lte(0) || market.gte(0))
    ) {
      order.error = 'INVALID_PROTECTION';
    } else if (fault === 'REJECT' || fault === 'TIMEOUT_BEFORE_CREATE') {
      p.protectionStatus = 'FAILED';
      a.executionStatus = 'UNKNOWN';
      a.revision++;
      if (fault === 'TIMEOUT_BEFORE_CREATE')
        throw new Error('SIMULATED_PROTECTION_TIMEOUT');
      order.error = 'SIMULATED_PROTECTION_REJECTION';
    } else order.status = 'ACTIVE';
    this.protection.set(order.orderId, { fingerprint, order });
    if (order.status === 'ACTIVE') this.refreshProtection(a.accountId);
    this.log(`PROTECTION_${order.status}`, {
      masterTradeId: request.masterTradeId,
      accountId: a.accountId,
      requestId: request.requestId,
      entryRequestId: request.entryRequestId,
      orderId: order.orderId,
      protectionType: order.type,
      triggerPrice: order.triggerPrice,
      requestedSize: order.quantity,
      reduceOnly: true,
      error: order.error,
    });
    if (fault === 'AMBIGUOUS_AFTER_CREATE' && order.status === 'ACTIVE')
      throw new Error('SIMULATED_PROTECTION_RESPONSE_LOST');
    return structuredClone(order);
  }
  async getProtectionOrder(accountId: string, orderId: string) {
    this.ready();
    this.account(accountId);
    const order = this.protection.get(orderId)?.order;
    return structuredClone(order?.accountId === accountId ? order : null);
  }
  async getOpenOrders(accountId: string) {
    this.ready();
    this.account(accountId);
    return structuredClone(
      [...this.protection.values()]
        .map((item) => item.order)
        .filter((o) => o.accountId === accountId && o.status === 'ACTIVE'),
    );
  }
  async cancelOrder(accountId: string, orderId: string) {
    this.ready();
    this.account(accountId);
    const order = this.protection.get(orderId)?.order;
    if (!order || order.accountId !== accountId)
      throw new Error('PROTECTION_NOT_FOUND');
    this.cancelProtection(order);
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
    if (qty.eq(p.quantity)) {
      a.positions = [];
      a.executionStatus = 'IDLE';
      this.cancelEntryProtection(a.accountId, p.entryRequestId);
      this.log('EXITED', {
        accountId: a.accountId,
        requestId: p.entryRequestId,
      });
    } else p.quantity = new D(p.quantity).minus(qty).toFixed();
    markAccount(a, this.quote.price, this.clock());
    this.log(a.status === 'BREACHED' ? 'BREACHED_CLOSE' : 'CLOSED', {
      accountId: a.accountId,
      requestId: p.entryRequestId,
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
    const a = this.account(id);
    // Also remove stale protection when the account is already flat.
    for (const item of this.protection.values()) {
      if (item.order.accountId === id && item.order.status === 'ACTIVE')
        this.cancelProtection(item.order);
    }
    this.close(a);
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
      if (a.status === 'BREACHED') {
        this.close(a);
        continue;
      }
      const active = [...this.protection.values()]
        .map((item) => item.order)
        .filter((o) => o.accountId === a.accountId && o.status === 'ACTIVE');
      for (const order of active) {
        const current = a.positions[0];
        // Reduce-only AND exact entry binding: old exits can never affect a later trade.
        if (
          !current ||
          current.entryRequestId !== order.entryRequestId ||
          current.side !== order.positionSide
        ) {
          this.cancelProtection(order);
          continue;
        }
        const trigger =
          order.type === 'STOP_LOSS'
            ? current.side === 'LONG'
              ? new D(price).lte(order.triggerPrice)
              : new D(price).gte(order.triggerPrice)
            : current.side === 'LONG'
              ? new D(price).gte(order.triggerPrice)
              : new D(price).lte(order.triggerPrice);
        if (trigger && order.status === 'ACTIVE') {
          const quantity = D.min(order.quantity, current.quantity).toFixed();
          order.status = 'FILLED';
          order.filledSize = quantity;
          this.log('PROTECTION_FILLED', {
            accountId: a.accountId,
            requestId: current.entryRequestId,
            orderId: order.orderId,
            protectionType: order.type,
            filledSize: quantity,
            reduceOnly: true,
          });
          this.close(a, quantity);
          // Explicit local sibling cancellation, not an assumed venue-native OCO feature.
          this.cancelEntryProtection(a.accountId, order.entryRequestId);
        }
      }
    }
    this.log('PRICE_APPLIED', { marketPrice: price });
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
