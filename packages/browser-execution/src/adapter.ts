import { createHash } from 'node:crypto';
import {
  D,
  isFresh,
  nonnegative,
  type Account,
  type ProtectionOrder,
  type ProtectionRequest,
  type Quote,
} from '../../core/src/index.ts';
import type {
  ExecutionAdapter,
  OrderRequest,
  OrderResult,
} from '../../execution/src/adapter.ts';
import { Journal } from '../../execution/src/journal.ts';
import {
  identitySchema,
  visibleBookSchema,
  type BrowserAccountIdentity,
  type BrowserAction,
  type BrowserDom,
  type BrowserSessionState,
  type VisibleBook,
} from './dom.ts';
const hash = (value: unknown) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** Fixture-only adapter. There is no configurable URL, login, live mode or production driver. */
export class BrowserExecutionAdapter implements ExecutionAdapter {
  readonly name = 'BrowserExecutionAdapter:LOCAL_FIXTURE';
  readonly mode = 'SIMULATION' as const;
  private state: BrowserSessionState = 'DISCONNECTED';
  private blocked = false;
  private quarantined = false;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly identities: readonly BrowserAccountIdentity[];
  private readonly timeoutMs: number;
  private readonly maxAgeMs: number;
  private fleet: {
    masterTradeId: string;
    reference: Quote;
    maxDrift: string;
    firstFill: string | null;
    lastFill: string | null;
    stop: boolean;
  } | null = null;
  private readonly metrics = {
    accountSwitchMs: 0,
    submitMs: 0,
    switches: 0,
    rejectedDrift: 0,
    timeouts: 0,
  };
  constructor(
    private readonly dom: BrowserDom,
    identities: readonly BrowserAccountIdentity[],
    private readonly journal: Journal,
    options: { timeoutMs?: number; maxAgeMs?: number } = {},
    private readonly clock: () => number = Date.now,
  ) {
    if (dom.environment !== 'LOCAL_FIXTURE')
      throw new Error('LIVE_BROWSER_DISABLED');
    this.identities = Object.freeze(
      identities.map((i) => Object.freeze(identitySchema.parse(i))),
    );
    if (
      !this.identities.length ||
      new Set(this.identities.map((i) => i.accountId)).size !==
        this.identities.length ||
      this.identities.some((i) => i.contextId !== dom.contextId)
    )
      throw new Error('INVALID_BROWSER_BINDINGS');
    this.timeoutMs = options.timeoutMs ?? 1500;
    this.maxAgeMs = options.maxAgeMs ?? 5000;
    if (
      ![this.timeoutMs, this.maxAgeMs].every(
        (v) => Number.isInteger(v) && v > 0,
      )
    )
      throw new Error('INVALID_BROWSER_TIMEOUT');
    if (this.timeoutMs > 3000)
      throw new Error('BROWSER_TIMEOUT_EXCEEDS_CONTROLLER_BUDGET');
  }
  health() {
    return {
      state: this.state,
      entriesBlocked: this.blocked,
      metrics: { ...this.metrics },
      firstToLastFillDriftPoints:
        this.fleet?.firstFill && this.fleet.lastFill
          ? new D(this.fleet.lastFill).minus(this.fleet.firstFill).toFixed()
          : null,
    };
  }
  private halt(state: 'UNCERTAIN' | 'RECOVERY_REQUIRED' = 'UNCERTAIN') {
    this.blocked = true;
    this.state = state;
    this.journal.halt();
  }
  private async timed<T>(operation: () => Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        operation(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            this.metrics.timeouts++;
            this.quarantined = true;
            this.blocked = true;
            this.state = 'UNCERTAIN';
            // Initiate quarantine before allowing another queued operation. No automatic click retry.
            void this.dom.quarantine().catch(() => {});
            reject(new Error('BROWSER_TIMEOUT'));
          }, this.timeoutMs);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
  private assertUsable() {
    if (this.quarantined) throw new Error('BROWSER_QUARANTINED');
  }
  private serialized<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn);
    this.queue = run.catch(() => {});
    return run;
  }
  private binding(id: string) {
    const value = this.identities.find((i) => i.accountId === id);
    if (!value) throw new Error('UNMAPPED_BROWSER_ACCOUNT');
    return value;
  }
  private async read(identity: BrowserAccountIdentity): Promise<VisibleBook> {
    this.assertUsable();
    await this.dom.assertLocalFixture();
    const book = visibleBookSchema.parse(await this.dom.readBook());
    this.assertUsable();
    if (
      book.identity.accountId !== identity.accountId ||
      book.identity.label !== identity.label ||
      book.identity.contextId !== identity.contextId ||
      book.account.accountId !== identity.accountId ||
      book.account.label !== identity.label
    )
      throw new Error('BROWSER_ACCOUNT_MISMATCH');
    if (!isFresh(book.observedAt, this.clock(), this.maxAgeMs))
      throw new Error('STALE_BROWSER_EVIDENCE');
    if (
      book.entries.some((e) => e.accountId !== identity.accountId) ||
      book.protection.some((p) => p.accountId !== identity.accountId) ||
      new Set(book.entries.map((e) => e.requestId)).size !==
        book.entries.length ||
      new Set(book.protection.map((p) => p.orderId)).size !==
        book.protection.length
    )
      throw new Error('AMBIGUOUS_BROWSER_BOOK');
    if (
      book.inventory.length !== this.identities.length ||
      this.identities.some(
        (i) =>
          book.inventory.filter(
            (a) => a.accountId === i.accountId && a.label === i.label,
          ).length !== 1,
      )
    )
      throw new Error('BROWSER_INVENTORY_MISMATCH');
    return book;
  }
  private withAccount<T>(
    id: string,
    operation: (
      book: VisibleBook,
      identity: BrowserAccountIdentity,
    ) => Promise<T>,
  ): Promise<T> {
    return this.serialized(async () => {
      this.assertUsable();
      if (['DISCONNECTED', 'CLOSED'].includes(this.state))
        throw new Error('BROWSER_DISCONNECTED');
      const identity = this.binding(id);
      try {
        return await this.timed(async () => {
          await this.dom.assertLocalFixture();
          this.assertUsable();
          this.state = 'SELECTING_ACCOUNT';
          const start = performance.now();
          await this.dom.selectAccount(identity);
          this.state = 'VERIFYING_ACCOUNT';
          const book = await this.read(identity);
          this.metrics.accountSwitchMs = performance.now() - start;
          this.metrics.switches++;
          this.journal.log({
            timestamp: this.clock(),
            masterTradeId: this.fleet?.masterTradeId ?? 'BROWSER_READ',
            accountId: id,
            status: 'BROWSER_ACCOUNT_VERIFIED',
            adapter: this.name,
            latency: this.metrics.accountSwitchMs,
          });
          const result = await operation(book, identity);
          this.state = this.blocked ? 'RECOVERY_REQUIRED' : 'READY';
          return result;
        });
      } catch {
        this.halt();
        throw new Error('BROWSER_EVIDENCE_UNCERTAIN');
      }
    });
  }
  async connect() {
    if (this.state !== 'DISCONNECTED')
      throw new Error('BROWSER_ALREADY_CONNECTED');
    await this.timed(() => this.dom.assertLocalFixture());
    this.blocked = this.journal.halted() || this.journal.hasBrowserActions();
    if (this.blocked) this.halt('RECOVERY_REQUIRED');
    else this.state = 'READY';
  }
  async disconnect() {
    this.blocked = true;
    await this.queue;
    await this.dom.close();
    this.state = 'CLOSED';
  }
  beginFleet(masterTradeId: string, reference: Quote, maxDrift: string) {
    if (this.blocked || this.state !== 'READY' || this.fleet)
      throw new Error('BROWSER_ENTRIES_BLOCKED');
    this.fleet = {
      masterTradeId,
      reference: structuredClone(reference),
      maxDrift: nonnegative.parse(maxDrift),
      firstFill: null,
      lastFill: null,
      stop: false,
    };
  }
  endFleet() {
    this.fleet = null;
  }
  listAccounts(): Promise<Account[]> {
    return this.withAccount(
      this.identities[0]!.accountId,
      async (b) => b.inventory,
    );
  }
  getAccountState(id: string) {
    return this.withAccount(id, async (b) => b.account);
  }
  getQuote() {
    return this.withAccount(
      this.identities[0]!.accountId,
      async (b) => b.quote,
    );
  }
  private drift(price: string) {
    if (!this.fleet) return true;
    return new D(price)
      .minus(this.fleet.reference.price)
      .abs()
      .gt(this.fleet.maxDrift);
  }
  private async dispatch(
    action: BrowserAction,
    id: string,
    identity: BrowserAccountIdentity,
    expected?: VisibleBook,
  ): Promise<VisibleBook> {
    // The fingerprint contains no cookies, auth state, or raw DOM. Persist before every possible write.
    if (!this.journal.claimBrowserAction(id, hash(action), identity.accountId))
      return this.read(identity);
    this.assertUsable();
    await this.dom.prepare(action);
    if (hash(await this.dom.readPrepared()) !== hash(action))
      throw new Error('BROWSER_FORM_MISMATCH');
    const before = await this.read(identity); // Verify context again AFTER filling controls.
    if (action.kind === 'ENTRY') {
      if (this.blocked || !this.fleet)
        throw new Error('BROWSER_ENTRIES_BLOCKED');
      if (!expected || hash(before.account) !== hash(expected.account))
        throw new Error('BROWSER_ACCOUNT_CHANGED_DURING_FORM');
      if (
        !isFresh(before.quote.timestamp, this.clock(), this.maxAgeMs) ||
        this.drift(before.quote.price)
      )
        throw new Error('FLEET_PRICE_DRIFT');
    }
    this.assertUsable();
    this.state = 'SUBMITTING';
    const start = performance.now();
    await this.dom.submitPrepared();
    this.metrics.submitMs = performance.now() - start;
    this.journal.log({
      timestamp: this.clock(),
      masterTradeId: this.fleet?.masterTradeId ?? 'BROWSER_CLEANUP',
      accountId: identity.accountId,
      requestId: id,
      status: 'BROWSER_SUBMIT_RETURNED',
      adapter: this.name,
      latency: this.metrics.submitMs,
    });
    return this.read(identity);
  }
  placeOrder(order: OrderRequest): Promise<OrderResult> {
    return this.withAccount(order.accountId, async (book, identity) => {
      if (
        this.blocked ||
        !this.fleet ||
        this.fleet.masterTradeId !== order.masterTradeId
      )
        throw new Error('BROWSER_ENTRIES_BLOCKED');
      if (this.fleet.stop || this.drift(book.quote.price)) {
        this.fleet.stop = true;
        this.metrics.rejectedDrift++;
        const rejected: OrderResult = {
          requestId: order.requestId,
          accountId: order.accountId,
          status: 'REJECTED',
          filledSize: '0',
          entryPrice: null,
          fees: '0',
          error: 'FLEET_PRICE_DRIFT',
        };
        // Local no-submit result is kept distinct from a venue acknowledgment.
        this.rejections.set(order.requestId, rejected);
        return rejected;
      }
      const after = await this.dispatch(
        { kind: 'ENTRY', accountId: order.accountId, order },
        `entry:${order.requestId}`,
        identity,
        book,
      );
      const result = after.entries.find((e) => e.requestId === order.requestId);
      if (!result) throw new Error('ENTRY_VISIBLE_EVIDENCE_MISSING');
      this.journal.confirmBrowserAction(`entry:${order.requestId}`);
      this.recordFill(result);
      return result;
    });
  }
  private rejections = new Map<string, OrderResult>();
  private recordFill(result: OrderResult) {
    if (this.fleet && result.entryPrice && new D(result.filledSize).gt(0)) {
      this.fleet.firstFill ??= result.entryPrice;
      this.fleet.lastFill = result.entryPrice;
      if (this.drift(result.entryPrice)) this.fleet.stop = true; // Protect this fill; stop later entries.
    }
  }
  getOrder(requestId: string): Promise<OrderResult | null> {
    const rejected = this.rejections.get(requestId);
    if (rejected) return Promise.resolve(structuredClone(rejected));
    const id = this.journal.browserActionAccount(`entry:${requestId}`);
    if (!id) return Promise.resolve(null);
    return this.withAccount(id, async (b) => {
      const result = b.entries.find((e) => e.requestId === requestId) ?? null;
      if (result) this.recordFill(result);
      return result;
    });
  }
  placeProtectionOrder(order: ProtectionRequest): Promise<ProtectionOrder> {
    return this.withAccount(order.accountId, async (_, identity) => {
      const b = await this.dispatch(
        { kind: 'PROTECTION', accountId: order.accountId, order },
        `protection:${order.requestId}`,
        identity,
      );
      const result = b.protection.find((p) => p.requestId === order.requestId);
      if (!result) throw new Error('PROTECTION_VISIBLE_EVIDENCE_MISSING');
      this.journal.confirmBrowserAction(`protection:${order.requestId}`);
      return result;
    });
  }
  getProtectionOrder(id: string, orderId: string) {
    return this.withAccount(
      id,
      async (b) => b.protection.find((p) => p.orderId === orderId) ?? null,
    );
  }
  getOpenOrders(id: string) {
    return this.withAccount(id, async (b) =>
      b.protection.filter((p) => p.status === 'ACTIVE'),
    );
  }
  cancelOrder(id: string, orderId: string): Promise<void> {
    return this.withAccount(id, async (b, identity) => {
      const current = b.protection.find((p) => p.orderId === orderId);
      if (!current) throw new Error('CANCEL_ORDER_UNKNOWN');
      if (current.status !== 'ACTIVE') return;
      const after = await this.dispatch(
        { kind: 'CANCEL', accountId: id, orderId },
        `cancel:${id}:${orderId}`,
        identity,
      );
      if (
        !after.protection.some(
          (p) =>
            p.orderId === orderId && ['CANCELED', 'FILLED'].includes(p.status),
        )
      )
        throw new Error('CANCEL_UNCONFIRMED');
      this.journal.confirmBrowserAction(`cancel:${id}:${orderId}`);
    });
  }
  flattenAccount(id: string): Promise<void> {
    return this.withAccount(id, async (b, identity) => {
      if (
        !b.account.positions.length &&
        !b.protection.some((p) => p.status === 'ACTIVE')
      )
        return;
      const entryRequestId = b.account.positions[0]?.entryRequestId ?? null;
      const key = `flatten:${id}:${hash([
        entryRequestId,
        b.protection
          .filter((p) => p.status === 'ACTIVE')
          .map((p) => p.orderId)
          .sort(),
      ])}`;
      const after = await this.dispatch(
        { kind: 'FLATTEN', accountId: id, entryRequestId },
        key,
        identity,
      );
      if (
        after.account.positions.length ||
        after.protection.some((p) => p.status === 'ACTIVE')
      )
        throw new Error('FLATTEN_UNCONFIRMED');
      this.journal.confirmBrowserAction(key);
    });
  }
}
