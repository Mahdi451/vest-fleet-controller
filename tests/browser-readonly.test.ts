import { describe, expect, it } from 'vitest';
import {
  assertCurrentBookShowsFlat,
  assertCurrentObservation,
  assertReconciledClose,
  assertProtectionCapabilities,
  assertStableIdentity,
  assertUniqueTerminalFill,
  visibleObservationSchema,
  type VisibleAccountRef,
  type VisibleObservation,
} from '../packages/browser-execution/src/observations.ts';
import {
  SerializedInspectionSession,
  type ObservationPermission,
  type ReadonlyInspectionPort,
} from '../packages/browser-execution/src/readonly.ts';

const NOW = 1_800_000_000_000;
const policy = { now: NOW, maxAgeMs: 5000 };
const ref: VisibleAccountRef = {
  visibleId: 'synthetic-funded-a',
  label: 'Synthetic account A',
  product: 'SYNTHETIC_INSTANT',
};
const exact = (value: string) => ({ value, precision: 'EXACT' as const });
const missing = { value: null, precision: 'UNKNOWN' as const };
const fillExpectation = {
  account: ref,
  venueOrderId: 'venue-entry-a',
  venuePositionId: 'venue-position-a',
  role: 'ENTRY' as const,
  market: 'SYNTHETIC_MARKET',
  side: 'LONG' as const,
};
function observation(): VisibleObservation {
  return visibleObservationSchema.parse({
    contextId: 'local-session',
    pageId: 'one-page',
    uiRevision: 'inspected-fixture-v1',
    session: 'AUTHENTICATED',
    account: ref,
    observedAt: NOW,
    venueUpdatedAt: NOW,
    balance: exact('500'),
    equity: exact('500'),
    drawdownFloor: exact('490'),
    dailyLossRuleKnown: true,
    dailyLossFloor: missing,
    quote: {
      market: 'SYNTHETIC_MARKET',
      price: exact('30400'),
      basis: 'MARK',
      venueUpdatedAt: NOW,
    },
    positions: { complete: true, rows: [] },
    openOrders: { complete: true, rows: [] },
    fills: {
      complete: true,
      rows: [
        {
          role: 'ENTRY',
          venuePositionId: 'venue-position-a',
          venueOrderId: 'venue-entry-a',
          clientRequestId: null,
          accountVisibleId: ref.visibleId,
          market: 'SYNTHETIC_MARKET',
          side: 'LONG',
          status: 'FILLED',
          requestedSize: exact('0.01'),
          filledSize: exact('0.01'),
          remainingSize: exact('0'),
          averagePrice: exact('30401.1234'),
          fees: exact('0.01234'),
          remainderCanceled: null,
          venueTimestamp: NOW,
        },
      ],
    },
    protections: { complete: true, rows: [] },
    unresolvedAttempts: false,
  });
}
function protectedObservation() {
  const o = observation();
  o.positions.rows = [
    {
      venuePositionId: 'venue-position-a',
      entryVenueOrderId: 'venue-entry-a',
      accountVisibleId: ref.visibleId,
      market: 'SYNTHETIC_MARKET',
      side: 'LONG',
      quantity: exact('0.01'),
      averagePrice: exact('30401.1234'),
    },
  ];
  o.protections.rows = [
    {
      type: 'STOP_LOSS' as const,
      triggerPrice: exact('30321.1234'),
      venueOrderId: 'venue-stop',
    },
    {
      type: 'TAKE_PROFIT' as const,
      triggerPrice: exact('30481.1234'),
      venueOrderId: 'venue-target',
    },
  ].map((row) => ({
    ...row,
    entryVenueOrderId: 'venue-entry-a',
    accountVisibleId: ref.visibleId,
    market: 'SYNTHETIC_MARKET',
    side: 'LONG',
    quantity: exact('0.01'),
    triggerBasis: 'MARK',
    reduceOnly: true,
    status: 'ACTIVE',
    persistsWithoutBrowser: true,
    siblingCancellation: 'PROVEN',
    siblingGroupId: 'synthetic-sibling-pair',
  }));
  return o;
}
const protectionExpectation = {
  stopPrice: '30321.1234',
  targetPrice: '30481.1234',
  triggerBasis: 'MARK',
};

