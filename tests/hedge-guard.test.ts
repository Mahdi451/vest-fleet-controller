import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CROSS_ACCOUNT_HEDGE_GUARD,
  evaluateFleetExposure,
  type ExposureAccount,
  type FleetExposureRule,
} from '../packages/risk-engine/src/exposure.ts';
import { intent, config, setup } from './helpers.ts';

const book = (
  side: 'LONG' | 'SHORT',
  symbol = 'NDX',
  enabled = true,
): ExposureAccount[] => [
  { accountId: '01', enabled, positions: [{ symbol, side, quantity: '0.1' }] },
];
describe('mandatory fleet exposure policy', () => {
  it('is always enabled and allows same-direction copying and flat accounts', () => {
    expect(CROSS_ACCOUNT_HEDGE_GUARD).toBe('ENABLED');
    expect(evaluateFleetExposure(intent, book('LONG'))).toEqual([]);
    expect(
      evaluateFleetExposure(intent, [
        { accountId: '01', enabled: true, positions: [] },
      ]),
    ).toEqual([]);
    expect(
      evaluateFleetExposure({ ...intent, side: 'SHORT' }, book('SHORT')),
    ).toEqual([]);
  });
  it.each(['NQ', 'NDX'])(
    'rejects opposite exposure for the local %s market alias',
    (symbol) => {
      const result = evaluateFleetExposure(
        { ...intent, side: 'SHORT' },
        book('LONG', symbol),
      );
      expect(result).toEqual([
        {
          ruleId: 'SAME_MARKET_DIRECTION',
          code: 'CROSS_ACCOUNT_HEDGE_GUARD',
          accountId: '01',
          symbol,
          side: 'LONG',
        },
      ]);
      expect(evaluateFleetExposure(intent, book('SHORT', symbol))).toHaveLength(
        1,
      );
    },
  );
  it('ignores disabled accounts but still detects enabled unselected exposure', () => {
    expect(evaluateFleetExposure(intent, book('SHORT', 'NDX', false))).toEqual(
      [],
    );
    expect(evaluateFleetExposure(intent, book('SHORT'))).toHaveLength(1);
  });
  it('does not automatically treat SPX as NDX, but supports additive future rules', () => {
    const accounts = book('SHORT', 'SPX');
    expect(evaluateFleetExposure(intent, accounts)).toEqual([]);
    // Test-only policy fixture. This is not a shipped correlation rule or a Vest policy claim.
    const futureRule: FleetExposureRule = {
      id: 'TEST_ONLY_CORRELATION',
      evaluate: ({ accounts }) =>
        accounts.flatMap((a) =>
          a.positions
            .filter((p) => p.symbol === 'SPX')
            .map((p) => ({
              ruleId: 'TEST_ONLY_CORRELATION',
              code: 'TEST_CORRELATED_EXPOSURE',
              accountId: a.accountId,
              symbol: p.symbol,
              side: p.side,
            })),
        ),
    };
    expect(evaluateFleetExposure(intent, accounts, [futureRule])[0]?.code).toBe(
      'TEST_CORRELATED_EXPOSURE',
    );
    expect(
      evaluateFleetExposure(intent, book('SHORT', 'SPX', false), [futureRule]),
    ).toEqual([]);
    expect(
      evaluateFleetExposure(intent, book('SHORT'), [
        { id: 'ALLOW_ALL', evaluate: () => [] },
      ])[0]?.code,
    ).toBe('CROSS_ACCOUNT_HEDGE_GUARD');
  });
});

