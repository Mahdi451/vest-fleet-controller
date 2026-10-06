import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  D,
  accountSchema,
  quoteSchema,
  intentSchema,
  riskConfigSchema,
  protectionOrderSchema,
  protectionRequestSchema,
  isFresh,
  positive,
  type Account,
  type RiskConfig,
  type TradeIntent,
} from '../../core/src/index.ts';
import { type RiskPreview } from '../../risk-engine/src/index.ts';
import { protectionPrices } from '../../risk-engine/src/index.ts';
import type { RepairOperation, CopierRepairRecord } from './copier-repairs.ts';
import {
  OfflineFanoutReadiness,
  type PreparedFollowers,
} from './fanout-readiness.ts';
import {
  executeAccount,
  protectionMatches,
  type AccountExecutionContext,
} from './account-lifecycle.ts';
import {
  validateResult,
  type ExecutionAdapter,
  type OrderResult,
} from './adapter.ts';
import { Journal } from './journal.ts';
import {
  copierHash,
  followerCommandId,
  type FollowerAttempt,
  type FollowerCommand,
  type CopierGlobalFailure,
  type AttemptObservation,
  type TerminalProof,
  type LeaderEvent,
} from './copier-events.ts';
import type { FleetPreview } from './controller.ts';
import { OwnedEventExecutor } from './owned-event-executor.ts';

const armSchema = z
  .object({
    environment: z.literal('OFFLINE_FIXTURE'),
    evidence: z.literal('SYNTHETIC'),
    leaderAccountId: z.string().regex(/^[A-Za-z0-9_:.\-]{1,100}$/),
    followerAccountIds: z
      .array(z.string().regex(/^[A-Za-z0-9_:.\-]{1,100}$/))
      .min(1)
      .max(9),
    symbol: z.literal('NDX'),
    maxLeverage: positive,
    maxNotionalPerAccount: positive,
    maxPlannedLossPerAccount: positive,
    expiresAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  })
  .strict();
export type OfflineFanoutArm = z.infer<typeof armSchema>;
export interface OfflineFanoutAdapter extends ExecutionAdapter {
  readonly environment: 'OFFLINE_FIXTURE';
  readonly scheduling: 'ACCOUNT_LANES' | 'SERIAL';
}
export class CopierSystemError extends Error {
  constructor(readonly reason: CopierGlobalFailure) {
    super('COPIER_SYSTEM_FAILURE');
  }
}
export interface FollowerCopyUpdate {
  eventId: string;
  accountId: string;
  command: FollowerCommand | null;
  attempt: FollowerAttempt | null;
  error: string | null;
  replayed: boolean;
}
const localAdmission = new Set([
  'FOLLOWER_REQUIRES_RECONCILIATION',
  'FOLLOWER_HAS_EXPOSURE',
  'FOLLOWER_EVENT_EXITED_OR_SKIPPED',
  'STALE_LEADER_EVENT',
  'LEADER_SEQUENCE_GAP',
]);

