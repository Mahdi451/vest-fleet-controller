import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { initialFleet } from '../packages/core/src/index.ts';
import { Journal } from '../packages/execution/src/journal.ts';
import { leaderEventId } from '../packages/execution/src/copier-events.ts';
import {
  createConnectedProvider,
  normalizeProviderEntry,
  normalizeProviderInventory,
  SyntheticProviderEventIntake,
  type ProviderBinding,
  type ProviderEntryEvidence,
  type ProviderInventory,
} from '../packages/browser-execution/src/bridge/provider-evidence.ts';

const now = 1000;
function fixture() {
  const contexts = ['01', '02'].map((accountId) => ({
    accountId,
    contextId: `fixture-${accountId}`,
    generation: randomUUID(),
    state: 'READY' as const,
    identityVerifiedAt: now,
  }));
  const binding: ProviderBinding = {
    expectedAccountIds: ['01', '02'],
    contexts,
    maxAgeMs: 100,
  };
  const inventory: ProviderInventory = {
    environment: 'OFFLINE_FIXTURE',
    evidence: 'SYNTHETIC',
    complete: true,
    capturedAt: now,
    contexts: structuredClone(contexts),
    accounts: initialFleet(now).slice(0, 2),
    quote: { symbol: 'NDX', price: '20000', timestamp: now },
    market: {
      symbol: 'NDX',
      priceUnit: 'INDEX_POINTS',
      quantityUnit: 'USD_PER_INDEX_POINT',
      accountCurrency: 'USD',
      tickSize: '0.25',
      sizeStep: '0.01',
      minimumQuantity: '0.01',
      maximumQuantity: '100',
      maximumLeverage: '50',
      entryFeeRate: '0.0001',
      exitFeeRate: '0.0001',
      accountCost: '0',
      slippagePointsPerSide: '0',
      fundingRateAllowance: '0',
      drawdownModel: 'FIXED',
      protectionSemantics: 'REDUCE_ONLY_FULL_POSITION',
      capturedAt: now,
    },
  };
  const entry: ProviderEntryEvidence = {
    environment: 'OFFLINE_FIXTURE',
    evidence: 'SYNTHETIC',
    context: contexts[1]!,
    capturedAt: now,
    accountId: '02',
    requestId: 'request-02',
    providerOrderId: 'order-02',
    symbol: 'NDX',
    status: 'FILLED',
    requestedQuantity: '2',
    filledQuantity: '2',
    fillPrice: '20000',
    fees: '0.1',
    remainder: { state: 'FILLED', quantity: '0', noFutureExecution: true },
    rejectionCode: null,
  };
  const expected = {
    accountId: '02',
    requestId: 'request-02',
    symbol: 'NDX' as const,
    quantity: '2',
  };
  const stream = {
    environment: 'OFFLINE_FIXTURE' as const,
    evidence: 'SYNTHETIC' as const,
    leaderAccountId: '01',
    sourceId: 'synthetic-source',
    symbol: 'NDX' as const,
    baselineSequence: 10,
  };
  const event = {
    ...stream,
    origin: 'ACCEPTED_EVENT' as const,
    providerEventId: 'entry-11',
    entryRootId: 'entry-11',
    sequence: 11,
    occurredAt: now,
    kind: 'ENTRY' as const,
    side: 'LONG' as const,
    quantity: '2',
    leverage: '10',
  };
  const { baselineSequence: _unused, ...eventFacts } = event;
  void _unused;
  return {
    binding,
    inventory,
    entry,
    expected,
    stream,
    event: eventFacts,
    contexts,
  };
}
function intakeFixture() {
  const f = fixture(),
    journal = new Journal(),
    intake = new SyntheticProviderEventIntake(
      journal.copier,
      f.binding,
      () => now,
    );
  const bootstrap = {
    environment: 'OFFLINE_FIXTURE',
    evidence: 'SYNTHETIC',
    origin: 'SNAPSHOT_BASELINE',
    inventory: f.inventory,
    stream: f.stream,
  };
  const frame = {
    environment: 'OFFLINE_FIXTURE',
    evidence: 'SYNTHETIC',
    origin: 'ACCEPTED_PROVIDER_EVENT',
    context: f.contexts[0]!,
    capturedAt: now,
    event: f.event,
  };
  return { ...f, journal, intake, bootstrap, frame };
}

