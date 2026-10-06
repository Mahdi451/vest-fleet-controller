import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  D,
  protectionOrderSchema,
  type Account,
} from '../../core/src/index.ts';
import { evaluateFleetExposure } from '../../risk-engine/src/exposure.ts';
import {
  copierHash,
  leaderRootKey,
  followerCommandId,
  type LeaderEvent,
  type CopierGlobalFailure,
} from './copier-events.ts';
import {
  mutationId,
  ownedRootId,
  type MutationRecord,
} from './copier-mutations.ts';
import {
  ownedMutationRequestSchema,
  ownedMutationReceiptSchema,
  type OwnedMutationReceipt,
  type OwnedMutationCapabilities,
} from './owned-mutation-contract.ts';
import type { OfflineFanoutArm } from './fanout-controller.ts';
import type { ExecutionAdapter } from './adapter.ts';
import type { Journal } from './journal.ts';
export interface OwnedExecutionContext {
  adapter: ExecutionAdapter;
  journal: Journal;
  generation: string;
  now: () => number;
  config: { sizeStep: string; maxDataAgeMs: number };
  policy: () => { value: OfflineFanoutArm; revision: number };
  active: (revision: number) => void;
  available: (accountId: string) => boolean;
  fleet: () => Promise<Account[]>;
  fail: (reason: CopierGlobalFailure) => never;
  queue: <T>(
    accountId: string,
    run: (read: <R>(run: () => Promise<R>) => Promise<R>) => Promise<T>,
  ) => Promise<T>;
}
type Context = OwnedExecutionContext;
const pendingState = new Set(['QUEUED', 'DISPATCHING', 'UNKNOWN']);
const economic = new Set(['ADD', 'REDUCE', 'CLOSE']);
/** Only genuine accepted fixture events can mutate an already owned root. */
export class OwnedEventExecutor {
  constructor(private c: Context) {}
  private provider(): ExecutionAdapter & OwnedMutationCapabilities {
    const adapter = this.c.adapter as ExecutionAdapter &
      OwnedMutationCapabilities;
    if (
      ![
        'addOwnedPosition',
        'reduceOwnedPosition',
        'closeOwnedPosition',
        'changeOwnedProtection',
        'readOwnedMutation',
      ].every(
        (key) =>
          typeof adapter[key as keyof OwnedMutationCapabilities] === 'function',
      )
    )
      throw new Error('OWNED_MUTATION_UNSUPPORTED');
    return adapter;
  }
  private rootEvent(event: LeaderEvent) {
    const entry = this.c.journal.copier
      .leaderRootHistory(leaderRootKey(event))
      .find(
        (row) =>
          row.event.kind === 'ENTRY' &&
          leaderRootKey(row.event) === leaderRootKey(event),
      );
    if (!entry) throw new Error('MUTATION_ENTRY_ROOT_UNPROVEN');
    return entry;
  }
  async copy(eventId: string) {
    const event = this.c.journal.copier.leaderEvent(eventId);
    if (!event || event.kind === 'ENTRY')
      throw new Error('MUTATION_EVENT_REFUSED');
    const existingActivation = this.c.journal.mutations.activation(eventId);
    const replay = (followers: string[]) =>
      followers.map(
        (accountId) =>
          this.c.journal.mutations.get(mutationId(eventId, accountId)) ?? {
            accountId,
            eventId,
            state: 'NOT_ATTEMPTED',
            reason: 'MUTATION_ACTIVATION_REPLAY_ONLY',
          },
      );
    if (existingActivation)
      return replay(existingActivation.followerAccountIds);
    const armed = this.c.policy();
    const policy = armed.value;
    if (
      event.leaderAccountId !== policy.leaderAccountId ||
      event.symbol !== policy.symbol
    )
      return this.c.fail('EVENT_IDENTITY_CORRUPT');
    const entry = this.rootEvent(event),
      batch = this.c.journal.copier.fanoutBatch(entry.eventId);
    if (
      event.side !== entry.event.side ||
      !new D(event.leverage).eq(entry.event.leverage)
    )
      return this.c.fail('EVENT_IDENTITY_CORRUPT');
    if (
      !batch ||
      batch.followerAccountIds.some(
        (id) => !policy.followerAccountIds.includes(id),
      )
    )
      throw new Error('MUTATION_ENVELOPE_MISMATCH');
    if (!this.c.journal.copier.eventContiguous(eventId))
      throw new Error('MUTATION_SEQUENCE_GAP');
    const activated = this.c.journal.mutations.activate({
      eventId,
      rootKey: leaderRootKey(event),
      followerAccountIds: batch.followerAccountIds,
      ownerGeneration: this.c.generation,
      activatedAt: this.c.now(),
    });
    if (!activated.fresh)
      return replay(activated.activation.followerAccountIds);
    const jobs = batch.followerAccountIds.map(async (accountId) => {
      const old = this.c.journal.mutations.get(mutationId(eventId, accountId));
      if (old) return old;
      // Economic events already admitted must retain their order even when newer events arrive.
      const rootId = ownedRootId(leaderRootKey(event), accountId);
      const prior = this.c.journal.mutations.root(rootId);
      const entryAttempt = this.c.journal.copier
        .followerAttempts(followerCommandId(entry.eventId, accountId))
        .at(-1);
      const initial =
        prior?.initialFollowerQuantity ?? entryAttempt?.outcome.filledQuantity;
      const initialProven = !!initial && new D(initial).gt(0);
      const computedDelta =
        initialProven && (event.kind === 'ADD' || event.kind === 'REDUCE')
          ? new D(event.quantity)
              .mul(initial!)
              .div(entry.event.quantity)
              .div(this.c.config.sizeStep)
              .floor()
              .mul(this.c.config.sizeStep)
              .toFixed()
          : null;
      const belowStep = computedDelta !== null && new D(computedDelta).lte(0);
      const delta = belowStep ? null : computedDelta;
      const claim = this.c.journal.mutations.claim(
        {
          eventId,
          rootId,
          rootKey: leaderRootKey(event),
          accountId,
          operation: event.kind,
          sequence: event.sequence,
          deltaQuantity: delta,
          price: 'price' in event ? event.price : null,
          ownerGeneration: this.c.generation,
          createdAt: this.c.now(),
        },
        this.c.journal.copier.firstDetection(eventId)!.detectedAt,
        this.c.journal.copier.firstDetection(eventId)!.generation,
      );
      if (!claim.fresh) return claim.record;
      if (!initialProven || belowStep)
        return this.c.journal.mutations.transition(
          claim.record.mutationId,
          'QUEUED',
          'SKIPPED',
          this.c.now(),
          {
            reason: !initialProven
              ? 'FOLLOWER_ENTRY_UNPROVEN'
              : 'MUTATION_BELOW_SIZE_STEP',
          },
        );
      return this.c.queue(accountId, (read) =>
        this.run(claim.record, armed, read),
      );
    });
    return Promise.all(jobs);
  }
  private async bootstrap(
    record: MutationRecord,
    read: <R>(run: () => Promise<R>) => Promise<R>,
  ) {
    const c = this.c,
      entry = this.rootEvent(c.journal.copier.leaderEvent(record.eventId)!);
    const old = c.journal.mutations.root(record.rootId);
    if (old) return old;
    const command = c.journal.copier.followerCommand(
      followerCommandId(entry.eventId, record.accountId),
    );
    const attempt = command
      ? c.journal.copier.followerAttempts(command.commandId).at(-1)
      : null;
    if (
      !command ||
      !attempt ||
      attempt.terminal?.result !== 'FILLED' ||
      attempt.outcome.exposure !== 'PRESENT' ||
      attempt.outcome.submission !== 'ACCEPTED'
    )
      throw new Error('MUTATION_ENTRY_UNPROVEN');
    const fleet = await read(() => c.fleet());
    const account = fleet.find((a) => a.accountId === record.accountId)!;
    const p = account.positions[0];
    if (
      !p ||
      account.positions.length !== 1 ||
      p.entryRequestId !== attempt.attemptId ||
      p.symbol !== command.symbol ||
      p.side !== command.side ||
      !new D(p.quantity).eq(attempt.outcome.filledQuantity) ||
      !new D(p.entryPrice).eq(attempt.outcome.fillPrice!) ||
      !new D(p.leverage).eq(command.leverage)
    )
      throw new Error('MUTATION_OWNERSHIP_UNPROVEN');
    const orders = z
      .array(protectionOrderSchema)
      .parse(await read(() => c.adapter.getOpenOrders(record.accountId)));
    if (
      orders.some(
        (o) =>
          o.accountId !== record.accountId ||
          o.entryRequestId !== p.entryRequestId ||
          o.symbol !== p.symbol ||
          o.positionSide !== p.side ||
          !new D(o.quantity).eq(p.quantity) ||
          o.status !== 'ACTIVE' ||
          !new D(o.filledSize).isZero() ||
          o.error !== null,
      )
    )
      return c.fail('ACCOUNT_MAPPING_CORRUPT');
    if (
      orders.filter((o) => o.type === 'STOP_LOSS').length > 1 ||
      orders.filter((o) => o.type === 'TAKE_PROFIT').length > 1
    )
      return c.fail('ACCOUNT_MAPPING_CORRUPT');
    const stop = orders.find((o) => o.type === 'STOP_LOSS'),
      target = orders.find((o) => o.type === 'TAKE_PROFIT');
    return c.journal.mutations.createRoot({
      rootId: record.rootId,
      rootKey: record.rootKey,
      entryEventId: entry.eventId,
      accountId: record.accountId,
      entryRequestId: p.entryRequestId,
      symbol: p.symbol,
      side: p.side,
      initialFollowerQuantity: attempt.outcome.filledQuantity,
      initialLeaderQuantity: entry.event.quantity,
      quantity: p.quantity,
      basis: p.entryPrice,
      leverage: p.leverage,
      providerRevision: account.revision,
      revision: 0,
      lastEconomicSequence: entry.event.sequence,
      certainty: 'PRESENT',
      closed: false,
      stopPrice: stop?.triggerPrice ?? null,
      targetPrice: target?.triggerPrice ?? null,
      stopId: stop?.orderId ?? null,
      targetId: target?.orderId ?? null,
      updatedAt: c.now(),
    });
  }
  private async run(
    record: MutationRecord,
    armed: ReturnType<Context['policy']>,
    read: <R>(run: () => Promise<R>) => Promise<R>,
  ): Promise<MutationRecord> {
    const c = this.c;
    record = c.journal.mutations.get(record.mutationId)!;
    if (record.state !== 'QUEUED') return record;
    let dispatched = false;
    try {
      c.active(armed.revision);
      if (!c.available(record.accountId))
        throw new Error('MUTATION_CONTEXT_UNAVAILABLE');
      const provider = this.provider();
      let root = await this.bootstrap(record, read);
      if (
        root.closed ||
        c.journal.copier.followerDisposition(
          root.entryEventId,
          record.accountId,
        )
      )
        throw new Error('MUTATION_ROOT_CLOSED');
      if (
        root.certainty !== 'PRESENT' ||
        c.journal.ownedRepairs
          .records(root.rootId)
          .some((row) => ['DISPATCHING', 'UNKNOWN'].includes(row.state)) ||
        c.journal.mutations
          .records(root.rootId)
          .some(
            (row) =>
              row.mutationId !== record.mutationId &&
              ['DISPATCHING', 'UNKNOWN'].includes(row.state),
          )
      )
        throw new Error('MUTATION_RECONCILIATION_REQUIRED');
      const priorEvents = c.journal.copier
        .leaderRootHistory(root.rootKey)
        .filter(
          (row) =>
            leaderRootKey(row.event) === root.rootKey &&
            economic.has(row.event.kind) &&
            row.event.sequence < record.sequence,
        );
      if (
        priorEvents.some((row) => {
          const previous = c.journal.mutations.get(
            mutationId(row.eventId, record.accountId),
          );
          return !previous || pendingState.has(previous.state);
        })
      )
        throw new Error('MUTATION_ECONOMIC_PREDECESSOR_UNPROVEN');
      const fleet = await read(() => c.fleet()),
        account = fleet.find((a) => a.accountId === record.accountId)!;
      const p = account.positions[0];
      if (
        account.positions.length !== 1 ||
        !p ||
        p.entryRequestId !== root.entryRequestId ||
        p.symbol !== root.symbol ||
        p.side !== root.side ||
        !new D(p.quantity).eq(root.quantity) ||
        !new D(p.entryPrice).eq(root.basis!) ||
        !new D(p.leverage).eq(root.leverage)
      ) {
        c.journal.mutations.updateRoot(root.rootId, root.revision, {
          certainty: 'UNKNOWN',
          updatedAt: c.now(),
        });
        throw new Error('MUTATION_OWNERSHIP_UNPROVEN');
      }
      if (new D(root.leverage).gt(armed.value.maxLeverage))
        throw new Error('MUTATION_RISK_ENVELOPE_REFUSED');
      if (
        record.operation === 'ADD' &&
        evaluateFleetExposure({ symbol: root.symbol, side: root.side }, fleet)
          .length
      )
        return c.fail('UNSAFE_FLEET_EXPOSURE');
      root = c.journal.mutations.updateRoot(root.rootId, root.revision, {
        providerRevision: account.revision,
        updatedAt: c.now(),
      });
      const base = {
        environment: 'OFFLINE_FIXTURE' as const,
        evidence: 'SYNTHETIC' as const,
        requestId: record.mutationId,
        eventId: record.eventId,
        rootKey: root.rootKey,
        accountId: root.accountId,
        entryRequestId: root.entryRequestId,
        symbol: root.symbol,
        side: root.side,
        sequence: record.sequence,
        expectedRevision: account.revision,
        expectedQuantity: root.quantity,
        expectedBasis: root.basis!,
        leverage: root.leverage,
        maxNotional: armed.value.maxNotionalPerAccount,
        maxPlannedLoss: armed.value.maxPlannedLossPerAccount,
      };
      const request = ownedMutationRequestSchema.parse({
        ...base,
        operation: record.operation,
        ...(record.deltaQuantity
          ? { deltaQuantity: record.deltaQuantity }
          : {}),
        ...(record.price ? { price: record.price } : {}),
      });
      c.active(armed.revision);
      if (!c.available(root.accountId))
        throw new Error('MUTATION_CONTEXT_UNAVAILABLE');
      const admitted = c.journal.mutations.get(record.mutationId)!;
      if (admitted.state !== 'QUEUED') return admitted;
      record = c.journal.mutations.transition(
        record.mutationId,
        'QUEUED',
        'DISPATCHING',
        c.now(),
        { request, submitAt: c.now(), reservedRootRevision: root.revision },
      );
      dispatched = true;
      const result = await read(() =>
        request.operation === 'ADD'
          ? provider.addOwnedPosition(request)
          : request.operation === 'REDUCE'
            ? provider.reduceOwnedPosition(request)
            : request.operation === 'CLOSE'
              ? provider.closeOwnedPosition(request)
              : provider.changeOwnedProtection(request),
      );
      return await this.verify(record, result, read);
    } catch (error) {
      if (
        error instanceof Error &&
        /STORAGE|REVISION_CONFLICT|STATE_CONFLICT|IDENTITY_CONFLICT/.test(
          error.message,
        )
      )
        c.fail('JOURNAL_INTEGRITY_LOST');
      const current = c.journal.mutations.get(record.mutationId)!;
      if (current.state !== 'QUEUED' && current.state !== 'DISPATCHING')
        return current;
      const reason =
        error instanceof Error && /^[A-Z_]{1,80}$/.test(error.message)
          ? error.message
          : 'MUTATION_UNPROVEN';
      if (dispatched) {
        const root = c.journal.mutations.root(record.rootId);
        return c.journal.mutations.settle(
          record.mutationId,
          'DISPATCHING',
          'UNKNOWN',
          c.now(),
          null,
          root ? { certainty: 'UNKNOWN' } : {},
          reason,
        );
      }
      return c.journal.mutations.transition(
        record.mutationId,
        'QUEUED',
        'NOT_SENT',
        c.now(),
        { reason },
      );
    }
  }
  private receipt(
    record: MutationRecord,
    input: unknown,
  ): OwnedMutationReceipt {
    const parsed = ownedMutationReceiptSchema.safeParse(input);
    if (!parsed.success) return this.c.fail('ACCOUNT_MAPPING_CORRUPT');
    const receipt = parsed.data,
      request = record.request!;
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
        return this.c.fail('ACCOUNT_MAPPING_CORRUPT');
    if (
      receipt.requestHash !== copierHash(request) ||
      (receipt.status !== 'REJECTED' &&
        (!new D(receipt.before.quantity).eq(request.expectedQuantity) ||
          !new D(receipt.before.basis ?? 0).eq(request.expectedBasis) ||
          receipt.before.revision !== request.expectedRevision))
    )
      return this.c.fail('ACCOUNT_MAPPING_CORRUPT');
    return receipt;
  }
  private async verify(
    record: MutationRecord,
    input: unknown,
    read: <R>(run: () => Promise<R>) => Promise<R>,
  ): Promise<MutationRecord> {
    const c = this.c,
      receipt = this.receipt(record, input),
      request = record.request!;
    if (receipt.status === 'UNKNOWN')
      return c.journal.mutations.settle(
        record.mutationId,
        record.state,
        'UNKNOWN',
        c.now(),
        receipt,
        { certainty: 'UNKNOWN' },
        'PROVIDER_UNCERTAIN',
      );
    if (receipt.status === 'REJECTED') {
      const account = (await read(() => c.fleet())).find(
        (a) => a.accountId === record.accountId,
      )!;
      const p = account.positions[0];
      let unchanged =
        account.positions.length === 1 &&
        p &&
        p.entryRequestId === request.entryRequestId &&
        p.symbol === request.symbol &&
        p.side === request.side &&
        new D(p.quantity).eq(request.expectedQuantity) &&
        new D(p.entryPrice).eq(request.expectedBasis) &&
        new D(p.leverage).eq(request.leverage);
      const orders = z
        .array(protectionOrderSchema)
        .parse(await read(() => c.adapter.getOpenOrders(record.accountId)));
      if (
        orders.some(
          (o) =>
            o.accountId !== request.accountId ||
            o.entryRequestId !== request.entryRequestId ||
            o.symbol !== request.symbol ||
            o.positionSide !== request.side ||
            o.status !== 'ACTIVE' ||
            !new D(o.filledSize).isZero() ||
            o.error !== null,
        ) ||
        orders.filter((o) => o.type === 'STOP_LOSS').length > 1 ||
        orders.filter((o) => o.type === 'TAKE_PROFIT').length > 1
      )
        return c.fail('ACCOUNT_MAPPING_CORRUPT');
      unchanged =
        !!unchanged &&
        orders.every((o) => new D(o.quantity).eq(request.expectedQuantity));
      const stop = orders.find((o) => o.type === 'STOP_LOSS'),
        target = orders.find((o) => o.type === 'TAKE_PROFIT');
      return c.journal.mutations.settle(
        record.mutationId,
        record.state,
        'REJECTED',
        c.now(),
        receipt,
        {
          certainty: unchanged ? 'PRESENT' : 'UNKNOWN',
          ...(unchanged
            ? {
                stopPrice: stop?.triggerPrice ?? null,
                targetPrice: target?.triggerPrice ?? null,
                stopId: stop?.orderId ?? null,
                targetId: target?.orderId ?? null,
                providerRevision: account.revision,
              }
            : {}),
        },
        unchanged ? receipt.reason : 'MUTATION_OWNERSHIP_UNPROVEN',
      );
    }
    const expected =
      request.operation === 'ADD'
        ? new D(request.expectedQuantity).plus(receipt.executedQuantity)
        : request.operation === 'REDUCE'
          ? new D(request.expectedQuantity).minus(receipt.executedQuantity)
          : request.operation === 'CLOSE'
            ? new D(0)
            : new D(request.expectedQuantity);
    if (
      !expected.eq(receipt.after.quantity) ||
      expected.lt(0) ||
      receipt.after.revision <= receipt.before.revision ||
      (request.operation === 'REDUCE' &&
        receipt.status === 'VERIFIED' &&
        !new D(receipt.executedQuantity).eq(request.deltaQuantity)) ||
      (request.operation === 'CLOSE' &&
        !new D(receipt.executedQuantity).eq(request.expectedQuantity)) ||
      (['STOP_CHANGED', 'TARGET_CHANGED'].includes(request.operation) &&
        (!new D(receipt.executedQuantity).isZero() ||
          receipt.after.basis !== receipt.before.basis)) ||
      (request.operation === 'ADD' &&
        !new D(receipt.executedQuantity).eq(request.deltaQuantity)) ||
      (request.operation === 'REDUCE' &&
        (new D(receipt.executedQuantity).gt(request.deltaQuantity) ||
          new D(receipt.executedQuantity).lte(0)))
    )
      return c.fail('ACCOUNT_MAPPING_CORRUPT');
    const fleet = await read(() => c.fleet()),
      account = fleet.find((a) => a.accountId === record.accountId)!;
    const orders = z
      .array(protectionOrderSchema)
      .parse(await read(() => c.adapter.getOpenOrders(record.accountId)));
    if (new D(receipt.after.quantity).isZero()) {
      if (account.positions.length || orders.length)
        throw new Error('MUTATION_EXIT_UNVERIFIED');
    } else {
      const p = account.positions[0];
      if (
        account.positions.length !== 1 ||
        !p ||
        p.entryRequestId !== request.entryRequestId ||
        p.side !== request.side ||
        p.symbol !== request.symbol ||
        !new D(p.quantity).eq(receipt.after.quantity) ||
        !new D(p.entryPrice).eq(receipt.after.basis!) ||
        !new D(p.leverage).eq(request.leverage)
      )
        throw new Error('MUTATION_RESULT_UNVERIFIED');
    }
    if (
      orders.some(
        (o) =>
          o.accountId !== request.accountId ||
          o.entryRequestId !== request.entryRequestId ||
          o.symbol !== request.symbol ||
          o.positionSide !== request.side ||
          !new D(o.quantity).eq(receipt.after.quantity) ||
          o.status !== 'ACTIVE' ||
          !new D(o.filledSize).isZero() ||
          o.error !== null,
      )
    )
      return c.fail('ACCOUNT_MAPPING_CORRUPT');
    const stop = orders.find((o) => o.type === 'STOP_LOSS'),
      target = orders.find((o) => o.type === 'TAKE_PROFIT');
    if (
      orders.filter((o) => o.type === 'STOP_LOSS').length > 1 ||
      orders.filter((o) => o.type === 'TAKE_PROFIT').length > 1
    )
      return c.fail('ACCOUNT_MAPPING_CORRUPT');
    if (
      (request.operation === 'STOP_CHANGED' &&
        (!stop || !new D(stop.triggerPrice).eq(request.price))) ||
      (request.operation === 'TARGET_CHANGED' &&
        (!target || !new D(target.triggerPrice).eq(request.price)))
    )
      throw new Error('MUTATION_PROTECTION_UNVERIFIED');
    const flat = new D(receipt.after.quantity).isZero();
    const settled = c.journal.mutations.settle(
      record.mutationId,
      record.state,
      receipt.status,
      c.now(),
      receipt,
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
        ...(economic.has(record.operation)
          ? { lastEconomicSequence: record.sequence }
          : {}),
      },
      !flat && !stop ? 'SL_MISSING' : !flat && !target ? 'TP_MISSING' : null,
      c.generation,
    );
    if (flat) this.closeEntry(settled);
    return settled;
  }
  private closeEntry(record: MutationRecord) {
    const c = this.c,
      root = c.journal.mutations.root(record.rootId)!;
    const command = c.journal.copier.followerCommand(
      followerCommandId(root.entryEventId, root.accountId),
    );
    const attempt = command
      ? c.journal.copier.followerAttempts(command.commandId).at(-1)
      : null;
    if (!attempt || attempt.terminal?.result !== 'FILLED') return;
    c.journal.copier.recordAttemptObservation(
      attempt.attemptId,
      attempt.revision,
      {
        observationId: randomUUID(),
        observedAt: c.now(),
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
          observedAt: c.now(),
        },
      },
    );
  }
  async reconcile(key: string) {
    const record = this.c.journal.mutations.get(key);
    if (!record) throw new Error('MUTATION_MISSING');
    return this.c.queue(record.accountId, async (read) => {
      const current = this.c.journal.mutations.get(key)!;
      if (
        !['DISPATCHING', 'UNKNOWN'].includes(current.state) ||
        !current.request
      )
        return current;
      const receipt = await read(() => this.provider().readOwnedMutation(key));
      if (!receipt) return current;
      try {
        return await this.verify(current, receipt, read);
      } catch (error) {
        if (error instanceof Error && /STORAGE/.test(error.message))
          return this.c.fail('JOURNAL_INTEGRITY_LOST');
        throw new Error('MUTATION_RECONCILIATION_UNPROVEN');
      }
    });
  }
}