describe('visible evidence contracts: unknown is never executable state', () => {
  it('preserves null values without synthesizing IDs, timestamps, fees or inventory', () => {
    const o = observation();
    o.account.visibleId = null;
    o.venueUpdatedAt = null;
    o.fills.rows![0]!.fees = missing;
    expect(visibleObservationSchema.parse(o)).toEqual(o);
    expect(() => assertStableIdentity(o.account, ref)).toThrow(
      'ACCOUNT_IDENTITY_MISMATCH',
    );
    expect(() => assertStableIdentity(o.account, o.account)).toThrow(
      'IDENTITY_UNAVAILABLE',
    );
    expect(() =>
      visibleObservationSchema.parse({ ...o, token: 'forbidden-extra' }),
    ).toThrow();
  });
  it('separates fresh capture from stale or missing venue evidence', () => {
    const o = observation();
    assertCurrentObservation(o, ref, NOW, 5000);
    o.venueUpdatedAt = NOW - 5001;
    expect(() => assertCurrentObservation(o, ref, NOW, 5000)).toThrow(
      'ACCOUNT_FRESHNESS_UNPROVEN',
    );
    o.venueUpdatedAt = null;
    expect(() => assertCurrentObservation(o, ref, NOW, 5000)).toThrow(
      'ACCOUNT_FRESHNESS_UNPROVEN',
    );
  });
  it.each([-5001, 1])('rejects stale/future capture (%i ms)', (offset) => {
    const o = observation();
    o.observedAt = NOW + offset;
    expect(() => assertCurrentObservation(o, ref, NOW, 5000)).toThrow(
      'STALE_CAPTURE',
    );
  });
  it.each(['balance', 'equity', 'drawdownFloor'] as const)(
    'does not import a missing %s',
    (field) => {
      const o = observation();
      o[field] = missing;
      expect(() => assertCurrentObservation(o, ref, NOW, 5000)).toThrow(
        'RISK_VALUES_UNAVAILABLE',
      );
    },
  );
  it('requires applicable daily-loss rule evidence', () => {
    const o = observation();
    o.dailyLossRuleKnown = false;
    expect(() => assertCurrentObservation(o, ref, NOW, 5000)).toThrow(
      'DAILY_LOSS_RULE_UNAVAILABLE',
    );
  });
  it.each(['missing', 'basis', 'rounded', 'timestamp'] as const)(
    'blocks unavailable quote %s',
    (fault) => {
      const o = observation();
      if (fault === 'missing') o.quote = null;
      else if (fault === 'basis') o.quote!.basis = null;
      else if (fault === 'rounded') o.quote!.price.precision = 'ROUNDED';
      else o.quote!.venueUpdatedAt = null;
      expect(() => assertCurrentObservation(o, ref, NOW, 5000)).toThrow(
        fault === 'timestamp'
          ? 'QUOTE_FRESHNESS_UNPROVEN'
          : 'QUOTE_UNAVAILABLE',
      );
    },
  );
  it.each(['positions', 'openOrders'] as const)(
    'does not confuse unavailable %s with empty',
    (field) => {
      const o = observation();
      o[field].rows = null;
      expect(() => assertCurrentBookShowsFlat(o, ref, policy)).toThrow(
        field === 'positions'
          ? 'POSITIONS_UNAVAILABLE'
          : 'OPEN_ORDERS_UNAVAILABLE',
      );
    },
  );
  it('local deterministic IDs are insufficient even if echoed in a visible row', () => {
    const o = observation();
    o.fills.rows![0]!.clientRequestId = 'local-intent';
    expect(() =>
      assertUniqueTerminalFill(
        o,
        { ...fillExpectation, venueOrderId: null },
        policy,
      ),
    ).toThrow('VENUE_CORRELATION_UNPROVEN');
  });
  it.each([0, 2])('requires exactly one linked fill, found %i', (count) => {
    const o = observation();
    const fill = o.fills.rows![0]!;
    o.fills.rows = Array.from({ length: count }, () => ({ ...fill }));
    expect(() => assertUniqueTerminalFill(o, fillExpectation, policy)).toThrow(
      'FILL_CORRELATION_AMBIGUOUS',
    );
  });
  it.each(['filledSize', 'averagePrice', 'fees', 'remainingSize'] as const)(
    'rejects rounded %s',
    (field) => {
      const o = observation();
      o.fills.rows![0]![field].precision = 'ROUNDED';
      expect(() =>
        assertUniqueTerminalFill(o, fillExpectation, policy),
      ).toThrow('FILL_PRECISION_UNAVAILABLE');
    },
  );
  it('requires complete fill history and actual destination identity', () => {
    const o = observation();
    o.fills.complete = false;
    expect(() => assertUniqueTerminalFill(o, fillExpectation, policy)).toThrow(
      'FILL_HISTORY_UNAVAILABLE',
    );
    o.fills.complete = true;
    o.fills.rows![0]!.accountVisibleId = 'other-account';
    expect(() => assertUniqueTerminalFill(o, fillExpectation, policy)).toThrow(
      'FILL_IDENTITY_MISMATCH',
    );
  });
  it('rejects a fabricated future fill timestamp', () => {
    const o = observation();
    o.fills.rows![0]!.venueTimestamp = NOW + 1;
    expect(() => assertUniqueTerminalFill(o, fillExpectation, policy)).toThrow(
      'FILL_PRECISION_UNAVAILABLE',
    );
  });
  it('requires a matching actual position and terminal fill for protection proof', () => {
    const o = protectedObservation();
    o.positions.rows![0]!.quantity = exact('0.02');
    expect(() =>
      assertProtectionCapabilities(
        o,
        o.fills.rows![0]!,
        protectionExpectation,
        policy,
      ),
    ).toThrow('PROTECTION_POSITION_UNPROVEN');
    o.fills.rows![0]!.status = 'PENDING';
    expect(() =>
      assertProtectionCapabilities(
        o,
        o.fills.rows![0]!,
        protectionExpectation,
        policy,
      ),
    ).toThrow('FILL_NOT_TERMINAL');
  });
  it('pending fill history blocks flatness even if an unresolved flag is false', () => {
    const o = observation();
    o.fills.rows![0]!.status = 'UNKNOWN';
    expect(() => assertCurrentBookShowsFlat(o, ref, policy)).toThrow(
      'RECONCILIATION_UNAVAILABLE',
    );
  });
  it('a flat book alone cannot prove a completed close', () => {
    const o = observation();
    assertCurrentBookShowsFlat(o, ref, policy);
    expect(() =>
      assertReconciledClose(
        o,
        { ...fillExpectation, exitedQuantity: '0.01' },
        policy,
      ),
    ).toThrow('FILL_IDENTITY_MISMATCH');
    o.fills.rows![0]!.role = 'EXIT';
    expect(
      assertReconciledClose(
        o,
        { ...fillExpectation, exitedQuantity: '0.01' },
        policy,
      ).role,
    ).toBe('EXIT');
    expect(() =>
      assertReconciledClose(
        o,
        { ...fillExpectation, exitedQuantity: '0.02' },
        policy,
      ),
    ).toThrow('CLOSE_QUANTITY_UNPROVEN');
  });
  it('represents a filled protective exit and terminal rejected/canceled siblings', () => {
    const o = protectedObservation();
    o.positions.rows = [];
    o.fills.rows![0]!.role = 'EXIT';
    o.fills.rows![0]!.venueOrderId = 'venue-stop';
    o.protections.rows![0]!.status = 'FILLED';
    o.protections.rows![1]!.status = 'CANCELED';
    const parsed = visibleObservationSchema.parse(o);
    assertReconciledClose(
      parsed,
      {
        ...fillExpectation,
        venueOrderId: 'venue-stop',
        exitedQuantity: '0.01',
      },
      policy,
    );
    o.protections.rows![1]!.status = 'REJECTED';
    assertCurrentBookShowsFlat(o, ref, policy);
    o.protections.rows![1]!.status = 'UNKNOWN';
    expect(() => assertCurrentBookShowsFlat(o, ref, policy)).toThrow(
      'FLATNESS_UNPROVEN',
    );
  });
  it('requires sibling evidence to be bound to the same protection pair', () => {
    const o = protectedObservation();
    o.protections.rows![1]!.siblingGroupId = 'unrelated-pair';
    expect(() =>
      assertProtectionCapabilities(
        o,
        o.fills.rows![0]!,
        protectionExpectation,
        policy,
      ),
    ).toThrow('SIBLING_PAIR_UNPROVEN');
  });
  it.each(['fill', 'protection', 'flat', 'close'] as const)(
    'enforces authenticated fresh capture independently for %s',
    (capability) => {
      const o = protectedObservation();
      const verify = () => {
        if (capability === 'fill')
          return assertUniqueTerminalFill(o, fillExpectation, policy);
        if (capability === 'protection')
          return assertProtectionCapabilities(
            o,
            o.fills.rows![0]!,
            protectionExpectation,
            policy,
          );
        if (capability === 'close')
          return assertReconciledClose(
            o,
            { ...fillExpectation, exitedQuantity: '0.01' },
            policy,
          );
        return assertCurrentBookShowsFlat(o, ref, policy);
      };
      o.session = 'LOGIN_REQUIRED';
      expect(verify).toThrow('MANUAL_REAUTHENTICATION_REQUIRED');
      o.session = 'AUTHENTICATED';
      o.observedAt = NOW - 5001;
      expect(verify).toThrow('STALE_CAPTURE');
    },
  );
  it.each([null, false])(
    'blocks a partial fill without confirmed remainder cancellation (%s)',
    (canceled) => {
      const o = observation();
      const fill = o.fills.rows![0]!;
      fill.status = 'PARTIALLY_FILLED';
      fill.filledSize = exact('0.005');
      fill.remainderCanceled = canceled;
      expect(() =>
        assertUniqueTerminalFill(o, fillExpectation, policy),
      ).toThrow('FILL_NOT_TERMINAL');
    },
  );
  it('accepts exact terminal partial quantity, blocks any continuing remainder', () => {
    const o = observation();
    const fill = o.fills.rows![0]!;
    fill.status = 'PARTIALLY_FILLED';
    fill.filledSize = exact('0.005');
    fill.remainderCanceled = true;
    expect(
      assertUniqueTerminalFill(o, fillExpectation, policy).filledSize.value,
    ).toBe('0.005');
    fill.remainingSize = exact('0.005');
    expect(() => assertUniqueTerminalFill(o, fillExpectation, policy)).toThrow(
      'FILL_NOT_TERMINAL',
    );
  });
  it('verifies exact two-sided protection capability evidence separately from execution', () => {
    const o = protectedObservation();
    const fill = assertUniqueTerminalFill(o, fillExpectation, policy);
    expect(
      assertProtectionCapabilities(o, fill, protectionExpectation, policy),
    ).toHaveLength(2);
  });
  it.each([null, false])('does not assume reduce-only (%s)', (reduceOnly) => {
    const o = protectedObservation();
    o.protections.rows![0]!.reduceOnly = reduceOnly;
    expect(() =>
      assertProtectionCapabilities(
        o,
        o.fills.rows![0]!,
        protectionExpectation,
        policy,
      ),
    ).toThrow('REDUCE_ONLY_UNPROVEN');
  });
  it.each(['ABSENT', 'UNKNOWN'] as const)(
    'preserves sibling cancellation %s',
    (state) => {
      const o = protectedObservation();
      o.protections.rows![0]!.siblingCancellation = state;
      expect(() =>
        assertProtectionCapabilities(
          o,
          o.fills.rows![0]!,
          protectionExpectation,
          policy,
        ),
      ).toThrow('SIBLING_CANCELLATION_UNPROVEN');
      expect(o.protections.rows![0]!.siblingCancellation).toBe(state);
    },
  );
  it.each([
    'missing',
    'quantity',
    'trigger',
    'account',
    'rejected',
    'persistence',
  ] as const)('rejects unsafe protection %s', (fault) => {
    const o = protectedObservation();
    const stop = o.protections.rows![0]!;
    if (fault === 'missing') o.protections.rows!.pop();
    if (fault === 'quantity') stop.quantity = exact('0.02');
    if (fault === 'trigger') stop.triggerBasis = 'UNKNOWN_PRICE_BASIS';
    if (fault === 'account') stop.accountVisibleId = 'other-account';
    if (fault === 'rejected') stop.status = 'REJECTED';
    if (fault === 'persistence') stop.persistsWithoutBrowser = null;
    expect(() =>
      assertProtectionCapabilities(
        o,
        o.fills.rows![0]!,
        protectionExpectation,
        policy,
      ),
    ).toThrow(/PROTECTION_/);
  });
  it('empty positions with incomplete history, unresolved exit or orphan is not flat', () => {
    const o = observation();
    assertCurrentBookShowsFlat(o, ref, policy);
    o.fills.complete = false;
    expect(() => assertCurrentBookShowsFlat(o, ref, policy)).toThrow(
      'RECONCILIATION_UNAVAILABLE',
    );
    o.fills.complete = true;
    o.unresolvedAttempts = true;
    expect(() => assertCurrentBookShowsFlat(o, ref, policy)).toThrow(
      'RECONCILIATION_UNAVAILABLE',
    );
    o.unresolvedAttempts = false;
    o.protections = protectedObservation().protections;
    expect(() => assertCurrentBookShowsFlat(o, ref, policy)).toThrow(
      'FLATNESS_UNPROVEN',
    );
  });
});

