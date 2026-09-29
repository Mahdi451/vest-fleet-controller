import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  D,
  type ProtectionRequest,
  type ProtectionOrder,
} from '../packages/core/src/index.ts';
import { protectionPrices } from '../packages/risk-engine/src/index.ts';
import { config, intent, setup } from './helpers.ts';

let s: Awaited<ReturnType<typeof setup>>;
beforeEach(async () => {
  s = await setup();
});
afterEach(() => {
  s.journal.close();
});
async function establish(side: 'LONG' | 'SHORT' = 'LONG', selected = ['01']) {
  const p = await s.controller.preview({ ...intent, side }, selected);
  const results = await s.controller.execute(`entry-${side}`, p.previewId);
  return { p, results };
}
async function rawEntry(accountId = '01', id = 'raw') {
  const p = await s.controller.preview(intent, [accountId]);
  const result = await s.adapter.placeOrder({
    requestId: id,
    masterTradeId: id,
    accountId,
    intent,
    preview: p.orders[0]!,
    quote: p.quote,
    config,
  });
  expect(result.status).toBe('FILLED');
  const prices = protectionPrices(result.entryPrice!, intent);
  const request: ProtectionRequest = {
    requestId: `${id}-sl`,
    masterTradeId: id,
    accountId,
    entryRequestId: id,
    symbol: 'NDX',
    positionSide: 'LONG',
    quantity: result.filledSize,
    type: 'STOP_LOSS',
    triggerPrice: prices.stopPrice,
    reduceOnly: true,
  };
  return { result, request, prices };
}