describe('original synthetic provider evidence contract', () => {
  it('validates complete, fresh, identity-bound inventory with explicit economics', () => {
    const f = fixture();
    expect(normalizeProviderInventory(f.inventory, f.binding, now)).toEqual(
      f.inventory,
    );
  });
  it.each(['missing', 'duplicate', 'extra'] as const)(
    'refuses %s inventory membership',
    (mode) => {
      const f = fixture();
      if (mode === 'missing') f.inventory.accounts.pop();
      if (mode === 'duplicate')
        f.inventory.accounts[1] = structuredClone(f.inventory.accounts[0]!);
      if (mode === 'extra') f.inventory.accounts.push(initialFleet(now)[2]!);
      expect(() =>
        normalizeProviderInventory(f.inventory, f.binding, now),
      ).toThrow('PROVIDER_INVENTORY_UNPROVEN');
    },
  );
  it.each(['contextId', 'generation', 'state'] as const)(
    'refuses changed %s',
    (field) => {
      const f = fixture(),
        context = f.inventory.contexts[1]!;
      if (field === 'contextId') context.contextId = 'other-context';
      if (field === 'generation') context.generation = randomUUID();
      if (field === 'state') context.state = 'STALE';
      expect(() =>
        normalizeProviderInventory(f.inventory, f.binding, now),
      ).toThrow('PROVIDER_CONTEXT_UNPROVEN');
    },
  );
  it.each(['capturedAt', 'context', 'account', 'quote', 'market'] as const)(
    'refuses stale %s',
    (field) => {
      const f = fixture();
      if (field === 'capturedAt') f.inventory.capturedAt = 899;
      if (field === 'context')
        f.inventory.contexts[1]!.identityVerifiedAt = 899;
      if (field === 'account') f.inventory.accounts[1]!.lastSyncTimestamp = 899;
      if (field === 'quote') f.inventory.quote.timestamp = 899;
      if (field === 'market') f.inventory.market.capturedAt = 899;
      expect(() =>
        normalizeProviderInventory(f.inventory, f.binding, now),
      ).toThrow('PROVIDER_EVIDENCE_STALE');
    },
  );
  it('rejects missing or unknown metadata and live evidence without defaults', () => {
    const f = fixture();
    const { sizeStep: _missing, ...market } = f.inventory.market;
    void _missing;
    for (const inventory of [
      { ...f.inventory, market },
      {
        ...f.inventory,
        market: { ...f.inventory.market, quantityUnit: 'LOTS' },
      },
      { ...f.inventory, environment: 'LIVE' },
      { ...f.inventory, complete: false },
    ])
      expect(() =>
        normalizeProviderInventory(inventory, f.binding, now),
      ).toThrow('PROVIDER_EVIDENCE_INVALID');
    expect(() => createConnectedProvider()).toThrow(
      'CONNECTED_PROVIDER_EVIDENCE_REQUIRED',
    );
  });
  it('rejects unaligned quotes and quantity units', () => {
    const f = fixture();
    f.inventory.quote.price = '20000.13';
    expect(() =>
      normalizeProviderInventory(f.inventory, f.binding, now),
    ).toThrow('PROVIDER_MARKET_UNPROVEN');
  });
  it('normalizes exact entry evidence without exposing provider strings', () => {
    const f = fixture(),
      normalized = normalizeProviderEntry(f.entry, f.expected, f.binding, now);
    expect(normalized.result).toMatchObject({
      status: 'FILLED',
      filledSize: '2',
      accountId: '02',
      error: null,
    });
    expect(() =>
      normalizeProviderEntry(
        { ...f.entry, rejectionCode: 'secret arbitrary payload' },
        f.expected,
        f.binding,
        now,
      ),
    ).toThrow('PROVIDER_EVIDENCE_INVALID');
  });
  it.each(['accountId', 'requestId', 'requestedQuantity'] as const)(
    'rejects wrong %s correlation',
    (field) => {
      const f = fixture();
      const entry = {
        ...f.entry,
        [field]: field === 'requestedQuantity' ? '3' : 'other-id',
      };
      expect(() =>
        normalizeProviderEntry(entry, f.expected, f.binding, now),
      ).toThrow('PROVIDER_ORDER_CORRELATION_FAILED');
    },
  );
  it('keeps open and unknown partial remainder nonterminal; only proven cancellation is terminal', () => {
    const f = fixture();
    for (const state of ['OPEN', 'UNKNOWN', 'CANCELED'] as const) {
      const partial = {
        ...f.entry,
        status: 'PARTIALLY_FILLED',
        filledQuantity: '1',
        remainder: {
          state,
          quantity: state === 'CANCELED' ? '0' : '1',
          noFutureExecution: state === 'CANCELED',
        },
      };
      expect(
        normalizeProviderEntry(partial, f.expected, f.binding, now).result
          .remainderCanceled,
      ).toBe(state === 'CANCELED');
    }
  });
  it('rejects contradictory fill and remainder facts', () => {
    const f = fixture();
    for (const entry of [
      { ...f.entry, filledQuantity: '3' },
      { ...f.entry, fillPrice: null },
      {
        ...f.entry,
        remainder: { state: 'UNKNOWN', quantity: '0', noFutureExecution: true },
      },
      { ...f.entry, status: 'PARTIALLY_FILLED' },
      { ...f.entry, status: 'REJECTED' },
    ])
      expect(() =>
        normalizeProviderEntry(entry, f.expected, f.binding, now),
      ).toThrow('PROVIDER_ORDER_FACTS_INCONSISTENT');
  });
  it('snapshot bootstrap never manufactures an entry even with an existing position', () => {
    const f = intakeFixture();
    try {
      f.inventory.accounts[0]!.positions = [
        {
          symbol: 'NDX',
          side: 'LONG',
          quantity: '2',
          leverage: '10',
          entryPrice: '20000',
          entryRequestId: 'historical-position',
          protectionStatus: 'NONE',
        },
      ];
      f.intake.bootstrap(f.bootstrap);
      expect(f.journal.copier.leaderEvent(leaderEventId(f.event))).toBeNull();
      expect(() =>
        f.intake.accept({ ...f.frame, origin: 'SNAPSHOT_BASELINE' }),
      ).toThrow('PROVIDER_EVIDENCE_INVALID');
      expect(() => f.intake.bootstrap(f.bootstrap)).toThrow(
        'PROVIDER_BASELINE_ALREADY_SET',
      );
    } finally {
      f.journal.close();
    }
  });
  it('requires a baseline then records accepted events once through the durable journal', () => {
    const f = intakeFixture();
    try {
      expect(() => f.intake.accept(f.frame)).toThrow(
        'PROVIDER_BASELINE_REQUIRED',
      );
      f.intake.bootstrap(f.bootstrap);
      expect(f.intake.accept(f.frame)).toMatchObject({
        fresh: true,
        contiguous: true,
      });
      expect(f.intake.accept(f.frame)).toMatchObject({
        fresh: false,
        contiguous: true,
      });
      expect(f.journal.copier.leaderEvent(leaderEventId(f.event))).toEqual(
        f.event,
      );
    } finally {
      f.journal.close();
    }
  });
  it('preserves gaps, reordered events, baseline refusal, and changed-identity global halt', () => {
    const f = intakeFixture();
    try {
      f.intake.bootstrap(f.bootstrap);
      const second = {
        ...f.frame,
        event: {
          ...f.event,
          providerEventId: 'entry-12',
          entryRootId: 'entry-12',
          sequence: 12,
        },
      };
      expect(f.intake.accept(second)).toMatchObject({ contiguous: false });
      expect(f.intake.accept(f.frame)).toMatchObject({ contiguous: true });
      expect(() =>
        f.intake.accept({ ...f.frame, event: { ...f.event, sequence: 10 } }),
      ).toThrow('EVENT_BEFORE_BASELINE');
      expect(() =>
        f.intake.accept({ ...f.frame, event: { ...f.event, quantity: '3' } }),
      ).toThrow('COPIER_IDENTITY_CONFLICT');
      expect(f.journal.copier.globalStop()).toBe('EVENT_IDENTITY_CORRUPT');
    } finally {
      f.journal.close();
    }
  });
  it('rejects wrong event account, symbol, source, context, generation or future capture', () => {
    const f = intakeFixture();
    try {
      f.intake.bootstrap(f.bootstrap);
      for (const frame of [
        { ...f.frame, event: { ...f.event, leaderAccountId: '02' } },
        { ...f.frame, event: { ...f.event, sourceId: 'wrong-source' } },
        { ...f.frame, event: { ...f.event, symbol: 'BTC' } },
        { ...f.frame, context: f.contexts[1] },
        { ...f.frame, context: { ...f.contexts[0], generation: randomUUID() } },
        { ...f.frame, capturedAt: now + 1 },
      ])
        expect(() => f.intake.accept(frame)).toThrow();
      expect(f.journal.copier.leaderEvent(leaderEventId(f.event))).toBeNull();
    } finally {
      f.journal.close();
    }
  });
});