const permit: ObservationPermission = {
  ownerId: 'local-owner',
  instanceId: 'local-instance',
  reference: 'SYNTHETIC_PERMISSION_ONLY',
  scope: 'READ_ONLY_OWNER_ACCOUNTS',
  approvedAt: NOW - 1,
  expiresAt: NOW + 10000,
  revoked: false,
};
function fixture() {
  let o = observation();
  let active = 0;
  let maximumActive = 0;
  let calls = 0;
  let quarantines = 0;
  let inventoryCalls = 0;
  const port: ReadonlyInspectionPort = {
    environment: 'OFFLINE_FIXTURE',
    ownerId: 'local-owner',
    instanceId: 'local-instance',
    contextId: 'local-session',
    pageId: 'one-page',
    async readInventory() {
      calls++;
      inventoryCalls++;
      return {
        contextId: port.contextId,
        pageId: port.pageId,
        uiRevision: o.uiRevision,
        observedAt: NOW,
        complete: true,
        accounts: [ref],
      };
    },
    async selectAccount() {
      calls++;
    },
    async readIdentity() {
      calls++;
      return {
        contextId: o.contextId,
        pageId: o.pageId,
        uiRevision: o.uiRevision,
        account: o.account,
        session: o.session,
      };
    },
    async readObservation() {
      calls++;
      active++;
      maximumActive = Math.max(active, maximumActive);
      await Promise.resolve();
      active--;
      return structuredClone(o);
    },
    async quarantine() {
      quarantines++;
    },
    async close() {},
  };
  return {
    port,
    get o() {
      return o;
    },
    set o(value) {
      o = value;
    },
    metrics: () => ({ calls, quarantines, maximumActive, inventoryCalls }),
  };
}
const budget = { timeoutMs: 100, maxCaptureAgeMs: 5000 };
const session = (
  f: ReturnType<typeof fixture>,
  p: ObservationPermission | null = permit,
  clock = () => NOW,
) => new SerializedInspectionSession(f.port, p, budget, clock);