describe('fill-anchored protection lifecycle', () => {
  it.each(['LONG', 'SHORT'] as const)(
    'uses the actual %s fill, not the preview quote, and only then reports PROTECTED',
    async (side) => {
      const original = s.adapter.placeOrder.bind(s.adapter);
      vi.spyOn(s.adapter, 'placeOrder').mockImplementation(async (request) => {
        const result = await original(request);
        const account = await s.adapter.getAccountState(request.accountId);
        expect(account.positions[0]?.protectionStatus).toBe('NONE');
        expect(account.positions[0]).not.toHaveProperty('stop');
        expect(account.positions[0]).not.toHaveProperty('target');
        expect(await s.adapter.getOpenOrders(request.accountId)).toEqual([]);
        expect(s.journal.children(`entry-${side}`)[0]?.state).toBe(
          'ENTRY_SUBMITTING',
        );
        return result;
      });
      const submit = s.adapter.placeProtectionOrder.bind(s.adapter);
      vi.spyOn(s.adapter, 'placeProtectionOrder').mockImplementation(
        async (request) => {
          const child = s.journal.children(`entry-${side}`)[0]!;
          expect(child.state).toBe('PROTECTION_SUBMITTING');
          expect(child.status).toBe('UNKNOWN');
          expect(child.protectionOrderIds).toContain(request.requestId);
          return submit(request);
        },
      );
      const { p, results } = await establish(side);
      const r = results[0]!;
      const fill = side === 'LONG' ? '30401' : '30399';
      expect(r).toMatchObject({
        status: 'FILLED',
        state: 'PROTECTED',
        entryPrice: fill,
      });
      const expected = protectionPrices(fill, { ...intent, side });
      expect(r.stopPrice).toBe(expected.stopPrice);
      expect(r.targetPrice).toBe(expected.targetPrice);
      expect(r.stopPrice).not.toBe(p.orders[0]!.estimatedStop);
      expect(r.targetPrice).not.toBe(p.orders[0]!.estimatedTarget);
      const open = await s.adapter.getOpenOrders('01');
      expect(open).toHaveLength(2);
      expect(
        open.every(
          (o) =>
            o.status === 'ACTIVE' &&
            o.reduceOnly &&
            o.entryRequestId === r.requestId,
        ),
      ).toBe(true);
      expect(open.find((o) => o.type === 'STOP_LOSS')?.triggerPrice).toBe(
        expected.stopPrice,
      );
      expect(open.find((o) => o.type === 'TAKE_PROFIT')?.triggerPrice).toBe(
        expected.targetPrice,
      );
      const states = s.journal
        .events()
        .filter((e) => e.masterTradeId === `entry-${side}`)
        .map((e) => e.status);
      expect(states.indexOf('ENTRY_FILLED_UNPROTECTED')).toBeGreaterThan(
        states.indexOf('ENTRY_SUBMITTING'),
      );
      expect(states.indexOf('PROTECTED')).toBeGreaterThan(
        states.indexOf('PROTECTION_SUBMITTING'),
      );
    },
  );
  it('matches the exact fractional fill example: 30450.25 -> 30425.25 / 30500.25', async () => {
    const local = await setup({ ...config, slippagePointsPerSide: '0.25' });
    try {
      await local.adapter.updatePrice('30450');
      const t = { ...intent, stopDistancePoints: '25', takeProfitPoints: '50' };
      const p = await local.controller.preview(t, ['01']);
      const [r] = await local.controller.execute('fractional', p.previewId);
      expect(r).toMatchObject({
        state: 'PROTECTED',
        entryPrice: '30450.25',
        stopPrice: '30425.25',
        targetPrice: '30500.25',
      });
      expect(protectionPrices('30450.25', { ...t, side: 'SHORT' })).toEqual({
        stopPrice: '30475.25',
        targetPrice: '30400.25',
      });
    } finally {
      local.journal.close();
    }
  });
  it('does not fabricate protection when raw market entry fills', async () => {
    await rawEntry();
    await s.adapter.updatePrice('30481');
    expect(
      (await s.adapter.getAccountState('01')).positions[0]?.protectionStatus,
    ).toBe('NONE');
    expect(await s.adapter.getOpenOrders('01')).toEqual([]);
  });
  it.each(['STOP_LOSS', 'TAKE_PROFIT'] as const)(
    '%s submission rejection triggers flatten, UNKNOWN and a fleet halt',
    async (type) => {
      s.adapter.injectProtectionFault('01', type, 'REJECT');
      const flatten = vi.spyOn(s.adapter, 'flattenAccount');
      const entry = vi.spyOn(s.adapter, 'placeOrder');
      const { p, results } = await establish('LONG', ['01', '02', '03']);
      expect(results[0]).toMatchObject({
        status: 'UNKNOWN',
        state: 'UNKNOWN',
        error: 'PROTECTION_UNCONFIRMED',
        cleanupStatus: 'FLAT',
      });
      expect(
        results
          .slice(1)
          .every((r) => r.state === 'HALTED' && r.error === 'CIRCUIT_OPEN'),
      ).toBe(true);
      expect(flatten).toHaveBeenCalledWith('01');
      expect(entry).toHaveBeenCalledTimes(1);
      expect(await s.adapter.getOpenOrders('01')).toEqual([]);
      expect((await s.adapter.getAccountState('01')).positions).toHaveLength(0);
      expect(s.journal.halted()).toBe(true);
      expect(await s.controller.execute('entry-LONG', p.previewId)).toEqual(
        results,
      );
      expect(entry).toHaveBeenCalledTimes(1);
    },
  );
  it('retains unsafe exposure and reports UNKNOWN when cleanup itself fails', async () => {
    s.adapter.injectProtectionFault('01', 'STOP_LOSS', 'REJECT');
    vi.spyOn(s.adapter, 'flattenAccount').mockRejectedValue(
      new Error('CLOSE_FAILED'),
    );
    const { results } = await establish('LONG', ['01', '02']);
    expect(results[0]).toMatchObject({
      status: 'UNKNOWN',
      cleanupStatus: 'UNKNOWN',
    });
    expect(
      (await s.adapter.getAccountState('01')).positions[0]?.protectionStatus,
    ).toBe('FAILED');
    expect((await s.adapter.getAccountState('02')).positions).toHaveLength(0);
    expect(s.journal.halted()).toBe(true);
  });
  it('resolves a lost protection response through authoritative lookup without resending', async () => {
    s.adapter.injectProtectionFault(
      '01',
      'STOP_LOSS',
      'AMBIGUOUS_AFTER_CREATE',
    );
    s.adapter.injectProtectionFault(
      '01',
      'TAKE_PROFIT',
      'AMBIGUOUS_AFTER_CREATE',
    );
    const place = vi.spyOn(s.adapter, 'placeProtectionOrder');
    const { results } = await establish();
    expect(results[0]?.state).toBe('PROTECTED');
    expect(place).toHaveBeenCalledTimes(2);
  });
  it('times out a protection submission, cleans up, and refuses late protection against the closed entry', async () => {
    const original = s.adapter.placeProtectionOrder.bind(s.adapter);
    let release: () => Promise<ProtectionOrder> = async () => {
      throw new Error('NO_REQUEST');
    };
    vi.spyOn(s.adapter, 'placeProtectionOrder').mockImplementationOnce(
      (request) =>
        new Promise((resolve) => {
          release = async () => {
            const result = await original(request);
            resolve(result);
            return result;
          };
        }),
    );
    const { results } = await establish('LONG', ['01', '02']);
    expect(results[0]).toMatchObject({
      status: 'UNKNOWN',
      cleanupStatus: 'FLAT',
    });
    expect((await release()).status).toBe('REJECTED');
    expect(await s.adapter.getOpenOrders('01')).toEqual([]);
    expect(results[1]?.state).toBe('HALTED');
  });
  it('attempts cleanup even when post-fill journaling fails', async () => {
    const log = s.journal.log.bind(s.journal);
    vi.spyOn(s.journal, 'log').mockImplementation((event) => {
      if (event.status === 'PROTECTION_SUBMITTING')
        throw new Error('DISK_WRITE_FAILED');
      log(event);
    });
    const flat = vi.spyOn(s.adapter, 'flattenAccount');
    const { results } = await establish('LONG', ['01', '02']);
    expect(results[0]?.status).toBe('UNKNOWN');
    expect(flat).toHaveBeenCalledWith('01');
    expect((await s.adapter.getAccountState('01')).positions).toHaveLength(0);
    expect(results[1]?.state).toBe('HALTED');
  });
});

