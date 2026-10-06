import { describe, expect, it } from 'vitest';
import { OfflineFanoutReadiness } from '../packages/execution/src/fanout-readiness.ts';
import { initialFleet } from '../packages/core/src/index.ts';
import { config, intent, quote, NOW } from './helpers.ts';
function fixture() {
  let now = NOW;
  const fleet = initialFleet(now);
  const readiness = new OfflineFanoutReadiness(config, () => now);
  const policy = {
    leaderAccountId: '01',
    followerAccountIds: ['02', '03'],
    symbol: 'NDX' as const,
    maxLeverage: '50',
    maxNotionalPerAccount: '100000',
    maxPlannedLossPerAccount: '10000',
    expiresAt: now + 10000,
  };
  const prepare = () => readiness.prepare(intent, fleet, quote);
  return {
    readiness,
    fleet,
    policy,
    prepare,
    advance: (value: number) => {
      now += value;
    },
  };
}
describe('memory-only local fixture readiness', () => {
  it('losing leader eligibility invalidates preparation globally', () => {
    const f = fixture();
    f.readiness.arm(f.policy, f.fleet);
    f.fleet[0]!.enabled = false;
    expect(() => f.prepare()).toThrow('READINESS_LEADER_UNPROVEN');
    expect(() => f.readiness.arm(f.policy, f.fleet)).toThrow(
      'READINESS_ARM_REFUSED',
    );
  });
  it('cannot promote an unavailable follower into leader authority', () => {
    const f = fixture();
    f.readiness.arm(f.policy, f.fleet);
    f.readiness.invalidateContext('02');
    f.readiness.lock();
    expect(() =>
      f.readiness.arm(
        { ...f.policy, leaderAccountId: '02', followerAccountIds: ['03'] },
        f.fleet,
      ),
    ).toThrow('READINESS_ARM_REFUSED');
    expect(() => f.prepare()).toThrow('READINESS_LOCKED');
  });
  it('leader context loss stays global after disarming', () => {
    const f = fixture();
    f.readiness.arm(f.policy, f.fleet);
    f.readiness.lock();
    expect(f.readiness.invalidateContext('01')).toBe('GLOBAL');
    expect(() => f.readiness.arm(f.policy, f.fleet)).toThrow(
      'READINESS_ARM_REFUSED',
    );
  });
  it('refuses changed account revision at dispatch', () => {
    const f = fixture();
    f.readiness.arm(f.policy, f.fleet);
    const p = f.prepare();
    f.fleet[1]!.revision++;
    expect(() =>
      f.readiness.assertDispatch(
        p,
        intent,
        '02',
        'a',
        p.approvals[0]!.quantity,
        f.fleet,
      ),
    ).toThrow('READINESS_DISPATCH_REFUSED');
  });
  it('a failed rearm cannot leave the old session enabled', () => {
    const f = fixture();
    f.readiness.arm(f.policy, f.fleet);
    const p = f.prepare();
    expect(() =>
      f.readiness.arm({ ...f.policy, expiresAt: NOW }, f.fleet),
    ).toThrow();
    expect(f.readiness.reusable(p, intent)).toBe(false);
  });
  it('starts locked and does not inherit another instance authority', () => {
    const f = fixture();
    expect(() => f.prepare()).toThrow('READINESS_LOCKED');
    f.readiness.arm(f.policy, f.fleet);
    const p = f.prepare();
    expect(fixture().readiness.reusable(p, intent)).toBe(false);
  });
  it('binds preparations to exact intent and consumes dispatch once', () => {
    const f = fixture();
    f.readiness.arm(f.policy, f.fleet);
    const p = f.prepare(),
      quantity = p.approvals[0]!.quantity;
    expect(f.readiness.reusable(p, { ...intent, takeProfitPoints: '90' })).toBe(
      false,
    );
    f.readiness.assertDispatch(
      p,
      intent,
      '02',
      'attempt-one',
      quantity,
      f.fleet,
    );
    expect(() =>
      f.readiness.assertDispatch(
        p,
        intent,
        '02',
        'attempt-one',
        quantity,
        f.fleet,
      ),
    ).toThrow('READINESS_DISPATCH_REFUSED');
  });
  it('rejects cloned or modified approval capabilities', () => {
    const f = fixture();
    f.readiness.arm(f.policy, f.fleet);
    const p = f.prepare();
    expect(f.readiness.reusable(structuredClone(p), intent)).toBe(false);
    p.approvals[0]!.quantity = '999';
    expect(f.readiness.reusable(p, intent)).toBe(false);
  });
  it('expires at the earliest account or quote evidence boundary', () => {
    const f = fixture();
    f.readiness.arm(f.policy, f.fleet);
    f.fleet[2]!.lastSyncTimestamp = NOW - config.maxDataAgeMs + 1;
    const p = f.prepare();
    expect(p.expiresAt).toBe(NOW + 1);
    f.advance(1);
    expect(f.readiness.reusable(p, intent)).toBe(false);
  });
  it('invalidates preparation on rearm and revocation', () => {
    const f = fixture();
    f.readiness.arm(f.policy, f.fleet);
    const p = f.prepare();
    f.readiness.arm(f.policy, f.fleet);
    expect(f.readiness.reusable(p, intent)).toBe(false);
    const next = f.prepare();
    f.readiness.lock();
    expect(f.readiness.reusable(next, intent)).toBe(false);
  });
  it('keeps local context loss blocked through book refresh and rearm', () => {
    const f = fixture();
    f.readiness.arm(f.policy, f.fleet);
    const p = f.prepare();
    f.readiness.invalidateContext('02');
    expect(f.readiness.available('03')).toBe(true);
    expect(() =>
      f.readiness.assertDispatch(
        p,
        intent,
        '02',
        'a',
        p.approvals[0]!.quantity,
        f.fleet,
      ),
    ).toThrow();
    expect(f.prepare().approvals[0]!.approved).toBe(false);
    f.readiness.arm(f.policy, f.fleet);
    expect(f.prepare().approvals[0]!.approved).toBe(false);
    f.readiness.restoreContext(f.fleet[1]!);
    expect(f.prepare().approvals[0]!.approved).toBe(true);
    expect(() =>
      f.readiness.assertDispatch(
        p,
        intent,
        '02',
        'b',
        p.approvals[0]!.quantity,
        f.fleet,
      ),
    ).toThrow();
  });
  it('leader context loss invalidates the entire session', () => {
    const f = fixture();
    f.readiness.arm(f.policy, f.fleet);
    f.readiness.invalidateContext('01');
    expect(() => f.prepare()).toThrow();
    expect(() => f.readiness.arm(f.policy, f.fleet)).toThrow();
  });
  it('clock rollback invalidates the session permanently', () => {
    const f = fixture();
    f.readiness.arm(f.policy, f.fleet);
    f.advance(-1);
    expect(() => f.prepare()).toThrow('READINESS_CLOCK_INVALID');
    f.advance(1);
    expect(() => f.readiness.arm(f.policy, f.fleet)).toThrow(
      'READINESS_ARM_REFUSED',
    );
  });
  it('refuses stale books, wrong quote and changed complete inventory', () => {
    const f = fixture();
    f.readiness.arm(f.policy, f.fleet);
    expect(() => f.readiness.prepare(intent, f.fleet.slice(1), quote)).toThrow(
      'READINESS_EVIDENCE_INVALID',
    );
    expect(() =>
      f.readiness.prepare(intent, f.fleet, {
        ...quote,
        timestamp: NOW - config.maxDataAgeMs - 1,
      }),
    ).toThrow();
    expect(() =>
      f.readiness.prepare({ ...intent, leverage: '51' }, f.fleet, quote),
    ).toThrow();
  });
});