describe('permission-gated serialized offline inspection boundary', () => {
  it('exposes no trading methods, rejects every real transport even with permission', () => {
    const f = fixture();
    expect(
      Object.keys(f.port).filter((key) =>
        /submit|prepare|order|flatten|cancel/i.test(key),
      ),
    ).toEqual([]);
    expect(
      () =>
        new SerializedInspectionSession(
          {
            ...f.port,
            environment: 'PERMITTED_VISIBLE_UI',
          } as unknown as ReadonlyInspectionPort,
          permit,
          budget,
        ),
    ).toThrow('REAL_OBSERVER_NOT_IMPLEMENTED');
  });
  it.each([
    'absent',
    'expired',
    'revoked',
    'wrong-owner',
    'wrong-instance',
  ] as const)('blocks %s permission before any port call', (fault) => {
    const f = fixture();
    const p = { ...permit };
    if (fault === 'expired') p.expiresAt = NOW;
    if (fault === 'revoked') p.revoked = true;
    if (fault === 'wrong-owner') p.ownerId = 'other-owner';
    if (fault === 'wrong-instance') p.instanceId = 'other-instance';
    return expect(session(f, fault === 'absent' ? null : p).inspect(ref))
      .rejects.toThrow(/OBSERVATION_/)
      .then(() => expect(f.metrics().calls).toBe(0));
  });
  it('serializes simultaneous scans, freezes results, and does not authorize execution', async () => {
    const f = fixture();
    const s = session(f);
    expect(s.status()).toBe('UNVERIFIED');
    const scans = await Promise.all([s.inspect(ref), s.inspect(ref)]);
    expect(f.metrics()).toMatchObject({ maximumActive: 1, inventoryCalls: 4 });
    expect(Object.isFrozen(scans[0]!.observation.fills.rows)).toBe(true);
    expect(s.status()).toBe('OBSERVED');
  });
  it.each(['context', 'page', 'account', 'login', 'schema'] as const)(
    'quarantines changed %s and rejects queued scans',
    async (fault) => {
      const f = fixture();
      const s = session(f);
      if (fault === 'context') f.o.contextId = 'other-session';
      if (fault === 'page') f.o.pageId = 'other-page';
      if (fault === 'account') f.o.account.visibleId = 'other-account';
      if (fault === 'login') f.o.session = 'LOGIN_REQUIRED';
      if (fault === 'schema')
        f.port.readObservation = async () => ({ incomplete: true });
      const results = await Promise.allSettled([
        s.inspect(ref),
        s.inspect(ref),
      ]);
      expect(results.every((result) => result.status === 'rejected')).toBe(
        true,
      );
      expect(s.status()).toBe('QUARANTINED');
      expect(f.metrics().quarantines).toBe(1);
    },
  );
  it.each(['incomplete', 'duplicate', 'missing', 'changed'] as const)(
    'blocks %s inventory',
    async (fault) => {
      const f = fixture();
      const read = f.port.readInventory;
      let reads = 0;
      f.port.readInventory = async () => {
        const inventory = (await read()) as {
          complete: boolean;
          accounts: VisibleAccountRef[];
        };
        reads++;
        if (fault === 'incomplete') inventory.complete = false;
        if (fault === 'duplicate') inventory.accounts.push({ ...ref });
        if (fault === 'missing')
          inventory.accounts = [{ ...ref, visibleId: null }];
        if (fault === 'changed' && reads === 2) inventory.accounts = [];
        return inventory;
      };
      const s = session(f);
      await expect(s.inspect(ref)).rejects.toThrow(/INVENTORY|IDENTITY/);
      expect(s.status()).toBe('QUARANTINED');
    },
  );
  it('checks identity again after the evidence read', async () => {
    const f = fixture();
    const read = f.port.readObservation;
    f.port.readObservation = async () => {
      const result = await read();
      f.o.account.visibleId = 'manual-switch';
      return result;
    };
    await expect(session(f).inspect(ref)).rejects.toThrow(
      'ACCOUNT_IDENTITY_MISMATCH',
    );
  });
  it.each(['before-scan', 'after-end', 'before-selection'] as const)(
    'rejects cached/misordered observation %s',
    async (fault) => {
      const f = fixture();
      let now = NOW;
      if (fault === 'before-scan') f.o.observedAt = NOW - 1;
      if (fault === 'after-end') {
        f.o.observedAt = NOW + 1;
        now = NOW + 1;
        // Initial inventory is freshly observed; end inventory goes backward.
        const read = f.port.readInventory;
        let reads = 0;
        f.port.readInventory = async () => {
          const value = (await read()) as { observedAt: number };
          value.observedAt = ++reads === 1 ? NOW + 1 : NOW;
          return value;
        };
      }
      if (fault === 'before-selection')
        f.port.selectAccount = async () => {
          now++;
        };
      await expect(session(f, permit, () => now).inspect(ref)).rejects.toThrow(
        'INSPECTION_CHRONOLOGY_UNPROVEN',
      );
    },
  );
  it('immutable transport binding rejects a retargeted port', async () => {
    const f = fixture();
    const s = session(f);
    Object.assign(f.port, { contextId: 'retargeted-port' });
    await expect(s.inspect(ref)).rejects.toThrow(
      'INSPECTION_TRANSPORT_CHANGED',
    );
    expect(f.metrics().calls).toBe(0);
  });
  it('blocks changed UI revision and stale whole-scan evidence', async () => {
    const f = fixture();
    const read = f.port.readObservation;
    f.port.readObservation = async () => {
      const result = await read();
      f.o.uiRevision = 'changed-selectors';
      return result;
    };
    await expect(session(f).inspect(ref)).rejects.toThrow(
      'INSPECTION_UI_CHANGED',
    );
    const slow = fixture();
    let now = NOW;
    const slowRead = slow.port.readObservation;
    slow.port.readObservation = async () => {
      const result = await slowRead();
      now += 5001;
      return result;
    };
    await expect(session(slow, permit, () => now).inspect(ref)).rejects.toThrow(
      /STALE_CAPTURE|SCAN_EXCEEDS_FRESHNESS_BUDGET/,
    );
  });
  it('timeout quarantines; a late result cannot restore the session or run queued work', async () => {
    const f = fixture();
    let release!: (value: unknown) => void;
    f.port.readObservation = () =>
      new Promise((resolve) => {
        release = resolve;
      });
    const s = new SerializedInspectionSession(
      f.port,
      permit,
      { ...budget, timeoutMs: 10 },
      () => NOW,
    );
    await expect(s.inspect(ref)).rejects.toThrow('INSPECTION_TIMEOUT');
    release(observation());
    await Promise.resolve();
    expect(s.status()).toBe('QUARANTINED');
    await expect(s.inspect(ref)).rejects.toThrow('INSPECTION_SESSION_UNUSABLE');
    expect(f.metrics().quarantines).toBe(1);
  });
  it('restart requires fresh inspection and expiry is rechecked for each scan', async () => {
    const f = fixture();
    let now = NOW;
    const s = session(f, permit, () => now);
    await s.inspect(ref);
    await s.close();
    await expect(s.inspect(ref)).rejects.toThrow('INSPECTION_SESSION_UNUSABLE');
    const restarted = session(f, permit, () => now);
    expect(restarted.status()).toBe('UNVERIFIED');
    now = permit.expiresAt;
    await expect(restarted.inspect(ref)).rejects.toThrow(
      'OBSERVATION_PERMISSION_REQUIRED',
    );
  });
});