describe('controller and simulator hedge enforcement', () => {
  let s: Awaited<ReturnType<typeof setup>>;
  beforeEach(async () => {
    s = await setup();
  });
  afterEach(() => {
    s.journal.close();
  });
  async function enter(accountId: string, side: 'LONG' | 'SHORT', id: string) {
    const p = await s.controller.preview({ ...intent, side }, [accountId]);
    return s.controller.execute(id, p.previewId);
  }
  it.each(['LONG', 'SHORT'] as const)(
    'copies %s to other flat accounts',
    async (side) => {
      expect((await enter('01', side, 'first'))[0]?.status).toBe('FILLED');
      expect((await enter('02', side, 'copy'))[0]?.status).toBe('FILLED');
      expect((await s.adapter.getAccountState('03')).positions).toHaveLength(0);
    },
  );
  it('rejects an entire conflicting fleet before any submission, including unselected existing exposure', async () => {
    await enter('01', 'LONG', 'first');
    const spy = vi.spyOn(s.adapter, 'placeOrder');
    const p = await s.controller.preview({ ...intent, side: 'SHORT' }, [
      '02',
      '03',
    ]);
    expect(p.exposureViolations[0]?.accountId).toBe('01');
    expect(
      p.orders.every(
        (o) => !o.approved && o.reasons.includes('CROSS_ACCOUNT_HEDGE_GUARD'),
      ),
    ).toBe(true);
    const result = await s.controller.execute('conflict', p.previewId);
    expect(
      result.every(
        (r) =>
          r.status === 'REJECTED' && r.error === 'CROSS_ACCOUNT_HEDGE_GUARD',
      ),
    ).toBe(true);
    expect(spy).not.toHaveBeenCalled();
  });
  it('ignores disabled opposite exposure, without permitting entry into disabled accounts', async () => {
    await enter('01', 'LONG', 'first');
    s.adapter.setEnabled('01', false);
    expect((await enter('02', 'SHORT', 'allowed'))[0]?.status).toBe('FILLED');
    const disabled = await s.controller.preview({ ...intent, side: 'SHORT' }, [
      '01',
    ]);
    expect(disabled.orders[0]?.reasons).toContain('ACCOUNT_DISABLED');
    s.adapter.setEnabled('01', true);
    const mixed = await s.controller.preview(intent, ['03']);
    expect(mixed.orders[0]?.reasons).toContain('CROSS_ACCOUNT_HEDGE_GUARD');
  });
  it('detects opposite exposure introduced after preview and before execution', async () => {
    const p = await s.controller.preview(intent, ['02', '03']);
    await enter('01', 'SHORT', 'external');
    const spy = vi.spyOn(s.adapter, 'placeOrder');
    const result = await s.controller.execute('stale-book', p.previewId);
    expect(result[0]?.error).toBe('CROSS_ACCOUNT_HEDGE_GUARD');
    expect(result[1]?.error).toBe('CIRCUIT_OPEN');
    expect(spy).not.toHaveBeenCalled();
  });
  it('mock submission independently rejects opposite exposure even if a caller bypasses the controller', async () => {
    const p = await s.controller.preview(intent, ['02']);
    await enter('01', 'SHORT', 'external');
    const result = await s.adapter.placeOrder({
      requestId: 'direct',
      masterTradeId: 'direct',
      accountId: '02',
      intent,
      preview: p.orders[0]!,
      quote: p.quote,
      config,
    });
    expect(result.status).toBe('REJECTED');
    expect(result.error).toBe('CROSS_ACCOUNT_HEDGE_GUARD');
    expect((await s.adapter.getAccountState('02')).positions).toHaveLength(0);
  });
  it('stops remaining fan-out when an enabled opposite position appears between children', async () => {
    await enter('10', 'SHORT', 'external');
    s.adapter.setEnabled('10', false);
    const p = await s.controller.preview(intent, ['01', '02']);
    const place = s.adapter.placeOrder.bind(s.adapter);
    vi.spyOn(s.adapter, 'placeOrder').mockImplementation(async (order) => {
      const result = await place(order);
      if (order.accountId === '01') s.adapter.setEnabled('10', true);
      return result;
    });
    const result = await s.controller.execute('race', p.previewId);
    expect(result[0]?.status).toBe('FILLED');
    expect(result[1]?.error).toBe('CROSS_ACCOUNT_HEDGE_GUARD');
    expect((await s.adapter.getAccountState('02')).positions).toHaveLength(0);
  });
  it('always permits flatten attempts, including disabled accounts and a pre-existing hedge', async () => {
    await enter('01', 'LONG', 'first');
    s.adapter.setEnabled('01', false);
    await enter('02', 'SHORT', 'second');
    s.adapter.setEnabled('01', true);
    const result = await s.controller.flattenAll();
    expect(result).toHaveLength(10);
    expect(result.every((r) => r.status === 'FLAT')).toBe(true);
    expect(
      (await s.adapter.listAccounts()).every((a) => !a.positions.length),
    ).toBe(true);
  });
});
