import { describe, expect, it } from 'vitest';
import {
  D,
  intentSchema,
  riskConfigSchema,
  remainingDrawdown,
} from '../packages/core/src/index.ts';
import {
  dollarPerPoint,
  notionalForRisk,
  stopRisk,
  sizeTrade,
} from '../packages/risk-engine/src/index.ts';
import { account, config, intent, quote, NOW } from './helpers.ts';

describe('decimal formulas and validation', () => {
  it('matches the given 30400 / $4 / 60-point example without CME multipliers', () => {
    expect(Number(notionalForRisk('4', '30400', '60'))).toBeCloseTo(
      2026.6666666667,
      8,
    );
    expect(dollarPerPoint('3040', '30400')).toBe('0.1');
    expect(stopRisk('3040', '30400', '60')).toBe('6');
  });
  it.each(['0', '-1', 'NaN', 'Infinity', ''])(
    'rejects invalid price/stop %s',
    (bad) => {
      expect(() => notionalForRisk('4', bad, '80')).toThrow();
      expect(() => notionalForRisk('4', '30400', bad)).toThrow();
    },
  );
  it('rejects ambiguous percentages and malformed configs', () => {
    expect(() => intentSchema.parse({ ...intent, riskValue: '101' })).toThrow();
    expect(() => intentSchema.parse({ ...intent, riskValue: 40 })).toThrow();
    expect(() =>
      riskConfigSchema.parse({ ...config, entryFeeRate: '-0.01' }),
    ).toThrow();
    expect(() =>
      riskConfigSchema.parse({ ...config, sizeStep: '0' }),
    ).toThrow();
  });
});
describe('per-account sizing and reserves', () => {
  it('sizes 14.55 and 10 buffers independently with all-in 40% budgets', () => {
    const a = sizeTrade(account(0), intent, quote, config, NOW);
    const b = sizeTrade(account(1), intent, quote, config, NOW);
    expect(a.budget).toBe('5.82');
    expect(b.budget).toBe('4');
    expect(a.approved && b.approved).toBe(true);
    expect(new D(a.quantity).gt(b.quantity)).toBe(true);
    expect(new D(b.totalPlannedLoss).lte(4)).toBe(true);
    expect(new D(b.stopRisk).lt(4)).toBe(true);
    expect(new D(b.quantity).mod(config.sizeStep).isZero()).toBe(true);
  });
  it('rejects $9 risk from $10 buffer with $2 reserve', () => {
    expect(
      sizeTrade(
        account(),
        { ...intent, riskMode: 'FIXED_DOLLAR', riskValue: '9' },
        quote,
        config,
        NOW,
      ).reasons,
    ).toContain('DRAWDOWN_RESERVE');
  });
  it('uses fixed notional and still includes fees in the reserve gate', () => {
    const r = sizeTrade(
      account(),
      { ...intent, riskMode: 'FIXED_NOTIONAL', riskValue: '3000' },
      quote,
      config,
      NOW,
    );
    expect(new D(r.notional).lte(3000)).toBe(true);
    expect(r.reasons).toContain('DRAWDOWN_RESERVE');
    expect(new D(r.totalPlannedLoss).gt(r.stopRisk)).toBe(true);
  });
  it('higher costs never increase allowed size', () => {
    for (const fee of ['0', '0.000025', '0.0001', '0.001']) {
      const cheap = sizeTrade(
        account(),
        intent,
        quote,
        { ...config, entryFeeRate: '0' },
        NOW,
      );
      const costly = sizeTrade(
        account(),
        intent,
        quote,
        { ...config, entryFeeRate: fee },
        NOW,
      );
      expect(new D(costly.quantity).lte(cheap.quantity)).toBe(true);
      expect(new D(costly.totalPlannedLoss).lte(costly.budget)).toBe(true);
    }
  });
  it('honors account-specific fees and costs', () => {
    const a = account();
    a.feeOverride = {
      entryFeeRate: '0.001',
      exitFeeRate: '0.001',
      accountCost: '0.5',
    };
    const r = sizeTrade(a, intent, quote, config, NOW);
    expect(r.accountCost).toBe('0.5');
    expect(
      new D(r.quantity).lt(
        sizeTrade(account(), intent, quote, config, NOW).quantity,
      ),
    ).toBe(true);
  });
  it('uses equity and the stricter optional daily floor', () => {
    const a = account();
    a.dailyLossFloor = '496';
    a.remainingDrawdown = '4';
    expect(remainingDrawdown(a)).toBe('4');
    expect(sizeTrade(a, intent, quote, config, NOW).budget).toBe('1.6');
  });
  it('rejects stale, future and inconsistent snapshots', () => {
    expect(
      sizeTrade(account(), intent, quote, config, NOW + 5001).reasons,
    ).toEqual(expect.arrayContaining(['STALE_ACCOUNT', 'STALE_QUOTE']));
    expect(sizeTrade(account(), intent, quote, config, NOW - 1).approved).toBe(
      false,
    );
    const a = account();
    a.equity = '499';
    expect(sizeTrade(a, intent, quote, config, NOW).reasons).toContain(
      'INCONSISTENT_ACCOUNT',
    );
  });
  it('rejects leverage, margin, invalid protection and tiny sizes', () => {
    expect(
      sizeTrade(account(), { ...intent, leverage: '100' }, quote, config, NOW)
        .reasons,
    ).toContain('LEVERAGE_LIMIT');
    expect(
      sizeTrade(account(), { ...intent, leverage: '1' }, quote, config, NOW)
        .reasons,
    ).toContain('INSUFFICIENT_MARGIN');
    expect(
      sizeTrade(
        account(),
        { ...intent, stopDistancePoints: '40000' },
        quote,
        config,
        NOW,
      ).reasons,
    ).toContain('INVALID_PROTECTION_PRICE');
    expect(
      sizeTrade(
        account(),
        { ...intent, riskValue: '0.00001' },
        quote,
        config,
        NOW,
      ).reasons,
    ).toContain('SIZE_BELOW_MINIMUM');
  });
  it('never approves a loss that leaves less than the reserve across varied buffers', () => {
    for (const buffer of ['0', '1', '2', '2.01', '10', '14.55', '100']) {
      for (const pct of ['1', '20', '40', '80', '100']) {
        const a = account();
        a.balance = a.equity = new D(490).plus(buffer).toFixed();
        a.remainingDrawdown = buffer;
        const r = sizeTrade(
          a,
          { ...intent, riskValue: pct },
          quote,
          config,
          NOW,
        );
        if (r.approved) {
          expect(new D(r.remainingAfterStop).gte(2)).toBe(true);
          expect(new D(r.totalPlannedLoss).lte(r.budget)).toBe(true);
        }
      }
    }
  });
});

