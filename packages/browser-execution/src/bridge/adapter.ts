import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { isFresh, type ProtectionRequest } from '../../../core/src/index.ts';
import type {
  ExecutionAdapter,
  OrderRequest,
} from '../../../execution/src/adapter.ts';
import { Journal } from '../../../execution/src/journal.ts';
import {
  bridgePayloadSchemas,
  bridgeMessageBytes,
  bridgeResponseSchema,
  bridgeResultSchemas,
  MAX_BRIDGE_MESSAGE_BYTES,
  parseMessage,
  type BridgeOperation,
  type BridgePayload,
  type BridgeResult,
  type OfflineBridgePort,
} from './protocol.ts';

const hash = (value: unknown) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** Protocol prototype. FleetController remains the only execution owner. */
export class OfflineBridgeExecutionAdapter implements ExecutionAdapter {
  readonly name = 'OfflineBridgeExecutionAdapter:OFFLINE_FIXTURE';
  readonly mode = 'SIMULATION' as const;
  private state: 'DISCONNECTED' | 'CONNECTED' | 'QUARANTINED' | 'CLOSED' =
    'DISCONNECTED';
  private readonly sessionId: string;
  private readonly recoveredHalt: boolean;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly timeoutMs: number;
  private readonly maxAgeMs: number;
  constructor(
    private readonly port: OfflineBridgePort,
    private readonly journal: Journal,
    options: { timeoutMs?: number; maxAgeMs?: number } = {},
    private readonly clock: () => number = Date.now,
  ) {
    if (port.environment !== 'OFFLINE_FIXTURE')
      throw new Error('LIVE_BRIDGE_DISABLED');
    this.sessionId = z.string().uuid().parse(port.sessionId);
    this.recoveredHalt = journal.halted();
    this.timeoutMs = options.timeoutMs ?? 500;
    this.maxAgeMs = options.maxAgeMs ?? 5000;
    if (
      ![this.timeoutMs, this.maxAgeMs].every(
        (value) => Number.isSafeInteger(value) && value > 0,
      )
    )
      throw new Error('INVALID_BRIDGE_BUDGET');
  }
  status() {
    return this.state;
  }
  private assertUsable(connecting = false) {
    if (
      this.port.environment !== 'OFFLINE_FIXTURE' ||
      this.port.sessionId !== this.sessionId
    )
      throw new Error('BRIDGE_SESSION_CHANGED');
    if (
      this.state !== 'CONNECTED' &&
      !(connecting && this.state === 'DISCONNECTED')
    )
      throw new Error('BRIDGE_UNAVAILABLE');
  }
  private quarantine() {
    this.state = 'QUARANTINED';
    try {
      this.journal.halt();
    } finally {
      void this.port.quarantine().catch(() => {});
    }
  }
  private serialized<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.queue.then(operation);
    this.queue = run.catch(() => {});
    return run;
  }
  private async rpc<K extends BridgeOperation>(
    operation: K,
    input: BridgePayload<K>,
  ): Promise<BridgeResult<K>> {
    this.assertUsable(operation === 'CONNECT');
    // Validation happens before dispatch. Exceptions never include rejected data.
    const payload = bridgePayloadSchemas[operation].safeParse(input);
    if (!payload.success) throw new Error('INVALID_BRIDGE_COMMAND');
    const request = {
      version: 1 as const,
      environment: 'OFFLINE_FIXTURE' as const,
      sessionId: this.sessionId,
      messageId: randomUUID(),
      operation,
      payload: payload.data,
    };
    const message = JSON.stringify(request);
    if (bridgeMessageBytes(message) > MAX_BRIDGE_MESSAGE_BYTES)
      throw new Error('BRIDGE_MESSAGE_TOO_LARGE');
    let timer: ReturnType<typeof setTimeout> | undefined;
    const startedAt = this.clock();
    try {
      const wire = await Promise.race([
        this.port.exchange(message),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error('BRIDGE_TIMEOUT')),
            this.timeoutMs,
          );
        }),
      ]);
      this.assertUsable(operation === 'CONNECT');
      const response = bridgeResponseSchema.parse(parseMessage(wire));
      if (
        response.sessionId !== request.sessionId ||
        response.messageId !== request.messageId ||
        response.operation !== operation
      )
        throw new Error('BRIDGE_RESPONSE_MISMATCH');
      if (
        response.capturedAt < startedAt ||
        !isFresh(response.capturedAt, this.clock(), this.maxAgeMs)
      )
        throw new Error('STALE_BRIDGE_RESPONSE');
      return bridgeResultSchemas[operation].parse(
        response.result,
      ) as BridgeResult<K>;
    } catch {
      this.quarantine();
      throw new Error('BRIDGE_EXCHANGE_UNCONFIRMED');
    } finally {
      clearTimeout(timer);
    }
  }
  async connect() {
    return this.serialized(async () => {
      if (this.state === 'CONNECTED') {
        this.assertUsable();
        return;
      }
      await this.rpc('CONNECT', {});
      this.state = 'CONNECTED';
    });
  }
  async disconnect() {
    this.state = 'CLOSED';
    await this.port.close();
  }
  private check(condition: boolean) {
    if (!condition) {
      this.quarantine();
      throw new Error('BRIDGE_EVIDENCE_MISMATCH');
    }
  }
  listAccounts() {
    return this.serialized(async () => {
      const accounts = await this.rpc('LIST_ACCOUNTS', {});
      this.check(
        new Set(accounts.map((account) => account.accountId)).size ===
          accounts.length,
      );
      return accounts;
    });
  }
  private async account(accountId: string) {
    const account = await this.rpc('ACCOUNT', { accountId });
    this.check(account.accountId === accountId);
    return account;
  }
  getAccountState(accountId: string) {
    return this.serialized(() => this.account(accountId));
  }
  getQuote() {
    return this.serialized(() => this.rpc('QUOTE', {}));
  }
  private claim(key: string, accountId: string, payload: unknown) {
    this.assertUsable();
    // Existing claims may only be inspected. Changing cleanup books cannot create
    // a new attempt while an earlier flatten for this account remains unresolved.
    if (!this.journal.browserActionAccount(key)) {
      if (
        key.startsWith('bridge:entry:') &&
        (this.recoveredHalt ||
          this.journal.hasUnresolvedBrowserAction(accountId, 'bridge:entry:'))
      )
        throw new Error('BRIDGE_ENTRIES_HALTED');
      const prefix = key.startsWith('bridge:flatten:')
        ? 'bridge:flatten:'
        : key.startsWith('bridge:protection:')
          ? 'bridge:protection:'
          : null;
      if (prefix && this.journal.hasUnresolvedBrowserAction(accountId, prefix))
        throw new Error('BRIDGE_UNRESOLVED_MUTATION');
    }
    return this.journal.claimBrowserAction(key, hash(payload), accountId);
  }
  private async order(requestId: string, accountId: string) {
    const result = await this.rpc('ORDER', { requestId, accountId });
    if (result)
      this.check(
        result.requestId === requestId && result.accountId === accountId,
      );
    return result;
  }
  placeOrder(input: OrderRequest) {
    // Snapshot and strictly validate caller input before it waits in the queue.
    const parsed = bridgePayloadSchemas.ENTRY.safeParse(input);
    if (!parsed.success)
      return Promise.reject(new Error('INVALID_BRIDGE_COMMAND'));
    const order = parsed.data;
    return this.serialized(async () => {
      const key = `bridge:entry:${order.requestId}`;
      const result = this.claim(key, order.accountId, order)
        ? await this.rpc('ENTRY', order)
        : await this.order(order.requestId, order.accountId);
      this.check(
        result !== null &&
          result.requestId === order.requestId &&
          result.accountId === order.accountId,
      );
      if (!result) throw new Error('BRIDGE_ENTRY_UNKNOWN');
      if (result.status !== 'UNKNOWN') this.journal.confirmBrowserAction(key);
      return result;
    });
  }
  getOrder(requestId: string) {
    return this.serialized(async () => {
      const accountId = this.journal.browserActionAccount(
        `bridge:entry:${requestId}`,
      );
      if (!accountId) return null;
      return this.order(requestId, accountId);
    });
  }
  private async protection(accountId: string, orderId: string) {
    const order = await this.rpc('PROTECTION_ORDER', { accountId, orderId });
    if (order)
      this.check(order.accountId === accountId && order.orderId === orderId);
    return order;
  }
  placeProtectionOrder(input: ProtectionRequest) {
    const parsed = bridgePayloadSchemas.PROTECTION.safeParse(input);
    if (!parsed.success)
      return Promise.reject(new Error('INVALID_BRIDGE_COMMAND'));
    const request = parsed.data;
    return this.serialized(async () => {
      const key = `bridge:protection:${request.requestId}`;
      const order = this.claim(key, request.accountId, request)
        ? await this.rpc('PROTECTION', request)
        : await this.protection(request.accountId, request.requestId);
      this.check(
        order !== null &&
          order.accountId === request.accountId &&
          order.requestId === request.requestId &&
          order.orderId === request.requestId,
      );
      if (!order) throw new Error('BRIDGE_PROTECTION_UNKNOWN');
      this.journal.confirmBrowserAction(key);
      return order;
    });
  }
  getProtectionOrder(accountId: string, orderId: string) {
    return this.serialized(() => this.protection(accountId, orderId));
  }
  private async openOrders(accountId: string) {
    const orders = await this.rpc('OPEN_ORDERS', { accountId });
    this.check(
      orders.every(
        (order) => order.accountId === accountId && order.status === 'ACTIVE',
      ) && new Set(orders.map((order) => order.orderId)).size === orders.length,
    );
    return orders;
  }
  getOpenOrders(accountId: string) {
    return this.serialized(() => this.openOrders(accountId));
  }
  cancelOrder(accountId: string, orderId: string) {
    return this.serialized(async () => {
      const key = `bridge:cancel:${accountId}:${orderId}`;
      const before = await this.protection(accountId, orderId);
      this.check(before !== null);
      if (before?.status === 'CANCELED' || before?.status === 'FILLED') return;
      if (this.claim(key, accountId, { accountId, orderId }))
        await this.rpc('CANCEL', { accountId, orderId });
      const after = await this.protection(accountId, orderId);
      this.check(after?.status === 'CANCELED' || after?.status === 'FILLED');
      this.check(
        !(await this.openOrders(accountId)).some(
          (order) => order.orderId === orderId,
        ),
      );
      this.journal.confirmBrowserAction(key);
    });
  }
  flattenAccount(accountId: string) {
    return this.serialized(async () => {
      const before = await this.account(accountId);
      const orders = await this.openOrders(accountId);
      if (!before.positions.length && !orders.length) {
        if (this.journal.hasUnresolvedBrowserAction(accountId, 'bridge:'))
          throw new Error('BRIDGE_UNRESOLVED_MUTATION');
        return;
      }
      const identity = {
        accountId,
        entryRequestId: before.positions[0]?.entryRequestId ?? null,
        protectionIds: orders.map((order) => order.orderId).sort(),
      };
      const key = `bridge:flatten:${accountId}:${hash(identity)}`;
      if (this.claim(key, accountId, identity))
        await this.rpc('FLATTEN', { accountId });
      this.check(
        !(await this.account(accountId)).positions.length &&
          !(await this.openOrders(accountId)).length,
      );
      this.journal.confirmBrowserAction(key);
    });
  }
}