describe('authoritative protection reconciliation', () => {
  it('does not accept a fabricated ACTIVE acknowledgement without a real order', async () => {
    vi.spyOn(s.adapter, 'placeProtectionOrder').mockImplementation(
      async (request) => ({
        ...request,
        orderId: request.requestId,
        status: 'ACTIVE',
        filledSize: '0',
        error: null,
      }),
    );
    const { results } = await establish();
    expect(results[0]?.status).toBe('UNKNOWN');
    expect(results[0]?.cleanupStatus).toBe('FLAT');
  });
  it.each([
    'triggerPrice',
    'quantity',
    'accountId',
    'entryRequestId',
    'status',
    'reduceOnly',
  ] as const)(
    'rejects a mismatched %s in authoritative protection',
    async (field) => {
      const get = s.adapter.getProtectionOrder.bind(s.adapter);
      vi.spyOn(s.adapter, 'getProtectionOrder').mockImplementation(
        async (account, id) => {
          const order = await get(account, id);
          if (!order) return null;
          return {
            ...order,
            [field]:
              field === 'reduceOnly'
                ? false
                : field === 'status'
                  ? 'CANCELED'
                  : field === 'triggerPrice'
                    ? '1'
                    : field === 'quantity'
                      ? '99'
                      : 'WRONG',
          } as ProtectionOrder;
        },
      );
      const { results } = await establish();
      expect(results[0]?.status).toBe('UNKNOWN');
      expect((await s.adapter.getAccountState('01')).positions).toHaveLength(0);
    },
  );
  it('rechecks SL after TP submission instead of trusting the earlier SL confirmation', async () => {
    const original = s.adapter.placeProtectionOrder.bind(s.adapter);
    vi.spyOn(s.adapter, 'placeProtectionOrder').mockImplementation(
      async (request) => {
        const result = await original(request);
        if (request.type === 'TAKE_PROFIT') {
          const sl = (await s.adapter.getOpenOrders(request.accountId)).find(
            (o) => o.type === 'STOP_LOSS',
          )!;
          await s.adapter.cancelOrder(request.accountId, sl.orderId);
        }
        return result;
      },
    );
    const { results } = await establish();
    expect(results[0]?.status).toBe('UNKNOWN');
    expect(await s.adapter.getOpenOrders('01')).toEqual([]);
  });
  it.each(['side', 'quantity'] as const)(
    'requires the final position %s to match the entry',
    async (field) => {
      const get = s.adapter.getAccountState.bind(s.adapter);
      vi.spyOn(s.adapter, 'getAccountState').mockImplementation(async (id) => {
        const a = await get(id);
        const p = a.positions[0];
        if (p?.protectionStatus === 'ACTIVE') {
          if (field === 'side') p.side = 'SHORT';
          else p.quantity = '99';
        }
        return a;
      });
      const { results } = await establish();
      expect(results[0]?.status).toBe('UNKNOWN');
    },
  );
  it('requires the entry ledger to remain authoritative after protection is created', async () => {
    const get = s.adapter.getOrder.bind(s.adapter);
    let reads = 0;
    vi.spyOn(s.adapter, 'getOrder').mockImplementation(async (id) =>
      ++reads === 1 ? get(id) : null,
    );
    const { results } = await establish();
    expect(results[0]?.status).toBe('UNKNOWN');
    expect(results[0]?.cleanupStatus).toBe('FLAT');
  });
});

