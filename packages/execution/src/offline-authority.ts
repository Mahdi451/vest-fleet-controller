import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  D,
  accountSchema,
  intentSchema,
  protectionRequestSchema,
  positive,
  type Account,
  type ProtectionOrder,
  type ProtectionRequest,
} from '../../core/src/index.ts';
import { protectionPrices } from '../../risk-engine/src/index.ts';
import {
  childResultSchema,
  validateResult,
  type ChildResult,
  type OrderRequest,
  type OrderResult,
} from './adapter.ts';

const generationSchema = z
  .object({
    environment: z.literal('OFFLINE_FIXTURE'),
    evidence: z.literal('SYNTHETIC'),
    ownerGeneration: z.string().uuid(),
    controllerGeneration: z.string().uuid(),
    browserGeneration: z.string().uuid(),
  })
  .strict();
const armSchema = z
  .object({
    generation: generationSchema,
    previewId: z.string().regex(/^[a-f0-9]{64}$/),
    policyHash: z.string().regex(/^[a-f0-9]{64}$/),
    intent: intentSchema,
    accounts: z
      .array(
        z
          .object({
            accountId: z.string().min(1),
            quantityCeiling: positive,
            lossCeiling: positive,
          })
          .strict(),
      )
      .min(1)
      .max(10),
    issuedAt: z.number().int().nonnegative(),
    expiresAt: z.number().int().nonnegative(),
  })
  .strict();
