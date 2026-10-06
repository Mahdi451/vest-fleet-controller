import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  D,
  protectionOrderSchema,
  type Account,
  type ProtectionOrder,
} from '../../core/src/index.ts';
import { copierHash, followerCommandId } from './copier-events.ts';
import {
  parseOwnedRepairIntent,
  type OwnedRepairIntent,
  type OwnedRepairRecord,
} from './copier-owned-repairs.ts';
import {
  ownedMutationRequestSchema,
  ownedMutationReceiptSchema,
  type OwnedMutationRequest,
  type OwnedMutationCapabilities,
} from './owned-mutation-contract.ts';
import type { OwnedRoot } from './copier-mutations.ts';
import type { OwnedExecutionContext } from './owned-event-executor.ts';
type Read = <T>(run: () => Promise<T>) => Promise<T>;
/** Operator actions use their own durable origin; they never enter the leader stream. */
export class OwnedRepairExecutor {
  constructor(private c: OwnedExecutionContext) {}
  private provider() {
    const adapter = this.c.adapter as typeof this.c.adapter &
      OwnedMutationCapabilities;
    if (
      typeof adapter.closeOwnedPosition !== 'function' ||
      typeof adapter.changeOwnedProtection !== 'function' ||
      typeof adapter.readOwnedMutation !== 'function'
    )
      throw new Error('OWNED_REPAIR_UNSUPPORTED');
    return adapter;
  }
  async repair(input: OwnedRepairIntent) {
    const intent = parseOwnedRepairIntent(input),
      c = this.c;
    const replay = c.journal.ownedRepairs.replay(intent);
    if (replay) return replay;
    const armed = c.policy(),
      root = c.journal.mutations.root(intent.rootId);
    if (!root) throw new Error('OWNED_REPAIR_ROOT_MISSING');
    if (
      !armed.value.followerAccountIds.includes(root.accountId) ||
      armed.value.symbol !== root.symbol
    )
      throw new Error('OWNED_REPAIR_ENVELOPE_MISMATCH');
    const claim = c.journal.ownedRepairs.claim(
      intent,
      root.accountId,
      c.generation,
      c.now(),
    );
    if (!claim.fresh) return claim.record;
    return c.queue(root.accountId, (read) =>
      this.run(claim.record, armed, read),
    );
  }
  private root(record: OwnedRepairRecord) {
    const root = this.c.journal.mutations.root(record.intent.rootId);
    if (!root || root.accountId !== record.accountId)
      return this.c.fail('ACCOUNT_MAPPING_CORRUPT');
    return root;
  }
  private pending(root: OwnedRoot, except: string) {
    const reservation = this.c.journal.mutations.reservation(root.rootId);
    if (reservation && reservation.commandId !== except) return true;
    return (
      this.c.journal.mutations
        .records(root.rootId)
        .some((row) => ['DISPATCHING', 'UNKNOWN'].includes(row.state)) ||
      this.c.journal.ownedRepairs
        .records(root.rootId)
        .some(
          (row) =>
            row.operationId !== except &&
            ['DISPATCHING', 'UNKNOWN'].includes(row.state),
        )
    );
  }
  private owned(root: OwnedRoot, account: Account) {
    const p = account.positions[0];
    return (
      account.positions.length === 1 &&
      p &&
      p.entryRequestId === root.entryRequestId &&
      p.symbol === root.symbol &&
      p.side === root.side &&
      new D(p.quantity).eq(root.quantity) &&
      new D(p.entryPrice).eq(root.basis!) &&
      new D(p.leverage).eq(root.leverage)
    );
  }
  private exits(root: OwnedRoot, orders: ProtectionOrder[], quantity: string) {
    if (
      orders.some(
        (o) =>
          o.accountId !== root.accountId ||
          o.entryRequestId !== root.entryRequestId ||
          o.symbol !== root.symbol ||
          o.positionSide !== root.side ||
          o.status !== 'ACTIVE' ||
          !new D(o.filledSize).isZero() ||
          !new D(o.quantity).eq(quantity) ||
          o.error !== null,
      ) ||
      orders.filter((o) => o.type === 'STOP_LOSS').length > 1 ||
      orders.filter((o) => o.type === 'TAKE_PROFIT').length > 1
    )
      return this.c.fail('ACCOUNT_MAPPING_CORRUPT');
  }
  private async facts(root: OwnedRoot, read: Read) {
    const account = (await read(() => this.c.fleet())).find(
      (a) => a.accountId === root.accountId,
    )!;
    if (!account) return this.c.fail('ACCOUNT_MAPPING_CORRUPT');
    if (account.revision < root.providerRevision)
      throw new Error('OWNED_REPAIR_STALE_EVIDENCE');
    const parsed = z
      .array(protectionOrderSchema)
      .safeParse(
        await read(() => this.c.adapter.getOpenOrders(root.accountId)),
      );
    if (!parsed.success) return this.c.fail('ACCOUNT_MAPPING_CORRUPT');
    return { account, orders: parsed.data };
  }
  private async run(
    record: OwnedRepairRecord,
    armed: ReturnType<OwnedExecutionContext['policy']>,
    read: Read,
  ): Promise<OwnedRepairRecord> {
    const c = this.c;
    let sent = false;
    try {
      c.active(armed.revision);
      if (!c.available(record.accountId))
        throw new Error('OWNED_REPAIR_CONTEXT_UNAVAILABLE');
      const root = this.root(record);
      if (root.revision !== record.intent.expectedRootRevision)
        throw new Error('OWNED_REPAIR_STALE_REVISION');
      if (
        root.closed ||
        root.certainty !== 'PRESENT' ||
        this.pending(root, record.operationId)
      )
        throw new Error('OWNED_REPAIR_RECONCILIATION_REQUIRED');
      const { account, orders } = await this.facts(root, read);
      if (!this.owned(root, account)) {
        c.journal.mutations.updateRoot(root.rootId, root.revision, {
          certainty: 'UNKNOWN',
          updatedAt: c.now(),
        });
        throw new Error('OWNED_REPAIR_OWNERSHIP_UNPROVEN');
      }
      this.exits(root, orders, root.quantity);
      const type =
        record.intent.operation === 'ADD_STOP' ? 'STOP_LOSS' : 'TAKE_PROFIT';
      if (
        record.intent.operation !== 'FLATTEN' &&
        orders.some((o) => o.type === type)
      )
        throw new Error('OWNED_REPAIR_PROTECTION_ALREADY_PRESENT');
      if (
        record.intent.operation !== 'FLATTEN' &&
        new D(root.leverage).gt(armed.value.maxLeverage)
      )
        throw new Error('OWNED_REPAIR_RISK_REFUSED');
      const request = ownedMutationRequestSchema.parse({
        environment: 'OFFLINE_FIXTURE',
        evidence: 'SYNTHETIC',
        requestId: record.operationId,
        eventId: root.entryEventId,
        rootKey: root.rootKey,
        accountId: root.accountId,
        entryRequestId: root.entryRequestId,
        symbol: root.symbol,
        side: root.side,
        sequence: root.lastEconomicSequence,
        operator: {
          operationId: record.operationId,
          expectedRootRevision: record.intent.expectedRootRevision,
          action: record.intent.operation,
        },
        expectedRevision: account.revision,
        expectedQuantity: root.quantity,
        expectedBasis: root.basis,
        leverage: root.leverage,
        maxNotional: armed.value.maxNotionalPerAccount,
        maxPlannedLoss: armed.value.maxPlannedLossPerAccount,
        operation:
          record.intent.operation === 'FLATTEN'
            ? 'CLOSE'
            : record.intent.operation === 'ADD_STOP'
              ? 'STOP_CHANGED'
              : 'TARGET_CHANGED',
        ...('price' in record.intent ? { price: record.intent.price } : {}),
      });
      c.active(armed.revision);
      if (!c.available(root.accountId))
        throw new Error('OWNED_REPAIR_CONTEXT_UNAVAILABLE');
      if (
        this.root(record).revision !== root.revision ||
        this.pending(root, record.operationId)
      )
        throw new Error('OWNED_REPAIR_STALE_REVISION');
      record = c.journal.ownedRepairs.transition(
        record.operationId,
        'QUEUED',
        'DISPATCHING',
        c.now(),
        request,
      );
      sent = true;
      const provider = this.provider(),
        receipt = await read(() =>
          request.operation === 'CLOSE'
            ? provider.closeOwnedPosition(request)
            : provider.changeOwnedProtection(
                request as OwnedMutationRequest & {
                  operation: 'STOP_CHANGED' | 'TARGET_CHANGED';
                },
              ),
        );
      return await this.verify(record, receipt, read);
    } catch (error) {
      if (
        error instanceof Error &&
        /STORAGE|STATE_CONFLICT|REVISION_CONFLICT|IDENTITY_CONFLICT/.test(
          error.message,
        )
      )
        return c.fail('JOURNAL_INTEGRITY_LOST');
      const current = c.journal.ownedRepairs.get(record.operationId)!;
      if (!['QUEUED', 'DISPATCHING'].includes(current.state)) return current;
      const reason =
        error instanceof Error && /^[A-Z_]{1,80}$/.test(error.message)
          ? error.message
          : 'OWNED_REPAIR_UNPROVEN';
      if (!sent)
        return c.journal.ownedRepairs.transition(
          record.operationId,
          'QUEUED',
          'REFUSED',
          c.now(),
          null,
          reason,
        );
      const root = this.root(record);
      return c.journal.ownedRepairs.settle(
        record.operationId,
        'DISPATCHING',
        'UNKNOWN',
        c.now(),
        null,
        root.revision,
        { certainty: 'UNKNOWN' },
        reason,
      );
    }
  }
  private async verify(record: OwnedRepairRecord, input: unknown, read: Read) {
    const c = this.c,
      request = record.request!,
      parsed = ownedMutationReceiptSchema.safeParse(input);
    if (!parsed.success) return c.fail('ACCOUNT_MAPPING_CORRUPT');
    const receipt = parsed.data;
    for (const field of [
      'requestId',
      'eventId',
      'rootKey',
      'accountId',
      'entryRequestId',
      'symbol',
      'side',
      'sequence',
      'operation',
    ] as const)
      if (receipt[field] !== request[field])
        return c.fail('ACCOUNT_MAPPING_CORRUPT');
    if (
      receipt.requestHash !== copierHash(request) ||
      copierHash(receipt.operator) !== copierHash(request.operator)
    )
      return c.fail('ACCOUNT_MAPPING_CORRUPT');
    let root = this.root(record);
    if (receipt.status === 'UNKNOWN')
      return c.journal.ownedRepairs.settle(
        record.operationId,
        record.state,
        'UNKNOWN',
        c.now(),
        receipt,
        root.revision,
        { certainty: 'UNKNOWN' },
        'PROVIDER_UNCERTAIN',
      );
    const { account, orders } = await this.facts(root, read);
    if (receipt.status === 'REJECTED') {
      const unchanged = !!this.owned(root, account);
      if (unchanged) this.exits(root, orders, root.quantity);
      const stop = orders.find((o) => o.type === 'STOP_LOSS'),
        target = orders.find((o) => o.type === 'TAKE_PROFIT');
      return c.journal.ownedRepairs.settle(
        record.operationId,
        record.state,
        'REJECTED',
        c.now(),
        receipt,
        root.revision,
        {
          certainty: unchanged ? 'PRESENT' : 'UNKNOWN',
          ...(unchanged
            ? {
                providerRevision: account.revision,
                stopPrice: stop?.triggerPrice ?? null,
                targetPrice: target?.triggerPrice ?? null,
                stopId: stop?.orderId ?? null,
                targetId: target?.orderId ?? null,
              }
            : {}),
        },
        receipt.reason,
      );
    }
    if (
      receipt.status !== 'VERIFIED' ||
      !new D(receipt.before.quantity).eq(request.expectedQuantity) ||
      !new D(receipt.before.basis ?? 0).eq(request.expectedBasis) ||
      receipt.before.revision !== request.expectedRevision ||
      receipt.after.revision <= receipt.before.revision
    )
      return c.fail('ACCOUNT_MAPPING_CORRUPT');
    const flat = request.operation === 'CLOSE';
    if (flat) {
      if (
        !new D(receipt.after.quantity).isZero() ||
        receipt.after.basis !== null ||
        !new D(receipt.executedQuantity).eq(request.expectedQuantity) ||
        account.positions.length ||
        orders.length
      )
        throw new Error('OWNED_REPAIR_EXIT_UNVERIFIED');
    } else {
      if (
        !new D(receipt.after.quantity).eq(request.expectedQuantity) ||
        !new D(receipt.executedQuantity).isZero() ||
        receipt.after.basis !== receipt.before.basis ||
        !this.owned(root, account)
      )
        throw new Error('OWNED_REPAIR_PROTECTION_UNVERIFIED');
      this.exits(root, orders, root.quantity);
      const exit = orders.find(
        (o) =>
          o.type ===
          (request.operation === 'STOP_CHANGED' ? 'STOP_LOSS' : 'TAKE_PROFIT'),
      );
      if (
        !exit ||
        !new D(exit.triggerPrice).eq('price' in request ? request.price : 0)
      )
        throw new Error('OWNED_REPAIR_PROTECTION_UNVERIFIED');
    }
    if (account.revision < receipt.after.revision)
      throw new Error('OWNED_REPAIR_STALE_EVIDENCE');
    root = this.root(record);
    const stop = orders.find((o) => o.type === 'STOP_LOSS'),
      target = orders.find((o) => o.type === 'TAKE_PROFIT');
    const settled = c.journal.ownedRepairs.settle(
      record.operationId,
      record.state,
      'VERIFIED',
      c.now(),
      receipt,
      root.revision,
      {
        quantity: receipt.after.quantity,
        basis: receipt.after.basis,
        providerRevision: account.revision,
        certainty: flat ? 'ABSENT' : 'PRESENT',
        closed: flat,
        stopPrice: stop?.triggerPrice ?? null,
        targetPrice: target?.triggerPrice ?? null,
        stopId: stop?.orderId ?? null,
        targetId: target?.orderId ?? null,
      },
      !flat && !stop ? 'SL_MISSING' : !flat && !target ? 'TP_MISSING' : null,
    );
    if (flat) this.closeEntry(root);
    return settled;
  }
  private closeEntry(root: OwnedRoot) {
    const attempt = this.c.journal.copier
      .followerAttempts(followerCommandId(root.entryEventId, root.accountId))
      .at(-1);
    if (!attempt || attempt.terminal?.result !== 'FILLED') return;
    this.c.journal.copier.recordAttemptObservation(
      attempt.attemptId,
      attempt.revision,
      {
        observationId: randomUUID(),
        observedAt: this.c.now(),
        outcome: {
          ...attempt.outcome,
          exposure: 'ABSENT',
          stop: 'NOT_REQUIRED',
          target: 'NOT_REQUIRED',
          stopPrice: undefined,
          targetPrice: undefined,
          reason: 'EXIT_VERIFIED',
        },
        terminal: {
          ...attempt.terminal,
          result: 'EXITED',
          observedAt: this.c.now(),
        },
      },
    );
  }
  async reconcileRoot(rootId: string) {
    const c = this.c,
      initial = c.journal.mutations.root(rootId);
    if (!initial) throw new Error('OWNED_REPAIR_ROOT_MISSING');
    return c.queue(initial.accountId, async (read) => {
      const root = c.journal.mutations.root(rootId)!;
      if (this.pending(root, ''))
        throw new Error('OWNED_REPAIR_RECONCILIATION_REQUIRED');
      const { account, orders } = await this.facts(root, read);
      const flat = account.positions.length === 0 && orders.length === 0;
      if (!flat && !this.owned(root, account)) {
        c.journal.mutations.reconcileIdleRoot(rootId, root.revision, {
          certainty: 'UNKNOWN',
          updatedAt: c.now(),
        });
        throw new Error('OWNED_REPAIR_OWNERSHIP_UNPROVEN');
      }
      if (!flat) this.exits(root, orders, root.quantity);
      const stop = orders.find((o) => o.type === 'STOP_LOSS'),
        target = orders.find((o) => o.type === 'TAKE_PROFIT');
      const changes = {
        quantity: flat ? '0' : root.quantity,
        basis: flat ? null : root.basis,
        providerRevision: account.revision,
        certainty: flat ? ('ABSENT' as const) : ('PRESENT' as const),
        closed: flat,
        stopPrice: stop?.triggerPrice ?? null,
        targetPrice: target?.triggerPrice ?? null,
        stopId: stop?.orderId ?? null,
        targetId: target?.orderId ?? null,
      };
      const changed = Object.entries(changes).some(
        ([key, value]) => root[key as keyof typeof changes] !== value,
      );
      const result = c.journal.mutations.reconcileIdleRoot(
        rootId,
        root.revision,
        changed ? { ...changes, updatedAt: c.now() } : null,
      );
      if (flat) this.closeEntry(result);
      return result;
    });
  }
  async reconcile(operationId: string) {
    const record = this.c.journal.ownedRepairs.get(operationId);
    if (!record) throw new Error('OWNED_REPAIR_MISSING');
    return this.c.queue(record.accountId, async (read) => {
      const current = this.c.journal.ownedRepairs.get(operationId)!;
      if (
        !['DISPATCHING', 'UNKNOWN'].includes(current.state) ||
        !current.request
      )
        return current;
      const receipt = await read(() =>
        this.provider().readOwnedMutation(operationId),
      );
      if (!receipt) return current;
      try {
        return await this.verify(current, receipt, read);
      } catch (error) {
        if (
          error instanceof Error &&
          /STORAGE|STATE_CONFLICT|REVISION_CONFLICT/.test(error.message)
        )
          return this.c.fail('JOURNAL_INTEGRITY_LOST');
        throw new Error('OWNED_REPAIR_RECONCILIATION_UNPROVEN');
      }
    });
  }
}