describe('reduce-only exits, sibling cancellation, idempotency and flatten', () => {
  it.each([
    ['LONG', 'STOP_LOSS'],
    ['LONG', 'TAKE_PROFIT'],
    ['SHORT', 'STOP_LOSS'],
    ['SHORT', 'TAKE_PROFIT'],
  ] as const)(
    '%s %s closes the position and cancels the sibling',
    async (side, type) => {
      const { results } = await establish(side);
      const orders = await s.adapter.getOpenOrders('01');
      const trigger = orders.find((o) => o.type === type)!;
      const sibling = orders.find((o) => o.type !== type)!;
      await s.adapter.updatePrice(trigger.triggerPrice);
      expect(
        (await s.adapter.getProtectionOrder('01', trigger.orderId))?.status,
      ).toBe('FILLED');
      expect(
        (await s.adapter.getProtectionOrder('01', sibling.orderId))?.status,
      ).toBe('CANCELED');
      expect((await s.adapter.getAccountState('01')).positions).toHaveLength(0);
      await s.adapter.updatePrice(sibling.triggerPrice);
      expect((await s.adapter.getAccountState('01')).positions).toHaveLength(0);
      expect(await s.adapter.getOpenOrders('01')).toEqual([]);
      expect(
        s.journal
          .events()
          .some(
            (e) =>
              e.status === 'EXITED' && e.requestId === results[0]?.requestId,
          ),
      ).toBe(true);
    },
  );
  it('caps exit quantity to remaining exposure after a partial manual close', async () => {
    await establish();
    const position = (await s.adapter.getAccountState('01')).positions[0]!;
    const remaining = new D(position.quantity).div(2).toFixed();
    await s.adapter.closePosition('01', remaining);
    const sl = (await s.adapter.getOpenOrders('01')).find(
      (o) => o.type === 'STOP_LOSS',
    )!;
    await s.adapter.updatePrice(sl.triggerPrice);
    expect(
      (await s.adapter.getProtectionOrder('01', sl.orderId))?.filledSize,
    ).toBe(remaining);
    expect((await s.adapter.getAccountState('01')).positions).toHaveLength(0);
  });
  it('deduplicates protection requests, rejects changed payloads, and never revives canceled orders', async () => {
    const { request } = await rawEntry();
    const first = await s.adapter.placeProtectionOrder(request);
    expect(await s.adapter.placeProtectionOrder(request)).toEqual(first);
    expect(await s.adapter.getOpenOrders('01')).toHaveLength(1);
    await expect(
      s.adapter.placeProtectionOrder({ ...request, triggerPrice: '30000' }),
    ).rejects.toThrow('IDEMPOTENCY_CONFLICT');
    await s.adapter.cancelOrder('01', first.orderId);
    expect((await s.adapter.placeProtectionOrder(request)).status).toBe(
      'CANCELED',
    );
    expect(await s.adapter.getOpenOrders('01')).toEqual([]);
  });
  it('rejects non-reduce-only orders and stale protection for an earlier entry', async () => {
    const { request } = await rawEntry();
    await expect(
      s.adapter.placeProtectionOrder({
        ...request,
        reduceOnly: false,
      } as unknown as ProtectionRequest),
    ).rejects.toThrow();
    await s.adapter.flattenAccount('01');
    await rawEntry('01', 'new-entry');
    expect(
      (
        await s.adapter.placeProtectionOrder({
          ...request,
          requestId: 'late-old-stop',
        })
      ).status,
    ).toBe('REJECTED');
    expect(
      (await s.adapter.getAccountState('01')).positions[0]?.entryRequestId,
    ).toBe('new-entry');
  });
  it.each(['NONE', 'PARTIAL', 'PROTECTED'] as const)(
    'flatten-all cleans up %s protection',
    async (state) => {
      if (state === 'PROTECTED') await establish();
      else {
        const { request } = await rawEntry();
        if (state === 'PARTIAL') await s.adapter.placeProtectionOrder(request);
      }
      s.adapter.setEnabled('01', false);
      const result = await s.controller.flattenAll();
      expect(result.every((r) => r.status === 'FLAT')).toBe(true);
      expect((await s.adapter.getAccountState('01')).positions).toHaveLength(0);
      expect(await s.adapter.getOpenOrders('01')).toEqual([]);
    },
  );
  it('halts if SL exits the position before TP can be established', async () => {
    const submit = s.adapter.placeProtectionOrder.bind(s.adapter);
    vi.spyOn(s.adapter, 'placeProtectionOrder').mockImplementation(
      async (request) => {
        const result = await submit(request);
        if (request.type === 'STOP_LOSS')
          await s.adapter.updatePrice(request.triggerPrice);
        return result;
      },
    );
    const place = vi.spyOn(s.adapter, 'placeOrder');
    const { results } = await establish('LONG', ['01', '02']);
    expect(results[0]).toMatchObject({
      state: 'UNKNOWN',
      cleanupStatus: 'FLAT',
    });
    expect(results[1]?.state).toBe('HALTED');
    expect(place).toHaveBeenCalledTimes(1);
    expect(await s.adapter.getOpenOrders('01')).toEqual([]);
    expect((await s.adapter.getAccountState('01')).positions).toEqual([]);
  });
  it('does not claim flatten success when the open-order book still shows an active exit', async () => {
    const { request } = await rawEntry();
    const order = await s.adapter.placeProtectionOrder(request);
    vi.spyOn(s.adapter, 'getOpenOrders').mockResolvedValue([order]);
    expect((await s.controller.flattenAll())[0]?.status).toBe('UNKNOWN');
  });
});
