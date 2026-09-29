import { describe, expect, it } from 'vitest';
import { D } from '../packages/core/src/index.ts';
import { config, intent, setup } from './helpers.ts';

describe('ten-account simulator', () => {
  it.each(['LONG', 'SHORT'] as const)(
    'closes all ten winning %s positions and preserves fixed floors',
    async (side) => {
      const s = await setup();
      try {
        const p = await s.controller.preview({ ...intent, side });
        const r = await s.controller.execute('win', p.previewId);
        expect(r.every((a) => a.status === 'FILLED')).toBe(true);
        await s.adapter.updatePrice(side === 'LONG' ? '30480' : '30320');
        const accounts = await s.adapter.listAccounts();
        expect(accounts).toHaveLength(10);
        expect(
          accounts.every(
            (a) => a.positions.length === 0 && a.drawdown.floor === '490',
          ),
        ).toBe(true);
        expect(new D(accounts[0]!.balance).gt('504.55')).toBe(true);
        expect(new D(accounts[1]!.balance).gt('500')).toBe(true);
      } finally {
        s.journal.close();
      }
    },
  );
  it('all ten stop losses stay inside planned costs under the configured slippage', async () => {
    const s = await setup();
    try {
      const p = await s.controller.preview(intent);
      await s.controller.execute('loss', p.previewId);
      await s.adapter.updatePrice('30320');
      for (const a of await s.adapter.listAccounts()) {
        const preview = p.orders.find((x) => x.accountId === a.accountId)!;
        const initial = a.accountId === '01' ? '504.55' : '500';
        expect(
          new D(initial).minus(a.balance).lte(preview.totalPlannedLoss),
        ).toBe(true);
        expect(a.status).toBe('ACTIVE');
        expect(a.positions).toHaveLength(0);
      }
    } finally {
      s.journal.close();
    }
  });
  it('market gaps can breach accounts; recovery in price cannot resurrect them', async () => {
    const s = await setup();
    try {
      const p = await s.controller.preview(intent);
      await s.controller.execute('gap', p.previewId);
      await s.adapter.updatePrice('30000');
      await s.adapter.updatePrice('30400');
      expect(
        (await s.adapter.listAccounts()).every(
          (a) => a.status === 'BREACHED' && !a.positions.length,
        ),
      ).toBe(true);
    } finally {
      s.journal.close();
    }
  });
  it('charges entry and exit fees separately, with no double-realization of partial closes', async () => {
    const c = {
      ...config,
      entryFeeRate: '0.0001',
      exitFeeRate: '0.0001',
      slippagePointsPerSide: '0',
      fundingRateAllowance: '0',
    };
    const s = await setup(c);
    try {
      const p = await s.controller.preview(
        { ...intent, riskMode: 'FIXED_NOTIONAL', riskValue: '1000' },
        ['02'],
      );
      await s.controller.execute('fees', p.previewId);
      const qty = new D(p.orders[0]!.quantity),
        fee = qty.mul(30400).mul('0.0001');
      expect((await s.adapter.getAccountState('02')).balance).toBe(
        new D(500).minus(fee).toFixed(),
      );
      await s.adapter.closePosition('02', qty.div(2).toFixed());
      await s.adapter.flattenAccount('02');
      expect((await s.adapter.getAccountState('02')).balance).toBe(
        new D(500).minus(fee.mul(2)).toFixed(),
      );
    } finally {
      s.journal.close();
    }
  });
  it('settles scenario funding with direction and detects funding-driven breach', async () => {
    const s = await setup();
    try {
      const p = await s.controller.preview(intent, ['02']);
      await s.controller.execute('funding', p.previewId);
      const before = await s.adapter.getAccountState('02');
      await s.adapter.applyFunding('0.0001', '1');
      const after = await s.adapter.getAccountState('02');
      const cost = new D(before.positions[0]!.quantity)
        .mul(30400)
        .mul('0.0001');
      expect(new D(before.balance).minus(after.balance).eq(cost)).toBe(true);
      await s.adapter.applyFunding('1', '1');
      expect((await s.adapter.getAccountState('02')).status).toBe('BREACHED');
    } finally {
      s.journal.close();
    }
  });
  it('withdrawals debit gross profit, pay configured share and preserve floor', async () => {
    const s = await setup();
    try {
      expect(await s.adapter.withdrawProfit('01', '4', '0.95')).toEqual({
        grossDebit: '4',
        netPayout: '3.8',
        floor: '490',
      });
      expect((await s.adapter.getAccountState('01')).remainingDrawdown).toBe(
        '10.55',
      );
      await expect(s.adapter.withdrawProfit('02', '1', '0.95')).rejects.toThrow(
        'UNSAFE_WITHDRAWAL',
      );
    } finally {
      s.journal.close();
    }
  });
  it('disabled accounts cannot enter but can be flattened', async () => {
    const s = await setup();
    try {
      s.adapter.setEnabled('10', false);
      const p = await s.controller.preview(intent);
      const r = await s.controller.execute('disabled', p.previewId);
      expect(r.filter((x) => x.status === 'FILLED')).toHaveLength(9);
      s.adapter.setEnabled('01', false);
      expect(
        (await s.controller.flattenAll()).every((a) => a.status === 'FLAT'),
      ).toBe(true);
    } finally {
      s.journal.close();
    }
  });
});