describe('margin allocation and buying power', () => {
  it('uses leverage times each account’s allocated equity rather than its drawdown', () => {
    const t = {
      ...intent,
      riskMode: 'MARGIN_PERCENT' as const,
      riskValue: '75',
      leverage: '10',
    };
    const normal = sizeTrade(account(), t, quote, config, NOW);
    const larger = sizeTrade(account(0), t, quote, config, NOW);
    expect(Number(normal.marginRequired)).toBeCloseTo(375, 2);
    expect(Number(normal.notional)).toBeGreaterThan(3749);
    expect(Number(normal.notional)).toBeLessThanOrEqual(3750);
    expect(Number(larger.notional)).toBeGreaterThan(Number(normal.notional));
    expect(normal.reasons).toContain('DRAWDOWN_RESERVE');
    expect(larger.approved).toBe(true);
  });
  it('50x at 25% requests more exposure than 10x at 75%, while risk gates still apply', () => {
    const r = sizeTrade(
      account(),
      {
        ...intent,
        riskMode: 'MARGIN_PERCENT',
        riskValue: '25',
        leverage: '50',
      },
      quote,
      config,
      NOW,
    );
    expect(Number(r.marginRequired)).toBeCloseTo(125, 2);
    expect(Number(r.notional)).toBeGreaterThan(6249);
    expect(Number(r.totalPlannedLoss)).toBeGreaterThan(16.45);
    expect(r.approved).toBe(false);
  });
  it('approves 10x at 25% with sufficient stop reserve, and caps the percentage at 100', () => {
    const r = sizeTrade(
      account(),
      {
        ...intent,
        riskMode: 'MARGIN_PERCENT',
        riskValue: '25',
        leverage: '10',
      },
      quote,
      config,
      NOW,
    );
    expect(r.approved).toBe(true);
    expect(Number(r.remainingAfterStop)).toBeGreaterThan(6);
    expect(() =>
      intentSchema.parse({
        ...intent,
        riskMode: 'MARGIN_PERCENT',
        riskValue: '101',
      }),
    ).toThrow();
    const all = sizeTrade(
      account(),
      {
        ...intent,
        riskMode: 'MARGIN_PERCENT',
        riskValue: '100',
        leverage: '10',
      },
      quote,
      config,
      NOW,
    );
    expect(all.reasons).toContain('INSUFFICIENT_MARGIN');
  });
});
