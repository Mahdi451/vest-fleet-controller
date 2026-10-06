import { randomUUID } from 'node:crypto';
import {
  D,
  isFresh,
  type Account,
  type Quote,
  type RiskConfig,
  type TradeIntent,
} from '../../core/src/index.ts';
import { sizeTrade, type RiskPreview } from '../../risk-engine/src/index.ts';
import { copierHash } from './copier-events.ts';

export interface ReadinessEnvelope {
  leaderAccountId: string;
  followerAccountIds: string[];
  symbol: 'NDX';
  maxLeverage: string;
  maxNotionalPerAccount: string;
  maxPlannedLossPerAccount: string;
  expiresAt: number;
}
export interface PreparedFollowers {
  source: 'LOCAL_FIXTURE';
  generation: string;
  revision: number;
  preparedAt: number;
  expiresAt: number;
  intentHash: string;
  fleetHash: string;
  contexts: Record<string, string>;
  accountRevisions: Record<string, number>;
  approvals: RiskPreview[];
}

/** Memory-only synthetic authority. Local fixture bindings are not Vest tab attestations. */
export class OfflineFanoutReadiness {
  readonly generation = randomUUID();
  private policy: ReadinessEnvelope | null = null;
  private leaderAccountId: string | null = null;
  private revision = 0;
  private lastObservedAt: number;
  private invalid = false;
  private inventory: string[] = [];
  private contexts = new Map<string, string>();
  private unavailable = new Set<string>();
  private consumed = new Set<string>();
  private issued = new WeakMap<PreparedFollowers, string>();
  constructor(
    private readonly config: RiskConfig,
    private readonly clock: () => number = Date.now,
  ) {
    this.lastObservedAt = clock();
  }
  private now() {
    const now = this.clock();
    if (!Number.isSafeInteger(now) || now < 0 || now < this.lastObservedAt) {
      this.invalidate();
      throw new Error('READINESS_CLOCK_INVALID');
    }
    this.lastObservedAt = now;
    if (this.policy && now >= this.policy.expiresAt) this.lock();
    return now;
  }
  observeClock() {
    return this.now();
  }
  lock() {
    this.policy = null;
    this.revision++;
  }
  invalidate() {
    this.invalid = true;
    this.lock();
    this.contexts.clear();
  }
  arm(policy: ReadinessEnvelope, fleet: Account[]) {
    const now = this.now();
    this.lock();
    if (
      this.invalid ||
      this.unavailable.has(policy.leaderAccountId) ||
      policy.expiresAt <= now ||
      policy.expiresAt - now > 900000
    )
      throw new Error('READINESS_ARM_REFUSED');
    const ids = fleet.map((a) => a.accountId).sort();
    if (
      new Set(ids).size !== ids.length ||
      (this.inventory.length && copierHash(ids) !== copierHash(this.inventory))
    )
      throw new Error('READINESS_INVENTORY_CHANGED');
    this.inventory = ids;
    for (const id of [policy.leaderAccountId, ...policy.followerAccountIds]) {
      if (
        !fleet.some(
          (a) =>
            a.accountId === id &&
            a.enabled &&
            a.status === 'ACTIVE' &&
            isFresh(a.lastSyncTimestamp, now, this.config.maxDataAgeMs),
        )
      )
        throw new Error('READINESS_ACCOUNT_UNPROVEN');
    }
    this.policy = structuredClone(policy);
    this.leaderAccountId = policy.leaderAccountId;
    for (const id of [policy.leaderAccountId, ...policy.followerAccountIds])
      if (!this.contexts.has(id)) this.contexts.set(id, randomUUID());
  }
  invalidateContext(accountId: string) {
    if (!this.contexts.has(accountId))
      throw new Error('READINESS_ACCOUNT_UNPROVEN');
    if (accountId === this.leaderAccountId) {
      this.invalidate();
      return 'GLOBAL' as const;
    }
    this.unavailable.add(accountId);
    this.contexts.delete(accountId);
    return 'LOCAL' as const;
  }
  restoreContext(account: Account) {
    const now = this.now();
    if (
      !this.policy?.followerAccountIds.includes(account.accountId) ||
      !account.enabled ||
      account.status !== 'ACTIVE' ||
      !isFresh(account.lastSyncTimestamp, now, this.config.maxDataAgeMs)
    )
      throw new Error('READINESS_ACCOUNT_UNPROVEN');
    this.contexts.set(account.accountId, randomUUID());
    this.unavailable.delete(account.accountId);
  }
  available(accountId: string) {
    this.now();
    return (
      !!this.policy &&
      this.contexts.has(accountId) &&
      !this.unavailable.has(accountId)
    );
  }
  prepare(
    intent: TradeIntent,
    fleet: Account[],
    quote: Quote,
  ): PreparedFollowers {
    const now = this.now(),
      policy = this.policy;
    if (
      this.invalid ||
      !policy ||
      intent.symbol !== policy.symbol ||
      new D(intent.leverage).gt(policy.maxLeverage)
    )
      throw new Error('READINESS_LOCKED');
    if (
      copierHash(fleet.map((a) => a.accountId).sort()) !==
        copierHash(this.inventory) ||
      fleet.some(
        (a) =>
          a.enabled &&
          !isFresh(a.lastSyncTimestamp, now, this.config.maxDataAgeMs),
      ) ||
      quote.symbol !== policy.symbol ||
      !isFresh(quote.timestamp, now, this.config.maxDataAgeMs)
    )
      throw new Error('READINESS_EVIDENCE_INVALID');
    const leader = fleet.find(
      (account) => account.accountId === policy.leaderAccountId,
    );
    if (
      !leader ||
      !leader.enabled ||
      leader.status !== 'ACTIVE' ||
      !isFresh(leader.lastSyncTimestamp, now, this.config.maxDataAgeMs)
    ) {
      this.invalidate();
      throw new Error('READINESS_LEADER_UNPROVEN');
    }
    const prepared: PreparedFollowers = {
      source: 'LOCAL_FIXTURE',
      generation: this.generation,
      revision: this.revision,
      preparedAt: now,
      expiresAt: Math.min(
        policy.expiresAt,
        now + this.config.maxPreviewAgeMs,
        quote.timestamp + this.config.maxDataAgeMs,
        ...fleet
          .filter((a) => a.enabled)
          .map((a) => a.lastSyncTimestamp + this.config.maxDataAgeMs),
      ),
      intentHash: copierHash(intent),
      fleetHash: copierHash(fleet),
      contexts: Object.fromEntries(this.contexts),
      accountRevisions: Object.fromEntries(
        fleet.map((account) => [account.accountId, account.revision]),
      ),
      approvals: policy.followerAccountIds.map((id) => {
        const account = fleet.find((a) => a.accountId === id);
        if (!account) throw new Error('READINESS_ACCOUNT_UNPROVEN');
        const approval = sizeTrade(account, intent, quote, this.config, now);
        if (
          !this.available(id) ||
          new D(approval.notional).gt(policy.maxNotionalPerAccount) ||
          new D(approval.totalPlannedLoss).gt(policy.maxPlannedLossPerAccount)
        )
          return { ...approval, approved: false };
        return approval;
      }),
    };
    this.issued.set(prepared, copierHash(prepared));
    return prepared;
  }
  reusable(prepared: PreparedFollowers, intent: TradeIntent) {
    const now = this.now();
    return (
      this.issued.get(prepared) === copierHash(prepared) &&
      !this.invalid &&
      !!this.policy &&
      prepared.generation === this.generation &&
      prepared.revision === this.revision &&
      prepared.intentHash === copierHash(intent) &&
      now < prepared.expiresAt
    );
  }
  assertDispatch(
    prepared: PreparedFollowers,
    intent: TradeIntent,
    accountId: string,
    attemptId: string,
    quantity: string,
    fleet: Account[],
  ) {
    if (
      !this.reusable(prepared, intent) ||
      !this.available(accountId) ||
      prepared.contexts[accountId] !== this.contexts.get(accountId) ||
      this.consumed.has(attemptId) ||
      this.consumed.size >= 4096 ||
      copierHash(fleet.map((a) => a.accountId).sort()) !==
        copierHash(this.inventory) ||
      fleet.find((account) => account.accountId === accountId)?.revision !==
        prepared.accountRevisions[accountId]
    )
      throw new Error('READINESS_DISPATCH_REFUSED');
    const approval = prepared.approvals.find((a) => a.accountId === accountId);
    if (!approval?.approved || !new D(approval.quantity).eq(quantity))
      throw new Error('READINESS_DISPATCH_REFUSED');
    this.consumed.add(attemptId);
  }
}