/** Synthetic-only scheduling owner. Never connects to Vest or arms a funded runtime. */
export class OfflineFanoutController {
  private readonly generation = randomUUID();
  private readonly config: RiskConfig;
  private armState: OfflineFanoutArm | null = null;
  private armRevision = 0;
  private fleetIds: string[] = [];
  private memoryStop: CopierGlobalFailure | null = null;
  private lanes = new Map<string, Promise<void>>();
  private listeners = new Set<(update: FollowerCopyUpdate) => void>();
  private latest = new Map<string, FollowerCopyUpdate>();
  private readonly ownedEvents: OwnedEventExecutor;
  private readonly readiness: OfflineFanoutReadiness;
  private preparation: {
    prepared: PreparedFollowers;
    fleet: Account[];
    quote: FleetPreview['quote'];
  } | null = null;
  constructor(
    private readonly adapter: OfflineFanoutAdapter,
    config: RiskConfig,
    private readonly journal: Journal,
    private readonly clock: () => number = Date.now,
    private readonly timeoutMs = 1000,
  ) {
    if (
      adapter.environment !== 'OFFLINE_FIXTURE' ||
      adapter.mode !== 'SIMULATION' ||
      adapter.scheduling !== 'ACCOUNT_LANES'
    )
      throw new Error('OFFLINE_FANOUT_ADAPTER_REFUSED');
    this.config = riskConfigSchema.parse(config);
    this.readiness = new OfflineFanoutReadiness(this.config, clock);
    this.ownedEvents = new OwnedEventExecutor({
      adapter,
      journal,
      generation: this.generation,
      now: clock,
      config: this.config,
      policy: () => {
        if (this.status() !== 'ARMED')
          throw new Error('OFFLINE_MUTATION_LOCKED');
        return {
          value: structuredClone(this.armState!),
          revision: this.armRevision,
        };
      },
      active: (revision) => this.active(revision),
      available: (accountId) => this.readiness.available(accountId),
      fleet: async () =>
        this.accounts(await this.provider(() => this.adapter.listAccounts())),
      fail: (reason) => this.fail(reason),
      queue: (accountId, run) => this.queueOwnedEvent(accountId, run),
    });
    if (
      !Number.isSafeInteger(timeoutMs) ||
      timeoutMs < 1 ||
      this.config.maxDataAgeMs > 60000
    )
      throw new Error('INVALID_FANOUT_BUDGET');
  }
  status(): 'LOCKED' | 'ARMED' | 'HALTED' {
    try {
      this.readiness.observeClock();
    } catch {
      this.halt('CHANNEL_INTEGRITY_LOST');
    }
    if (this.globalStop()) return 'HALTED';
    if (!this.armState) return 'LOCKED';
    if (this.clock() >= this.armState.expiresAt) {
      this.lock();
      return 'LOCKED';
    }
    return 'ARMED';
  }
  lock() {
    this.armState = null;
    this.armRevision++;
    this.readiness.lock();
    this.preparation = null;
  }
  private globalStop() {
    try {
      return this.memoryStop ?? this.journal.copier.globalStop();
    } catch {
      this.memoryStop = 'JOURNAL_INTEGRITY_LOST';
      return this.memoryStop;
    }
  }
  halt(reason: CopierGlobalFailure) {
    this.readiness.invalidate();
    this.memoryStop = reason;
    this.lock();
    try {
      this.journal.copier.haltGlobal(reason);
    } catch {
      /* Memory lock survives a failed journal. */
    }
  }
  private fail(reason: CopierGlobalFailure): never {
    this.halt(reason);
    throw new CopierSystemError(reason);
  }
  private accounts(input: unknown): Account[] {
    const parsed = z.array(accountSchema).min(1).safeParse(input);
    if (!parsed.success) return this.fail('ACCOUNT_MAPPING_CORRUPT');
    const ids = parsed.data.map((a) => a.accountId).sort();
    if (
      new Set(ids).size !== ids.length ||
      (this.fleetIds.length &&
        JSON.stringify(ids) !== JSON.stringify(this.fleetIds))
    )
      return this.fail('ACCOUNT_MAPPING_CORRUPT');
    if (
      parsed.data.some(
        (a) =>
          a.enabled &&
          !isFresh(a.lastSyncTimestamp, this.clock(), this.config.maxDataAgeMs),
      )
    )
      return this.fail('ACCOUNT_MAPPING_CORRUPT');
    if (
      this.armState &&
      !parsed.data.some(
        (account) =>
          account.accountId === this.armState!.leaderAccountId &&
          account.enabled &&
          account.status === 'ACTIVE',
      )
    )
      return this.fail('LEADER_IDENTITY_UNCERTAIN');
    return parsed.data;
  }
  async arm(input: OfflineFanoutArm) {
    const parsed = armSchema.safeParse(input);
    if (!parsed.success) throw new Error('OFFLINE_ARM_REFUSED');
    const policy = parsed.data,
      now = this.clock();
    if (
      this.lanes.size ||
      this.globalStop() ||
      new Set(policy.followerAccountIds).size !==
        policy.followerAccountIds.length ||
      policy.followerAccountIds.includes(policy.leaderAccountId) ||
      policy.expiresAt <= now ||
      policy.expiresAt - now > 900000 ||
      new D(policy.maxLeverage).gt(this.config.maxLeverage)
    )
      throw new Error('OFFLINE_ARM_REFUSED');
    this.lock();
    const revision = this.armRevision;
    const fleet = this.accounts(
      await this.provider(() => this.adapter.listAccounts()),
    );
    if (revision !== this.armRevision || this.globalStop())
      throw new Error('OFFLINE_ARM_REVOKED');
    if (
      ![policy.leaderAccountId, ...policy.followerAccountIds].every((id) =>
        fleet.some(
          (a) => a.accountId === id && a.enabled && a.status === 'ACTIVE',
        ),
      )
    )
      throw new Error('OFFLINE_ARM_REFUSED');
    this.fleetIds = fleet.map((a) => a.accountId).sort();
    this.readiness.arm(policy, fleet);
    this.armState = structuredClone(policy);
    return this.status();
  }
  invalidateContext(accountId: string) {
    const scope = this.readiness.invalidateContext(accountId);
    this.preparation = null;
    if (scope === 'GLOBAL') this.halt('LEADER_IDENTITY_UNCERTAIN');
  }
  async restoreContext(accountId: string) {
    if (this.status() !== 'ARMED') throw new Error('OFFLINE_ENTRY_LOCKED');
    const account = accountSchema.parse(
      await this.provider(() => this.adapter.getAccountState(accountId)),
    );
    if (account.accountId !== accountId)
      return this.fail('ACCOUNT_MAPPING_CORRUPT');
    this.readiness.restoreContext(account);
    this.preparation = null;
  }
  async prepare(input: TradeIntent) {
    const { prepared } = await this.prepareFollowers(input);
    return {
      source: prepared.source,
      preparedAt: prepared.preparedAt,
      expiresAt: prepared.expiresAt,
      approvals: structuredClone(prepared.approvals),
    };
  }
  private async prepareFollowers(input: TradeIntent) {
    if (this.status() !== 'ARMED') throw new Error('OFFLINE_ENTRY_LOCKED');
    const revision = this.armRevision;
    const intent = intentSchema.parse(input);
    const fleet = this.accounts(
      await this.deadline(this.provider(() => this.adapter.listAccounts())),
    );
    const quote = quoteSchema.parse(
      await this.deadline(this.provider(() => this.adapter.getQuote())),
    );
    this.active(revision);
    const prepared = this.readiness.prepare(intent, fleet, quote);
    const bundle = { prepared, fleet, quote };
    this.preparation = bundle;
    return bundle;
  }
  subscribe(listener: (update: FollowerCopyUpdate) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  private queueOwnedEvent<T>(
    accountId: string,
    run: (read: <R>(operation: () => Promise<R>) => Promise<R>) => Promise<T>,
  ): Promise<T> {
    const pending = new Set<Promise<unknown>>();
    const predecessor = this.lanes.get(accountId) ?? Promise.resolve();
    const result = predecessor
      .then(() =>
        run((operation) => this.deadline(this.provider(operation), pending)),
      )
      .catch((error) => {
        if (
          error instanceof Error &&
          /STORAGE|STATE_CONFLICT|REVISION_CONFLICT|IDENTITY_CONFLICT/.test(
            error.message,
          )
        )
          this.halt('JOURNAL_INTEGRITY_LOST');
        throw error;
      });
    const tail = result
      .then(
        () => undefined,
        () => undefined,
      )
      .then(async () => {
        await Promise.allSettled([...pending]);
      });
    this.lanes.set(accountId, tail);
    void tail.then(() => {
      if (this.lanes.get(accountId) === tail) this.lanes.delete(accountId);
    });
    return result;
  }
  async copyChange(eventId: string) {
    try {
      return await this.ownedEvents.copy(eventId);
    } catch (error) {
      if (
        error instanceof Error &&
        /STORAGE|STATE_CONFLICT|REVISION_CONFLICT|IDENTITY_CONFLICT/.test(
          error.message,
        )
      )
        this.halt('JOURNAL_INTEGRITY_LOST');
      throw error;
    }
  }
  reconcileChange(mutationId: string) {
    return this.ownedEvents.reconcile(mutationId);
  }
  acceptSyntheticLeaderEvent(event: LeaderEvent) {
    return this.journal.copier.recordLeaderEvent(event, {
      generation: this.generation,
      detectedAt: this.clock(),
    });
  }
  private publish(update: FollowerCopyUpdate) {
    this.latest.set(
      followerCommandId(update.eventId, update.accountId),
      structuredClone(update),
    );
    for (const listener of this.listeners)
      try {
        listener(structuredClone(update));
      } catch {
        /* Observers cannot change execution or authority. */
      }
  }
  snapshot(eventId: string): FollowerCopyUpdate[] {
    const existing = this.journal.copier.eventFollowers(eventId),
      batch = this.journal.copier.fanoutBatch(eventId);
    const accounts =
      batch?.followerAccountIds ??
      existing.map((row) => row.command.followerAccountId);
    return accounts.map((accountId) => {
      const record = existing.find(
        (row) => row.command.followerAccountId === accountId,
      );
      const known = this.latest.get(followerCommandId(eventId, accountId));
      return {
        eventId,
        accountId,
        command: record?.command ?? null,
        attempt: record?.attempt ?? null,
        error:
          (record?.attempt?.terminal?.result === 'EXITED'
            ? null
            : known?.error) ??
          (record
            ? null
            : this.journal.copier.followerDisposition(eventId, accountId)
              ? 'FOLLOWER_SKIPPED'
              : 'NOT_ATTEMPTED'),
        replayed: true,
      };
    });
  }
  async repair(
    eventId: string,
    accountId: string,
    operation: RepairOperation,
    expectedAttemptId?: string,
  ): Promise<{
    update: FollowerCopyUpdate;
    repair: CopierRepairRecord | null;
  }> {
    if (
      (operation === 'RETRY' && expectedAttemptId === undefined) ||
      (expectedAttemptId !== undefined &&
        !/^[a-f0-9]{64}$/.test(expectedAttemptId))
    )
      throw new Error('REPAIR_ATTEMPT_REQUIRED');
    const predecessor = this.lanes.get(accountId) ?? Promise.resolve();
    const pending = new Set<Promise<unknown>>();
    const run = predecessor
      .then(() => {
        if (
          !['RECONCILE', 'SKIP'].includes(operation) &&
          this.journal.mutations
            .roots()
            .some(
              (root) =>
                root.entryEventId === eventId && root.accountId === accountId,
            )
        )
          throw new Error('MUTATION_REPAIR_REQUIRES_CURRENT_SCOPE');
        return this.runRepair(
          eventId,
          accountId,
          operation,
          pending,
          expectedAttemptId,
        );
      })
      .catch((error) => {
        if (error instanceof CopierSystemError) this.halt(error.reason);
        else if (
          error instanceof Error &&
          /STORAGE|CLAIM_FAILED|STATE_CONFLICT|OBSERVATION_CONFLICT/.test(
            error.message,
          )
        )
          this.halt('JOURNAL_INTEGRITY_LOST');
        const code =
          error instanceof Error && /^[A-Z_]{1,80}$/.test(error.message)
            ? error.message
            : 'REPAIR_REFUSED';
        throw new Error(code);
      });
    const tail = run
      .then(
        () => undefined,
        () => undefined,
      )
      .then(async () => {
        await Promise.allSettled([...pending]);
      });
    this.lanes.set(accountId, tail);
    void tail.then(() => {
      if (this.lanes.get(accountId) === tail) this.lanes.delete(accountId);
    });
    return run;
  }
  private async runRepair(
    eventId: string,
    accountId: string,
    operation: RepairOperation,
    pending: Set<Promise<unknown>>,
    expectedAttemptId?: string,
  ) {
    const command = this.journal.copier.followerCommand(
      followerCommandId(eventId, accountId),
    );
    if (!command) throw new Error('REPAIR_COMMAND_MISSING');
    let attempt = this.journal.copier
      .followerAttempts(command.commandId)
      .at(-1)!;
    if (
      expectedAttemptId !== undefined &&
      attempt.attemptId !== expectedAttemptId
    )
      throw new Error('REPAIR_ATTEMPT_STALE');
    const exitVerified = () => attempt.terminal?.result === 'EXITED';
    const update = () => {
      const view = {
        eventId,
        accountId,
        command,
        attempt,
        error:
          attempt.outcome.reason === 'NONE' ? null : attempt.outcome.reason,
        replayed: false,
      };
      this.publish(view);
      return view;
    };
    const observe = (
      outcome: AttemptObservation['outcome'],
      result: TerminalProof['result'] | null,
    ) => {
      const at = this.clock();
      attempt = this.journal.copier.recordAttemptObservation(
        attempt.attemptId,
        attempt.revision,
        {
          observationId: randomUUID(),
          observedAt: at,
          outcome,
          terminal: result
            ? {
                evidence: 'SYNTHETIC',
                attemptId: attempt.attemptId,
                payloadHash: command.payloadHash,
                accountId,
                result,
                providerOrderId:
                  result === 'NOT_SENT' ? null : attempt.attemptId,
                noFutureExecution: true,
                remainingQuantity: '0',
                observedAt: at,
              }
            : null,
        },
      );
    };
    const read = <T>(fn: () => Promise<T>) =>
      this.deadline(this.provider(fn), pending);
    const books = async () => {
      const fleet = this.accounts(
        await read(() => this.adapter.listAccounts()),
      );
      const account = fleet.find((a) => a.accountId === accountId);
      if (!account) return this.fail('ACCOUNT_MAPPING_CORRUPT');
      const raw = await read(() => this.adapter.getOrder(attempt.attemptId));
      let ledger: OrderResult | null;
      try {
        ledger = raw ? validateResult(raw, attempt.attemptId, accountId) : null;
      } catch {
        return this.fail('ACCOUNT_MAPPING_CORRUPT');
      }
      const parsedOrders = z
        .array(protectionOrderSchema)
        .safeParse(await read(() => this.adapter.getOpenOrders(accountId)));
      if (!parsedOrders.success) return this.fail('ACCOUNT_MAPPING_CORRUPT');
      const orders = parsedOrders.data;
      if (
        orders.some((o) => o.accountId !== accountId || o.status !== 'ACTIVE')
      )
        return this.fail('ACCOUNT_MAPPING_CORRUPT');
      return { fleet, account, ledger, orders };
    };
    const scope = (
      account: Account,
      ledger: OrderResult | null,
      orders: ReturnType<typeof protectionOrderSchema.parse>[],
    ) => {
      const position = account.positions[0];
      if (
        !position ||
        account.positions.length !== 1 ||
        position.entryRequestId !== attempt.attemptId ||
        position.side !== command.side ||
        position.symbol !== command.symbol ||
        !new D(position.leverage).eq(command.leverage) ||
        !new D(position.quantity).eq(attempt.outcome.filledQuantity) ||
        !new D(position.entryPrice).eq(attempt.outcome.fillPrice ?? '0') ||
        !ledger ||
        !['FILLED', 'PARTIALLY_FILLED'].includes(ledger.status) ||
        (ledger.status === 'PARTIALLY_FILLED' &&
          ledger.remainderCanceled !== true) ||
        !new D(ledger.filledSize).eq(position.quantity) ||
        !ledger.entryPrice ||
        !new D(ledger.entryPrice).eq(position.entryPrice) ||
        orders.some(
          (o) =>
            o.entryRequestId !== attempt.attemptId ||
            o.symbol !== command.symbol ||
            o.positionSide !== command.side,
        )
      )
        throw new Error('REPAIR_OWNERSHIP_UNPROVEN');
      return position;
    };
    if (operation === 'RECONCILE') {
      const { account, ledger, orders } = await books();
      if (
        ledger?.status === 'REJECTED' &&
        account.positions.length === 0 &&
        new D(ledger.filledSize).isZero() &&
        new D(attempt.outcome.filledQuantity).isZero() &&
        attempt.dispatchStartedAt !== null
      ) {
        observe(
          {
            ...attempt.outcome,
            submission: 'REJECTED',
            exposure: 'ABSENT',
            reason: 'ENTRY_REJECTED',
          },
          'REJECTED',
        );
      } else if (
        ledger &&
        ['FILLED', 'PARTIALLY_FILLED'].includes(ledger.status) &&
        (ledger.status === 'FILLED' || ledger.remainderCanceled === true) &&
        account.positions.length === 1
      ) {
        const p = account.positions[0]!;
        if (
          p.entryRequestId !== attempt.attemptId ||
          p.symbol !== command.symbol ||
          p.side !== command.side ||
          !new D(p.leverage).eq(command.leverage) ||
          !new D(p.quantity).eq(ledger.filledSize) ||
          !ledger.entryPrice ||
          !new D(p.entryPrice).eq(ledger.entryPrice) ||
          new D(p.quantity).gt(command.quantity)
        )
          return this.fail('ACCOUNT_MAPPING_CORRUPT');
        const intent = this.journal.copier.fanoutBatch(eventId)!.intent;
        const prices = protectionPrices(p.entryPrice, intent);
        const verified = (type: 'STOP_LOSS' | 'TAKE_PROFIT') =>
          orders.some(
            (o) =>
              o.entryRequestId === attempt.attemptId &&
              o.accountId === accountId &&
              o.symbol === command.symbol &&
              o.positionSide === command.side &&
              o.type === type &&
              o.reduceOnly &&
              new D(o.quantity).eq(p.quantity) &&
              new D(o.filledSize).isZero() &&
              new D(o.triggerPrice).eq(
                type === 'STOP_LOSS' ? prices.stopPrice : prices.targetPrice,
              ),
          );
        const stop = verified('STOP_LOSS')
            ? ('VERIFIED' as const)
            : ('UNKNOWN' as const),
          target = verified('TAKE_PROFIT')
            ? ('VERIFIED' as const)
            : ('UNKNOWN' as const);
        observe(
          {
            ...attempt.outcome,
            submission: 'ACCEPTED',
            fill: new D(p.quantity).eq(command.quantity) ? 'FILLED' : 'PARTIAL',
            filledQuantity: p.quantity,
            fillPrice: p.entryPrice,
            exposure: 'PRESENT',
            stop,
            target,
            reason:
              stop === 'VERIFIED' && target === 'VERIFIED'
                ? 'NONE'
                : 'PROVIDER_UNCERTAIN',
          },
          'FILLED',
        );
      }
      if (
        account.positions.length === 0 &&
        attempt.outcome.submission === 'ACCEPTED' &&
        attempt.outcome.exposure === 'PRESENT'
      ) {
        observe(
          {
            ...attempt.outcome,
            exposure: 'UNKNOWN',
            stop: 'UNKNOWN',
            target: 'UNKNOWN',
            reason: 'PROVIDER_UNCERTAIN',
          },
          'FILLED',
        );
      }
      // Empty books alone never prove a late entry impossible or an exit complete.
      return { update: update(), repair: null };
    }
    if (operation === 'RETRY') {
      if (this.status() !== 'ARMED') throw new Error('OFFLINE_ENTRY_LOCKED');
      const policy = structuredClone(this.armState!),
        revision = this.armRevision;
      const event = this.journal.copier.leaderEvent(eventId);
      if (
        !event ||
        event.leaderAccountId !== policy.leaderAccountId ||
        event.symbol !== policy.symbol ||
        !policy.followerAccountIds.includes(accountId)
      )
        throw new Error('RETRY_ENVELOPE_MISMATCH');
      if (
        !attempt.terminal ||
        !['NOT_SENT', 'REJECTED'].includes(attempt.terminal.result) ||
        attempt.outcome.exposure !== 'ABSENT'
      )
        throw new Error('EXPLICIT_RETRY_UNPROVEN');
      const batch = this.journal.copier.fanoutBatch(eventId)!;
      const bundle = await this.prepareFollowers(batch.intent);
      this.active(revision);
      const planned = bundle.prepared.approvals.find(
        (p) => p.accountId === accountId,
      );
      if (!planned?.approved || !new D(planned.quantity).eq(command.quantity))
        throw new Error('RETRY_RISK_CHANGED');
      const claim = this.journal.copier.claimExplicitRetry(
        command.commandId,
        attempt.attemptId,
        this.generation,
        this.clock(),
        { accounts: bundle.fleet, maxAgeMs: this.config.maxDataAgeMs },
      );
      if (!claim.fresh)
        return {
          update: this.snapshot(eventId).find(
            (r) => r.accountId === accountId,
          )!,
          repair: null,
        };
      const preview: FleetPreview = {
        previewId: copierHash([
          eventId,
          bundle.prepared.preparedAt,
          bundle.fleet,
        ]),
        createdAt: bundle.prepared.preparedAt,
        intent: batch.intent,
        quote: bundle.quote,
        accounts: bundle.fleet,
        orders: bundle.prepared.approvals,
        exposureViolations: [],
      };
      return {
        update: await this.runFollower(
          command,
          claim.attempt,
          preview,
          planned,
          bundle.fleet.findIndex((a) => a.accountId === accountId),
          policy,
          revision,
          pending,
          bundle.prepared,
        ),
        repair: null,
      };
    }
    if (this.status() !== 'ARMED' || !this.readiness.available(accountId))
      throw new Error('OFFLINE_REPAIR_LOCKED');
    const revision = this.armRevision;
    const key = copierHash([attempt.attemptId, operation]);
    const old = this.journal.repairs.get(key);
    if (old) return { update: update(), repair: old };
    if (operation === 'SKIP') {
      this.journal.copier.recordFollowerDisposition({
        eventId,
        followerAccountId: accountId,
        reason: 'SKIPPED',
        observedAt: this.clock(),
      });
      const claimed = this.journal.repairs.claim(
        attempt.attemptId,
        operation,
        { commandId: command.commandId },
        this.clock(),
      );
      return {
        update: update(),
        repair: this.journal.repairs.update(
          claimed.record.repairId,
          'CLAIMED',
          'VERIFIED',
          this.clock(),
        ),
      };
    }
    const { account, ledger, orders } = await books();
    const position = scope(account, ledger, orders);
    if (
      attempt.terminal?.result !== 'FILLED' ||
      attempt.outcome.submission !== 'ACCEPTED'
    )
      throw new Error('REPAIR_ENTRY_UNCERTAIN');
    const batch = this.journal.copier.fanoutBatch(eventId)!;
    let request: ReturnType<typeof protectionRequestSchema.parse> | null = null;
    if (operation === 'ADD_STOP' || operation === 'ADD_TARGET') {
      const type = operation === 'ADD_STOP' ? 'STOP_LOSS' : 'TAKE_PROFIT';
      if (!this.adapter.repairOwnedProtection)
        throw new Error('CONDITIONAL_REPAIR_UNSUPPORTED');
      const existing = orders.filter(
        (o) => o.entryRequestId === attempt.attemptId && o.type === type,
      );
      if (existing.length) throw new Error('PROTECTION_ALREADY_PRESENT');
      const originalId = copierHash([attempt.attemptId, type]);
      const rawPrevious = await read(() =>
        this.adapter.getProtectionOrder(accountId, originalId),
      );
      const parsedPrevious = protectionOrderSchema
        .nullable()
        .safeParse(rawPrevious);
      if (!parsedPrevious.success) return this.fail('ACCOUNT_MAPPING_CORRUPT');
      const previous = parsedPrevious.data;
      const prices = protectionPrices(position.entryPrice, batch.intent);
      const expectedOriginal = protectionRequestSchema.parse({
        requestId: originalId,
        masterTradeId: eventId,
        entryRequestId: attempt.attemptId,
        accountId,
        symbol: command.symbol,
        positionSide: command.side,
        type,
        quantity: position.quantity,
        triggerPrice:
          type === 'STOP_LOSS' ? prices.stopPrice : prices.targetPrice,
        reduceOnly: true,
      });
      if (
        previous &&
        !protectionMatches({ ...previous, status: 'ACTIVE' }, expectedOriginal)
      )
        return this.fail('ACCOUNT_MAPPING_CORRUPT');
      const child = this.journal
        .allChildren()
        .find(
          (row) =>
            row.requestId === attempt.attemptId && row.accountId === accountId,
        );
      const neverSubmitted =
        previous === null &&
        child !== undefined &&
        !child.protectionOrderIds.includes(originalId) &&
        attempt.outcome.reason !== 'FILL_RISK_CHANGED';
      if (
        !neverSubmitted &&
        (!previous ||
          previous.status !== 'REJECTED' ||
          previous.requestId !== originalId ||
          previous.entryRequestId !== attempt.attemptId ||
          previous.accountId !== accountId ||
          !new D(previous.filledSize).isZero())
      )
        throw new Error('PROTECTION_RETRY_UNPROVEN');
      request = protectionRequestSchema.parse({
        requestId: neverSubmitted ? originalId : key,
        masterTradeId: eventId,
        entryRequestId: attempt.attemptId,
        accountId,
        symbol: command.symbol,
        positionSide: command.side,
        type,
        quantity: position.quantity,
        triggerPrice:
          type === 'STOP_LOSS' ? prices.stopPrice : prices.targetPrice,
        reduceOnly: true,
      });
    } else if (!this.adapter.flattenOwnedPosition)
      throw new Error('CONDITIONAL_FLATTEN_UNSUPPORTED');
    const claim = this.journal.repairs.claim(
      attempt.attemptId,
      operation,
      { commandId: command.commandId, request },
      this.clock(),
    );
    if (!claim.fresh) return { update: update(), repair: claim.record };
    this.active(revision);
    if (!this.readiness.available(accountId))
      throw new Error('OFFLINE_REPAIR_LOCKED');
    if (operation === 'FLATTEN')
      this.journal.copier.recordFollowerDisposition({
        eventId,
        followerAccountId: accountId,
        reason: 'OPERATOR_FLATTEN',
        observedAt: this.clock(),
      });
    let repair = this.journal.repairs.update(
      key,
      'CLAIMED',
      'DISPATCHING',
      this.clock(),
    );
    try {
      if (request) {
        const verifiedProtection = (raw: unknown) => {
          const parsed = protectionOrderSchema.safeParse(raw);
          if (
            !parsed.success ||
            !protectionMatches(
              { ...parsed.data, status: 'ACTIVE', filledSize: '0' },
              request!,
            )
          )
            return this.fail('ACCOUNT_MAPPING_CORRUPT');
          return protectionMatches(parsed.data, request!);
        };
        const result = await read(() =>
          this.adapter.repairOwnedProtection!(request!, account.revision),
        );
        if (!verifiedProtection(result))
          throw new Error('REPAIR_PROTECTION_UNVERIFIED');
        const checked = await read(() =>
          this.adapter.getProtectionOrder(accountId, request!.requestId),
        );
        if (!checked || !verifiedProtection(checked))
          throw new Error('REPAIR_PROTECTION_UNVERIFIED');
        const fresh = await books();
        const owned = scope(fresh.account, fresh.ledger, fresh.orders);
        const prices = protectionPrices(owned.entryPrice, batch.intent);
        const verified = (type: 'STOP_LOSS' | 'TAKE_PROFIT') =>
          fresh.orders.some((order) =>
            protectionMatches(order, {
              requestId: order.requestId,
              masterTradeId: eventId,
              entryRequestId: attempt.attemptId,
              accountId,
              symbol: command.symbol,
              positionSide: command.side,
              type,
              quantity: owned.quantity,
              triggerPrice:
                type === 'STOP_LOSS' ? prices.stopPrice : prices.targetPrice,
              reduceOnly: true,
            }),
          );
        const stop = verified('STOP_LOSS')
            ? ('VERIFIED' as const)
            : ('UNKNOWN' as const),
          target = verified('TAKE_PROFIT')
            ? ('VERIFIED' as const)
            : ('UNKNOWN' as const);
        observe(
          {
            ...attempt.outcome,
            stop,
            target,
            reason:
              stop !== 'VERIFIED'
                ? 'SL_MISSING'
                : target !== 'VERIFIED'
                  ? 'TP_MISSING'
                  : 'NONE',
          },
          'FILLED',
        );
      } else {
        await read(() =>
          this.adapter.flattenOwnedPosition!({
            accountId,
            entryRequestId: attempt.attemptId,
            expectedRevision: account.revision,
          }),
        );
        const after = this.accounts(
          await read(() => this.adapter.listAccounts()),
        ).find((a) => a.accountId === accountId)!;
        const remaining = await read(() =>
          this.adapter.getOpenOrders(accountId),
        );
        if (after.positions.length || remaining.length)
          throw new Error('REPAIR_FLATTEN_UNVERIFIED');
        observe(
          {
            ...attempt.outcome,
            exposure: 'ABSENT',
            stop: 'NOT_REQUIRED',
            target: 'NOT_REQUIRED',
            reason: 'EXIT_VERIFIED',
          },
          'EXITED',
        );
      }
      repair = this.journal.repairs.update(
        key,
        'DISPATCHING',
        'VERIFIED',
        this.clock(),
      );
    } catch (error) {
      if (
        error instanceof Error &&
        [
          'REPAIR_STORAGE_FAILED',
          'REPAIR_STORAGE_INVALID',
          'REPAIR_STATE_CONFLICT',
        ].includes(error.message)
      )
        this.halt('JOURNAL_INTEGRITY_LOST');
      // A later repair-audit failure cannot undo independently verified exit truth.
      if (!exitVerified())
        observe(
          {
            ...attempt.outcome,
            exposure: 'UNKNOWN',
            stop: 'UNKNOWN',
            target: 'UNKNOWN',
            reason: 'PROVIDER_UNCERTAIN',
          },
          attempt.terminal?.result ?? null,
        );
      repair = this.journal.repairs.update(
        key,
        'DISPATCHING',
        'UNKNOWN',
        this.clock(),
        'REPAIR_REQUIRES_RECONCILIATION',
      );
    }
    return { update: update(), repair };
  }
  private async deadline<T>(
    operation: Promise<T>,
    pending?: Set<Promise<unknown>>,
  ): Promise<T> {
    const tracked = operation.then(
      () => undefined,
      () => undefined,
    );
    pending?.add(tracked);
    void tracked.then(() => pending?.delete(tracked));
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        operation,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error('FOLLOWER_TIMEOUT')),
            this.timeoutMs,
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
  private async provider<T>(run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (error) {
      if (error instanceof CopierSystemError) return this.fail(error.reason);
      const transport = this.adapter as OfflineFanoutAdapter & {
        status?: () => string;
      };
      const state = transport.status?.();
      if (
        state === 'QUARANTINED' ||
        state === 'CLOSED' ||
        state === 'DISCONNECTED'
      )
        return this.fail('CHANNEL_INTEGRITY_LOST');
      throw new Error('FOLLOWER_PROVIDER_UNAVAILABLE');
    }
  }
  private active(revision: number) {
    if (this.status() !== 'ARMED' || revision !== this.armRevision)
      throw new Error('OFFLINE_ENTRY_LOCKED');
  }
  async copyEntry(
    eventId: string,
    input: TradeIntent,
  ): Promise<FollowerCopyUpdate[]> {
    const event = this.journal.copier.leaderEvent(eventId);
    const parsed = intentSchema.safeParse(input);
    if (!event || !parsed.success || event.kind !== 'ENTRY')
      throw new Error('OFFLINE_ENTRY_EVENT_REFUSED');
    const intent = parsed.data;
    const replay = this.snapshot(eventId);
    // Restart/reconnect only reads existing commands. It cannot create missing followers while locked.
    if (this.status() !== 'ARMED') {
      if (replay.length) return replay;
      throw new Error('OFFLINE_ENTRY_LOCKED');
    }
    const policy = structuredClone(this.armState!),
      revision = this.armRevision;
    if (this.journal.copier.fanoutBatch(eventId)) {
      this.journal.copier.claimFanoutBatch(
        { eventId, followerAccountIds: policy.followerAccountIds, intent },
        this.generation,
        this.clock(),
      );
      return this.snapshot(eventId);
    }
    if (
      event.leaderAccountId !== policy.leaderAccountId ||
      event.symbol !== policy.symbol ||
      intent.symbol !== event.symbol ||
      intent.side !== event.side ||
      !new D(intent.leverage).eq(event.leverage)
    )
      return this.fail('EVENT_IDENTITY_CORRUPT');
    if (new D(intent.leverage).gt(policy.maxLeverage))
      throw new Error('OFFLINE_RISK_ENVELOPE_REFUSED');
    let fleet: Account[], quote: FleetPreview['quote'];
    let prepared: PreparedFollowers;
    try {
      const cached = this.preparation;
      const bundle =
        cached && this.readiness.reusable(cached.prepared, intent)
          ? cached
          : await this.prepareFollowers(intent);
      ({ fleet, quote, prepared } = bundle);
      this.active(revision);
    } catch (error) {
      if (error instanceof CopierSystemError) throw error;
      if (this.status() !== 'ARMED') throw new Error('OFFLINE_ENTRY_LOCKED');
      return this.fail('CHANNEL_INTEGRITY_LOST');
    }
    const createdAt = this.clock();
    const preview: FleetPreview = {
      previewId: copierHash([eventId, intent, createdAt, fleet]),
      createdAt,
      intent,
      quote,
      accounts: fleet.filter((a) =>
        policy.followerAccountIds.includes(a.accountId),
      ),
      orders: [],
      exposureViolations: [],
    };
    preview.orders = preview.accounts.map((a) =>
      prepared.approvals.find((p) => p.accountId === a.accountId)!,
    );
    const activation = this.journal.copier.claimFanoutBatch(
      { eventId, followerAccountIds: policy.followerAccountIds, intent },
      this.generation,
      this.clock(),
      { accounts: fleet, maxAgeMs: this.config.maxDataAgeMs },
    );
    if (!activation.fresh) return this.snapshot(eventId);
    const jobs = policy.followerAccountIds.map((accountId) => {
      const index = preview.accounts.findIndex(
          (a) => a.accountId === accountId,
        ),
        planned = preview.orders[index];
      if (!planned)
        return Promise.reject(new CopierSystemError('ACCOUNT_MAPPING_CORRUPT'));
      const commandId = followerCommandId(eventId, accountId),
        old = this.journal.copier.followerCommand(commandId);
      if (old) {
        const attempt =
          this.journal.copier.followerAttempts(commandId).at(-1) ?? null;
        const update = {
          eventId,
          accountId,
          command: old,
          attempt,
          error: null,
          replayed: true,
        };
        this.publish(update);
        return Promise.resolve(update);
      }
      if (
        !planned.approved ||
        new D(planned.notional).gt(policy.maxNotionalPerAccount) ||
        new D(planned.totalPlannedLoss).gt(policy.maxPlannedLossPerAccount)
      )
        return Promise.resolve(
          this.skip(eventId, accountId, 'FOLLOWER_RISK_NOT_READY'),
        );
      try {
        this.active(revision);
        const claim = this.journal.copier.claimFollowerAttempt(
          {
            eventId,
            followerAccountId: accountId,
            quantity: planned.quantity,
            leverage: intent.leverage,
          },
          this.generation,
          this.clock(),
          { accounts: fleet, maxAgeMs: this.config.maxDataAgeMs },
        );
        if (!claim.fresh)
          return Promise.resolve({
            eventId,
            accountId,
            command: claim.command,
            attempt: claim.attempt,
            error: null,
            replayed: true,
          });
        const key = accountId,
          predecessor = this.lanes.get(key) ?? Promise.resolve(),
          pending = new Set<Promise<unknown>>();
        const run = predecessor.then(() =>
          this.runFollower(
            claim.command,
            claim.attempt,
            preview,
            planned,
            index,
            policy,
            revision,
            pending,
            prepared,
          ),
        );
        // A timed-out operation does not release its account lane until it actually settles.
        const tail = run
          .then(
            () => undefined,
            () => undefined,
          )
          .then(async () => {
            await Promise.allSettled([...pending]);
          });
        this.lanes.set(key, tail);
        void tail.then(() => {
          if (this.lanes.get(key) === tail) this.lanes.delete(key);
        });
        this.publish({
          eventId,
          accountId,
          command: claim.command,
          attempt: claim.attempt,
          error: null,
          replayed: false,
        });
        return run;
      } catch (error) {
        if (error instanceof Error && localAdmission.has(error.message))
          return Promise.resolve(this.skip(eventId, accountId, error.message));
        if (error instanceof Error && error.message === 'OFFLINE_ENTRY_LOCKED')
          return Promise.resolve({
            eventId,
            accountId,
            command: null,
            attempt: null,
            error: 'OFFLINE_ENTRY_LOCKED',
            replayed: false,
          });
        this.halt(
          this.globalStop() === 'UNSAFE_FLEET_EXPOSURE'
            ? 'UNSAFE_FLEET_EXPOSURE'
            : 'JOURNAL_INTEGRITY_LOST',
        );
        return Promise.resolve({
          eventId,
          accountId,
          command: null,
          attempt: null,
          error: 'COPIER_GLOBAL_STOP',
          replayed: false,
        });
      }
    });
    return Promise.all(jobs);
  }
  private skip(
    eventId: string,
    accountId: string,
    error: string,
  ): FollowerCopyUpdate {
    this.journal.copier.recordFollowerDisposition({
      eventId,
      followerAccountId: accountId,
      reason: 'SKIPPED',
      observedAt: this.clock(),
    });
    this.journal.log({
      timestamp: this.clock(),
      masterTradeId: eventId,
      accountId,
      status: 'FOLLOWER_NOT_ATTEMPTED',
      error,
      adapter: this.adapter.name,
    });
    const update = {
      eventId,
      accountId,
      command: null,
      attempt: null,
      error,
      replayed: false,
    };
    this.publish(update);
    return update;
  }
  private async runFollower(
    command: FollowerCommand,
    initial: FollowerAttempt,
    preview: FleetPreview,
    planned: RiskPreview,
    index: number,
    policy: OfflineFanoutArm,
    revision: number,
    pending: Set<Promise<unknown>>,
    prepared: PreparedFollowers,
  ): Promise<FollowerCopyUpdate> {
    let attempt = initial;
    const detection = this.journal.copier.firstDetection(command.eventId);
    const stamp = (
      phase:
        | 'SUBMIT_STARTED'
        | 'ACKNOWLEDGED'
        | 'FILL_DETECTED'
        | 'PROTECTION_DETECTED',
    ) => {
      try {
        this.journal.latency.recordStamp({
          environment: 'OFFLINE_FIXTURE',
          evidence: 'SYNTHETIC',
          eventId: command.eventId,
          accountId: command.followerAccountId,
          attemptId: attempt.attemptId,
          phase,
          observedAt: this.clock(),
          clockSource: 'SYNTHETIC_CONTROLLER_WALL',
          generation: this.generation,
        });
      } catch {
        return this.fail('JOURNAL_INTEGRITY_LOST');
      }
    };
    if (detection) {
      try {
        this.journal.latency.recordStamp({
          environment: 'OFFLINE_FIXTURE',
          evidence: 'SYNTHETIC',
          eventId: command.eventId,
          accountId: command.followerAccountId,
          attemptId: attempt.attemptId,
          phase: 'LEADER_DETECTED',
          observedAt: detection.detectedAt,
          clockSource: 'SYNTHETIC_CONTROLLER_WALL',
          generation: detection.generation,
        });
      } catch {
        return this.fail('JOURNAL_INTEGRITY_LOST');
      }
    }
    let fleet: Account[] = preview.accounts;
    let lastLedger: OrderResult | null = null;
    let lastAccount: Account | null = null;
    let localFailure: string | null = null;
    let lastProtection: 'STOP_LOSS' | 'TAKE_PROFIT' | null = null;
    const publish = (error: string | null = null) => {
      const update = {
        eventId: command.eventId,
        accountId: command.followerAccountId,
        command,
        attempt,
        error,
        replayed: false,
      };
      this.publish(update);
      return update;
    };
    const observe = (
      outcome: AttemptObservation['outcome'],
      result: TerminalProof['result'] | null = null,
    ) => {
      const at = this.clock();
      const proof = result
        ? {
            evidence: 'SYNTHETIC' as const,
            attemptId: attempt.attemptId,
            payloadHash: command.payloadHash,
            accountId: command.followerAccountId,
            result,
            providerOrderId: result === 'NOT_SENT' ? null : attempt.attemptId,
            noFutureExecution: true as const,
            remainingQuantity: '0' as const,
            observedAt: at,
          }
        : null;
      try {
        attempt = this.journal.copier.recordAttemptObservation(
          attempt.attemptId,
          attempt.revision,
          {
            observationId: randomUUID(),
            observedAt: at,
            outcome,
            terminal: proof,
          },
        );
      } catch {
        return this.fail('JOURNAL_INTEGRITY_LOST');
      }
      publish();
    };
    const preserve = () => attempt.terminal?.result ?? null;
    const checkAccount = (raw: unknown, id: string) => {
      const parsed = accountSchema.safeParse(raw);
      if (
        !parsed.success ||
        parsed.data.accountId !== id ||
        !this.fleetIds.includes(id) ||
        !isFresh(
          parsed.data.lastSyncTimestamp,
          this.clock(),
          this.config.maxDataAgeMs,
        )
      )
        return this.fail('ACCOUNT_MAPPING_CORRUPT');
      const p = parsed.data.positions.find(
        (p) => p.entryRequestId === attempt.attemptId,
      );
      if (
        p &&
        (p.side !== command.side ||
          p.symbol !== command.symbol ||
          !new D(p.leverage).eq(command.leverage) ||
          new D(p.quantity).gt(command.quantity))
      )
        return this.fail('ACCOUNT_MAPPING_CORRUPT');
      if (
        p &&
        lastLedger &&
        lastLedger.entryPrice !== null &&
        new D(lastLedger.filledSize).gt(0) &&
        new D(p.quantity).eq(lastLedger.filledSize) &&
        new D(p.entryPrice).eq(lastLedger.entryPrice) &&
        !attempt.terminal &&
        (lastLedger.status === 'UNKNOWN' ||
          (lastLedger.status === 'PARTIALLY_FILLED' &&
            !lastLedger.remainderCanceled)) &&
        !new D(attempt.outcome.filledQuantity).eq(lastLedger.filledSize)
      )
        observe(
          {
            ...attempt.outcome,
            submission: 'UNKNOWN',
            fill: new D(lastLedger.filledSize).eq(command.quantity)
              ? 'FILLED'
              : 'PARTIAL',
            filledQuantity: lastLedger.filledSize,
            fillPrice: lastLedger.entryPrice,
            exposure: 'PRESENT',
            reason: 'PROVIDER_UNCERTAIN',
          },
          null,
        );
      return parsed.data;
    };
    const entryResult = (raw: unknown, id: string, accountId: string) => {
      try {
        const result = validateResult(raw, id, accountId);
        if (new D(result.filledSize).gt(command.quantity))
          return this.fail('EVENT_IDENTITY_CORRUPT');
        return {
          ...result,
          error:
            result.error === null
              ? null
              : result.status === 'REJECTED'
                ? 'ENTRY_REJECTED'
                : 'PROVIDER_UNCERTAIN',
        };
      } catch {
        return this.fail('ACCOUNT_MAPPING_CORRUPT');
      }
    };
    const adapter: ExecutionAdapter = {
      mode: 'SIMULATION',
      name: this.adapter.name,
      connect: () => this.adapter.connect(),
      disconnect: () => this.adapter.disconnect(),
      listAccounts: async () => {
        fleet = this.accounts(
          await this.provider(() => this.adapter.listAccounts()),
        );
        return fleet;
      },
      getAccountState: async (id) => {
        lastAccount = checkAccount(
          await this.provider(() => this.adapter.getAccountState(id)),
          id,
        );
        return lastAccount;
      },
      getQuote: async () => {
        const q = quoteSchema.safeParse(
          await this.provider(() => this.adapter.getQuote()),
        );
        if (
          !q.success ||
          !isFresh(q.data.timestamp, this.clock(), this.config.maxDataAgeMs)
        )
          return this.fail('LEADER_IDENTITY_UNCERTAIN');
        return q.data;
      },
      placeOrder: async (request) => {
        this.active(revision);
        stamp('SUBMIT_STARTED');
        const promise = this.provider(() =>
          this.adapter.placeOrder(structuredClone(request)),
        );
        publish();
        const result = entryResult(
          await promise,
          request.requestId,
          request.accountId,
        );
        stamp('ACKNOWLEDGED');
        return result;
      },
      getOrder: async (id) => {
        const raw = await this.provider(() => this.adapter.getOrder(id));
        lastLedger =
          raw === null ? null : entryResult(raw, id, command.followerAccountId);
        return lastLedger;
      },
      placeProtectionOrder: async (request) => {
        lastProtection = request.type;
        observe(
          {
            ...attempt.outcome,
            ...(request.type === 'STOP_LOSS'
              ? { stop: 'PENDING' as const, stopPrice: request.triggerPrice }
              : {
                  target: 'PENDING' as const,
                  targetPrice: request.triggerPrice,
                }),
          },
          preserve(),
        );
        return this.provider(() =>
          this.adapter.placeProtectionOrder(structuredClone(request)),
        );
      },
      getProtectionOrder: async (id, orderId) => {
        const raw = await this.provider(() =>
          this.adapter.getProtectionOrder(id, orderId),
        );
        if (raw === null) return null;
        const o = protectionOrderSchema.safeParse(raw);
        if (
          !o.success ||
          o.data.accountId !== id ||
          o.data.orderId !== orderId ||
          o.data.entryRequestId !== attempt.attemptId ||
          o.data.symbol !== command.symbol ||
          o.data.positionSide !== command.side
        )
          return this.fail('ACCOUNT_MAPPING_CORRUPT');
        return o.data;
      },
      getOpenOrders: async (id) => {
        const raw = await this.provider(() => this.adapter.getOpenOrders(id));
        const orders = z.array(protectionOrderSchema).safeParse(raw);
        if (
          !orders.success ||
          orders.data.some((o) => o.accountId !== id || o.status !== 'ACTIVE')
        )
          return this.fail('ACCOUNT_MAPPING_CORRUPT');
        return orders.data;
      },
      cancelOrder: (id, orderId) => this.adapter.cancelOrder(id, orderId),
      flattenAccount: (id) => this.adapter.flattenAccount(id),
    };
    const matches = protectionMatches;
    const entryBlocked = () =>
      this.status() !== 'ARMED' || revision !== this.armRevision;
    const recoveryBlocked = () => {
      const stop = this.globalStop();
      return stop !== null && stop !== 'UNSAFE_FLEET_EXPOSURE';
    };
    const writes: Pick<Journal, 'child' | 'log'> = {
      child: (id, result) => {
        try {
          this.journal.child(id, result);
        } catch {
          return this.fail('JOURNAL_INTEGRITY_LOST');
        }
      },
      log: (event) => {
        try {
          this.journal.log(event);
        } catch {
          return this.fail('JOURNAL_INTEGRITY_LOST');
        }
      },
    };
    const context: AccountExecutionContext = {
      adapter,
      config: this.config,
      journal: writes,
      clock: this.clock,
      deadline: <T>(p: Promise<T>) => this.deadline(p, pending),
      get circuitOpen() {
        return entryBlocked();
      },
      get protectionBlocked() {
        return recoveryBlocked();
      },
      metrics: {
        entries: 0,
        partialFills: 0,
        protectionFailures: 0,
        lastFillLatencyMs: 0,
        lastProtectionLatencyMs: 0,
      },
      transition: (id, result, state) => {
        result.state = state;
        writes.child(id, result);
        writes.log({
          timestamp: this.clock(),
          masterTradeId: id,
          accountId: command.followerAccountId,
          requestId: attempt.attemptId,
          status: state,
          adapter: this.adapter.name,
        });
        if (state === 'ENTRY_FILLED_UNPROTECTED') stamp('FILL_DETECTED');
        if (state === 'ENTRY_FILLED_UNPROTECTED')
          observe(
            {
              ...attempt.outcome,
              submission: 'ACCEPTED',
              fill: result.entryWasPartial ? 'PARTIAL' : 'FILLED',
              filledQuantity: result.filledSize,
              fillPrice: result.entryPrice,
              exposure: 'PRESENT',
            },
            'FILLED',
          );
        if (state === 'PROTECTION_SUBMITTING')
          observe(
            {
              ...attempt.outcome,
              ...(result.protectionOrderIds.length === 1
                ? { stop: 'PENDING' as const }
                : { target: 'PENDING' as const }),
            },
            preserve(),
          );
      },
      beforeSubmit: (request) => {
        this.active(revision);
        this.readiness.assertDispatch(
          prepared,
          request.intent,
          command.followerAccountId,
          attempt.attemptId,
          command.quantity,
          fleet,
        );
        const current = fleet.find(
          (account) => account.accountId === command.followerAccountId,
        );
        if (
          !current ||
          !lastAccount ||
          current.revision !== lastAccount.revision ||
          current.balance !== lastAccount.balance ||
          current.equity !== lastAccount.equity ||
          current.drawdown.floor !== lastAccount.drawdown.floor ||
          current.positions.length ||
          current.executionStatus === 'UNKNOWN'
        )
          throw new Error('OFFLINE_RISK_ENVELOPE_REFUSED');
        if (
          request.requestId !== attempt.attemptId ||
          request.accountId !== command.followerAccountId ||
          request.intent.side !== command.side ||
          request.intent.symbol !== command.symbol ||
          !new D(request.preview.quantity).eq(command.quantity) ||
          !new D(request.intent.leverage).eq(command.leverage) ||
          new D(request.preview.notional).gt(policy.maxNotionalPerAccount) ||
          new D(request.preview.totalPlannedLoss).gt(
            policy.maxPlannedLossPerAccount,
          )
        )
          throw new Error('OFFLINE_RISK_ENVELOPE_REFUSED');
        try {
          attempt = this.journal.copier.markDispatchStarted(
            attempt.attemptId,
            this.generation,
            this.clock(),
            { accounts: fleet, maxAgeMs: this.config.maxDataAgeMs },
          );
        } catch {
          return this.fail(
            this.globalStop() === 'UNSAFE_FLEET_EXPOSURE'
              ? 'UNSAFE_FLEET_EXPOSURE'
              : 'JOURNAL_INTEGRITY_LOST',
          );
        }
      },
      protectionMatches: matches,
      verifyProtection: async (request) => {
        const raw = await this.deadline(
          adapter.getProtectionOrder(request.accountId, request.requestId),
          pending,
        );
        if (!raw || !matches(raw, request))
          throw new Error('PROTECTION_UNCONFIRMED');
        observe(
          {
            ...attempt.outcome,
            ...(request.type === 'STOP_LOSS'
              ? { stop: 'VERIFIED' as const }
              : { target: 'VERIFIED' as const }),
          },
          preserve(),
        );
      },
      onFailure: (error) => {
        if (error instanceof CopierSystemError) this.halt(error.reason);
        else if (
          error instanceof Error &&
          error.message === 'FILL_RISK_CHANGED'
        )
          localFailure = 'FILL_RISK_CHANGED';
      },
      onUnsafeEntry: async () => 'UNKNOWN',
    };
    try {
      let open;
      try {
        open = await this.deadline(
          adapter.getOpenOrders(command.followerAccountId),
          pending,
        );
      } catch (error) {
        if (error instanceof CopierSystemError) throw error;
        observe({ ...attempt.outcome, reason: 'ACCOUNT_UNAVAILABLE' }, null);
        return publish('FOLLOWER_UNAVAILABLE');
      }
      if (open.length) {
        observe({ ...attempt.outcome, reason: 'DISPATCH_REFUSED' }, null);
        return publish('FOLLOWER_REQUIRES_RECONCILIATION');
      }
      const result = await executeAccount.call(
        context,
        command.eventId,
        preview,
        planned,
        index,
        performance.now(),
        false,
        attempt.attemptId,
      );
      if (attempt.dispatchStartedAt === null) {
        observe(
          {
            ...attempt.outcome,
            exposure: 'ABSENT',
            reason: 'DISPATCH_REFUSED',
          },
          'NOT_SENT',
        );
        return publish('FOLLOWER_NOT_SENT');
      }
      if (result.status === 'REJECTED') {
        observe(
          {
            ...attempt.outcome,
            submission: 'REJECTED',
            exposure: 'ABSENT',
            reason: 'ENTRY_REJECTED',
          },
          'REJECTED',
        );
        return publish('ENTRY_REJECTED');
      }
      if (result.state !== 'PROTECTED') {
        if (attempt.outcome.submission === 'ACCEPTED')
          observe(
            {
              ...attempt.outcome,
              ...(lastProtection === 'TAKE_PROFIT'
                ? { target: 'FAILED' as const }
                : { stop: 'FAILED' as const }),
              reason:
                localFailure === 'FILL_RISK_CHANGED'
                  ? 'FILL_RISK_CHANGED'
                  : lastProtection === 'TAKE_PROFIT'
                    ? 'TP_MISSING'
                    : 'SL_MISSING',
            },
            preserve(),
          );
        else
          observe(
            {
              ...attempt.outcome,
              submission: 'UNKNOWN',
              reason: new D(attempt.outcome.filledQuantity).gt(0)
                ? 'PROVIDER_UNCERTAIN'
                : 'ACKNOWLEDGEMENT_LOST',
            },
            null,
          );
        return publish(localFailure ?? 'FOLLOWER_REQUIRES_REPAIR');
      }
      stamp('PROTECTION_DETECTED');
      return publish();
    } catch (error) {
      if (error instanceof CopierSystemError) this.halt(error.reason);
      else this.halt('JOURNAL_INTEGRITY_LOST');
      return publish('COPIER_GLOBAL_STOP');
    }
  }
}