export type OfflineGeneration = z.infer<typeof generationSchema>;
export type OfflineArm = z.infer<typeof armSchema>;
export const offlinePolicyHash = (value: unknown) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** Synthetic dispatch permission only. This is not browser authentication or live arming. */
export class OfflineDispatchAuthorizer {
  private armState: OfflineArm | null = null;
  private identityValid = true;
  private entriesRevoked = false;
  private lastObservedAt: number;
  private fills = new Map<string, ChildResult>();
  private fillEvidence = new Map<
    string,
    { timestamp: number; maxAgeMs: number }
  >();
  private acceptedEntries = new Map<
    string,
    { masterTradeId: string; accountId: string }
  >();
  private readonly generation: OfflineGeneration;
  constructor(
    generation: OfflineGeneration,
    private readonly clock: () => number = Date.now,
  ) {
    this.generation = generationSchema.parse(generation);
    this.lastObservedAt = clock();
  }
  private observeClock() {
    const now = this.clock();
    if (!Number.isSafeInteger(now) || now < this.lastObservedAt)
      this.invalidateIdentity();
    this.lastObservedAt = now;
    if (this.armState && now >= this.armState.expiresAt)
      this.entriesRevoked = true;
    return now;
  }
  status(): 'LOCKED' | 'ARMED' | 'RECOVERY_ONLY' {
    this.observeClock();
    if (!this.armState || !this.identityValid) return 'LOCKED';
    return this.entriesRevoked || this.clock() >= this.armState.expiresAt
      ? 'RECOVERY_ONLY'
      : 'ARMED';
  }
  arm(value: OfflineArm) {
    const arm = armSchema.parse(value);
    this.observeClock();
    if (
      !this.identityValid ||
      offlinePolicyHash(arm.generation) !==
        offlinePolicyHash(this.generation) ||
      arm.issuedAt > this.clock() ||
      arm.expiresAt <= this.clock() ||
      arm.expiresAt <= arm.issuedAt ||
      arm.expiresAt - arm.issuedAt > 60_000 ||
      new Set(arm.accounts.map((a) => a.accountId)).size !== arm.accounts.length
    )
      throw new Error('OFFLINE_ARM_REFUSED');
    // An existing recovery scope cannot be replaced underneath an outstanding fill.
    if (this.armState) throw new Error('OFFLINE_ARM_ALREADY_BOUND');
    this.armState = structuredClone(arm);
  }
  revokeEntries() {
    this.entriesRevoked = true;
  }
  invalidateIdentity() {
    this.identityValid = false;
    this.entriesRevoked = true;
    this.fills.clear();
    this.fillEvidence.clear();
    this.acceptedEntries.clear();
  }
  private scope(accountId: string) {
    this.observeClock();
    const selected = this.armState?.accounts.find(
      (a) => a.accountId === accountId,
    );
    if (!this.identityValid || !selected)
      throw new Error('OFFLINE_AUTHORITY_LOCKED');
    return selected;
  }
  assertEntry(request: OrderRequest, previewId: string) {
    const selected = this.scope(request.accountId);
    if (
      this.status() !== 'ARMED' ||
      previewId !== this.armState!.previewId ||
      offlinePolicyHash(request.config) !== this.armState!.policyHash ||
      offlinePolicyHash(intentSchema.parse(request.intent)) !==
        offlinePolicyHash(this.armState!.intent) ||
      request.requestId !==
        offlinePolicyHash([request.masterTradeId, request.accountId]) ||
      request.preview.accountId !== request.accountId ||
      !request.preview.approved ||
      request.quote.symbol !== request.intent.symbol ||
      new D(positive.parse(request.preview.quantity)).gt(
        selected.quantityCeiling,
      ) ||
      new D(positive.parse(request.preview.totalPlannedLoss)).gt(
        selected.lossCeiling,
      )
    )
      throw new Error('OFFLINE_ENTRY_REFUSED');
    const accepted = this.acceptedEntries.get(request.requestId);
    if (
      accepted &&
      (accepted.masterTradeId !== request.masterTradeId ||
        accepted.accountId !== request.accountId)
    )
      throw new Error('OFFLINE_ENTRY_REFUSED');
    this.acceptedEntries.set(request.requestId, {
      masterTradeId: request.masterTradeId,
      accountId: request.accountId,
    });
  }
  verifyAccountEvidence(
    account: Account,
    expectedId: string,
    maxAgeMs: number,
  ) {
    const a = accountSchema.parse(account);
    const now = this.observeClock();
    if (
      !Number.isInteger(maxAgeMs) ||
      maxAgeMs <= 0 ||
      maxAgeMs > 60_000 ||
      a.accountId !== expectedId ||
      a.lastSyncTimestamp > now ||
      now - a.lastSyncTimestamp > maxAgeMs
    ) {
      this.invalidateIdentity();
      throw new Error('OFFLINE_IDENTITY_UNCERTAIN');
    }
    this.scope(expectedId);
  }
  recordConfirmedFill(
    value: ChildResult,
    account: Account,
    raw: OrderResult,
    maxEvidenceAgeMs = 1000,
  ) {
    const child = childResultSchema.parse(value);
    const selected = this.scope(child.accountId);
    if (
      this.acceptedEntries.get(child.requestId)?.accountId !== child.accountId
    )
      throw new Error('OFFLINE_FILL_NOT_AUTHORIZED');
    const a = accountSchema.parse(account);
    this.verifyAccountEvidence(a, child.accountId, maxEvidenceAgeMs);
    const ledger = validateResult(raw, child.requestId, child.accountId);
    const p = a.positions[0];
    if (
      !child.intent ||
      a.accountId !== child.accountId ||
      a.positions.length !== 1 ||
      !p ||
      !['FILLED', 'PARTIALLY_FILLED'].includes(ledger.status) ||
      (ledger.status === 'PARTIALLY_FILLED' &&
        ledger.remainderCanceled !== true) ||
      p.entryRequestId !== child.requestId ||
      p.symbol !== child.intent.symbol ||
      p.side !== child.intent.side ||
      !new D(p.leverage).eq(child.intent.leverage) ||
      !new D(p.quantity).eq(ledger.filledSize) ||
      !new D(p.quantity).eq(child.filledSize) ||
      !ledger.entryPrice ||
      !new D(p.entryPrice).eq(ledger.entryPrice) ||
      child.entryPrice !== ledger.entryPrice ||
      new D(p.quantity).gt(selected.quantityCeiling) ||
      offlinePolicyHash(child.intent) !==
        offlinePolicyHash(this.armState!.intent)
    )
      throw new Error('OFFLINE_FILL_REFUSED');
    this.fills.set(child.requestId, structuredClone(child));
    this.fillEvidence.set(child.requestId, {
      timestamp: a.lastSyncTimestamp,
      maxAgeMs: maxEvidenceAgeMs,
    });
  }
  assertProtection(value: ProtectionRequest) {
    const request = protectionRequestSchema.parse(value);
    const selected = this.scope(request.accountId);
    const child = this.fills.get(request.entryRequestId);
    const evidence = this.fillEvidence.get(request.entryRequestId);
    if (
      !evidence ||
      this.clock() < evidence.timestamp ||
      this.clock() - evidence.timestamp > evidence.maxAgeMs
    ) {
      this.invalidateIdentity();
      throw new Error('OFFLINE_IDENTITY_UNCERTAIN');
    }
    if (!child?.intent || !child.entryPrice)
      throw new Error('OFFLINE_PROTECTION_REFUSED');
    const prices = protectionPrices(child.entryPrice, child.intent);
    if (
      !child.actualPlannedLoss ||
      new D(child.actualPlannedLoss).gt(selected.lossCeiling) ||
      request.masterTradeId !==
        this.acceptedEntries.get(child.requestId)?.masterTradeId ||
      request.accountId !== child.accountId ||
      request.symbol !== child.intent.symbol ||
      request.positionSide !== child.intent.side ||
      !request.reduceOnly ||
      !new D(request.quantity).eq(child.filledSize) ||
      request.requestId !==
        offlinePolicyHash([child.requestId, request.type]) ||
      !new D(request.triggerPrice).eq(
        request.type === 'STOP_LOSS' ? prices.stopPrice : prices.targetPrice,
      )
    )
      throw new Error('OFFLINE_PROTECTION_REFUSED');
  }
  assertCancel(order: ProtectionOrder, children: ChildResult[]) {
    this.scope(order.accountId);
    if (
      !children.some(
        (c) =>
          this.acceptedEntries.get(c.requestId)?.masterTradeId ===
            order.masterTradeId &&
          this.acceptedEntries.get(c.requestId)?.accountId ===
            order.accountId &&
          c.accountId === order.accountId &&
          c.requestId === order.entryRequestId &&
          c.intent?.symbol === order.symbol &&
          c.intent.side === order.positionSide &&
          c.protectionOrderIds.includes(order.orderId) &&
          order.reduceOnly &&
          order.orderId === offlinePolicyHash([c.requestId, order.type]),
      )
    )
      throw new Error('OFFLINE_CANCEL_REFUSED');
  }
  assertFlatten(
    account: Account,
    open: ProtectionOrder[],
    children: ChildResult[],
  ) {
    this.scope(account.accountId);
    const a = accountSchema.parse(account);
    if (!a.positions.length && !open.length)
      throw new Error('OFFLINE_FLATTEN_NO_OWNED_EXPOSURE');
    for (const p of a.positions) {
      const child = children.find(
        (c) => c.requestId === p.entryRequestId && c.accountId === a.accountId,
      );
      if (
        !child?.intent ||
        this.acceptedEntries.get(child.requestId)?.accountId !== a.accountId ||
        child.intent.symbol !== p.symbol ||
        child.intent.side !== p.side ||
        !new D(child.intent.leverage).eq(p.leverage) ||
        !child.entryPrice ||
        !new D(child.entryPrice).eq(p.entryPrice) ||
        !new D(child.filledSize).eq(p.quantity)
      )
        throw new Error('OFFLINE_FLATTEN_REFUSED');
    }
    for (const order of open) {
      if (order.accountId !== a.accountId)
        throw new Error('OFFLINE_FLATTEN_REFUSED');
      this.assertCancel(order, children);
    }
  }
}
