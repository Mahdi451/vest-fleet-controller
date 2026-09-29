import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FleetController } from '../packages/execution/src/controller.ts';
import { Journal, type AuditEvent } from '../packages/execution/src/journal.ts';
import { config, intent, NOW, setup } from './helpers.ts';

describe('execution reliability', () => {
  it('keeps the original account identity when an adapter returns another account', async () => {
    const s = await setup();
    try {
      vi.spyOn(s.adapter, 'placeOrder').mockImplementation(async (o) => ({
        requestId: o.requestId,
        accountId: 'WRONG',
        status: 'FILLED',
        filledSize: o.preview.quantity,
        entryPrice: '30400',
        fees: '0',
        error: null,
      }));
      const p = await s.controller.preview(intent, ['01']);
      const r = await s.controller.execute('wrong-account', p.previewId);
      expect(r[0]!.accountId).toBe('01');
      expect(r[0]!.status).toBe('UNKNOWN');
      expect(s.journal.unresolvedAccount('01')).toBe(true);
    } finally {
      s.journal.close();
    }
  });
  it('duplicate master requests never increase positions, including after close', async () => {
    const s = await setup();
    try {
      const place = vi.spyOn(s.adapter, 'placeOrder');
      const p = await s.controller.preview(intent);
      const first = await s.controller.execute('same', p.previewId);
      expect(await s.controller.execute('same', p.previewId)).toEqual(first);
      await s.controller.flattenAll();
      expect(await s.controller.execute('same', p.previewId)).toEqual(first);
      expect(place).toHaveBeenCalledTimes(10);
      expect(
        (await s.adapter.listAccounts()).every((a) => !a.positions.length),
      ).toBe(true);
    } finally {
      s.journal.close();
    }
  });
  it('same ID with different preview is rejected', async () => {
    const s = await setup();
    try {
      const p = await s.controller.preview(intent, ['01']);
      await s.controller.execute('same', p.previewId);
      const other = await s.controller.preview({ ...intent, riskValue: '20' }, [
        '02',
      ]);
      await expect(
        s.controller.execute('same', other.previewId),
      ).rejects.toThrow('IDEMPOTENCY_CONFLICT');
    } finally {
      s.journal.close();
    }
  });
  it('adapter independently deduplicates requests and rejects payload reuse', async () => {
    const s = await setup();
    try {
      const place = vi.spyOn(s.adapter, 'placeOrder');
      const p = await s.controller.preview(intent, ['01']);
      await s.controller.execute('adapter', p.previewId);
      const request = place.mock.calls[0]![0];
      const before = await s.adapter.getAccountState('01');
      expect((await s.adapter.placeOrder(request)).status).toBe('FILLED');
      expect(await s.adapter.getAccountState('01')).toEqual(before);
      await expect(
        s.adapter.placeOrder({ ...request, accountId: '02' }),
      ).rejects.toThrow('IDEMPOTENCY_CONFLICT');
    } finally {
      s.journal.close();
    }
  });
  it('fills accounts 1–7, reports rejection 8, and does not dispatch 9–10', async () => {
    const s = await setup();
    try {
      s.adapter.injectFault('08', 'REJECT');
      const p = await s.controller.preview(intent);
      const r = await s.controller.execute('partial', p.previewId);
      expect(r.map((a) => a.status)).toEqual([
        ...Array(7).fill('FILLED'),
        'REJECTED',
        'REJECTED',
        'REJECTED',
      ]);
      expect(r[8]!.error).toBe('CIRCUIT_OPEN');
      expect((await s.adapter.getAccountState('09')).positions).toHaveLength(0);
    } finally {
      s.journal.close();
    }
  });
  it('reconciles an ambiguous acknowledgement by exact order and protected position', async () => {
    const s = await setup();
    try {
      s.adapter.injectFault('10', 'AMBIGUOUS_AFTER_FILL');
      const p = await s.controller.preview(intent);
      const r = await s.controller.execute('ambiguous', p.previewId);
      expect(r.every((a) => a.status === 'FILLED')).toBe(true);
      expect((await s.adapter.getAccountState('10')).positions).toHaveLength(1);
    } finally {
      s.journal.close();
    }
  });
  it('timeout before fill stays unknown, halts remaining fan-out and cannot be retried', async () => {
    const s = await setup();
    try {
      s.adapter.injectFault('09', 'TIMEOUT_BEFORE_FILL');
      const place = vi.spyOn(s.adapter, 'placeOrder');
      const p = await s.controller.preview(intent);
      const first = await s.controller.execute('timeout', p.previewId);
      expect(first[8]!.status).toBe('UNKNOWN');
      expect(first[9]!.error).toBe('CIRCUIT_OPEN');
      expect(await s.controller.execute('timeout', p.previewId)).toEqual(first);
      expect(place).toHaveBeenCalledTimes(9);
      const flattened = await s.controller.flattenAll();
      expect(flattened[8]!.status).toBe('UNKNOWN');
    } finally {
      s.journal.close();
    }
  });
  it('a genuinely hanging adapter call times out without resend or false flatten success', async () => {
    const s = await setup();
    try {
      const place = vi
        .spyOn(s.adapter, 'placeOrder')
        .mockImplementation(() => new Promise(() => {}));
      const p = await s.controller.preview(intent, ['01']);
      const r = await s.controller.execute('hang', p.previewId);
      expect(r[0]!.status).toBe('UNKNOWN');
      expect((await s.controller.flattenAll())[0]!.status).toBe('UNKNOWN');
      await s.controller.execute('hang', p.previewId);
      expect(place).toHaveBeenCalledTimes(1);
    } finally {
      s.journal.close();
    }
  });
  it('rejects stale preview, changed accounts, and unknown selection', async () => {
    const s = await setup();
    try {
      await expect(s.controller.preview(intent, ['missing'])).rejects.toThrow(
        'INVALID_ACCOUNT_SELECTION',
      );
      const p = await s.controller.preview(intent, ['01']);
      s.advance(5001);
      expect((await s.controller.execute('stale', p.previewId))[0]!.error).toBe(
        'PREVIEW_EXPIRED',
      );
    } finally {
      s.journal.close();
    }
    const changed = await setup();
    try {
      const p = await changed.controller.preview(intent, ['01']);
      changed.adapter.setEnabled('01', false);
      expect(
        (await changed.controller.execute('changed', p.previewId))[0]!.error,
      ).toBe('PRETRADE_REVALIDATION_FAILED');
    } finally {
      changed.journal.close();
    }
  });
  it('rejects later children after significant price movement', async () => {
    const s = await setup();
    try {
      const real = s.adapter.placeOrder.bind(s.adapter);
      vi.spyOn(s.adapter, 'placeOrder').mockImplementation(async (o) => {
        const result = await real(o);
        if (o.accountId === '01') await s.adapter.updatePrice('30420');
        return result;
      });
      const p = await s.controller.preview(intent);
      const r = await s.controller.execute('move', p.previewId);
      expect(r[0]!.status).toBe('FILLED');
      expect(r[1]!.status).toBe('REJECTED');
      expect((await s.adapter.getAccountState('02')).positions).toHaveLength(0);
    } finally {
      s.journal.close();
    }
  });
  it('blocks opposing exposure even when the existing account is disabled and unselected', async () => {
    const s = await setup();
    try {
      const p = await s.controller.preview(intent, ['01']);
      await s.controller.execute('long', p.previewId);
      s.adapter.setEnabled('01', false);
      const short = await s.controller.preview({ ...intent, side: 'SHORT' }, [
        '02',
      ]);
      expect(short.orders[0]!.reasons).toContain('OPPOSING_FLEET_POSITION');
    } finally {
      s.journal.close();
    }
  });
  it('does not trust a FILLED response without a matching position', async () => {
    const s = await setup();
    try {
      vi.spyOn(s.adapter, 'placeOrder').mockImplementation(async (o) => ({
        requestId: o.requestId,
        accountId: o.accountId,
        status: 'FILLED',
        filledSize: o.preview.quantity,
        entryPrice: '30400',
        fees: '0',
        error: null,
      }));
      const p = await s.controller.preview(intent, ['01']);
      expect(
        (await s.controller.execute('false-fill', p.previewId))[0]!.status,
      ).toBe('UNKNOWN');
    } finally {
      s.journal.close();
    }
  });
  it('serializes entry attempts and emergency halt blocks subsequent children', async () => {
    const s = await setup();
    try {
      const p = await s.controller.preview(intent);
      const first = s.controller.execute('first', p.previewId);
      await expect(s.controller.execute('second', p.previewId)).rejects.toThrow(
        'CONTROLLER_BUSY',
      );
      await expect(s.controller.flattenAll()).rejects.toThrow(
        'EXECUTION_IN_PROGRESS_RETRY_FLATTEN',
      );
      const r = await first;
      expect(r.filter((x) => x.status === 'FILLED').length).toBeLessThanOrEqual(
        1,
      );
      expect(
        (await s.controller.flattenAll()).every((a) => a.status === 'FLAT'),
      ).toBe(true);
    } finally {
      s.journal.close();
    }
  });
  it('persists replay protection across journal/controller restart', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'vest-test-'));
    const path = join(directory, 'journal.sqlite');
    const s = await setup();
    const first = new Journal(path);
    try {
      const c1 = new FleetController(s.adapter, config, first, s.clock);
      const p = await c1.preview(intent, ['01']);
      const r = await c1.execute('restart', p.previewId);
      first.close();
      const second = new Journal(path);
      try {
        const place = vi.spyOn(s.adapter, 'placeOrder');
        const c2 = new FleetController(s.adapter, config, second, s.clock);
        expect(await c2.execute('restart', p.previewId)).toEqual(r);
        expect(place).not.toHaveBeenCalled();
      } finally {
        second.close();
      }
    } finally {
      s.journal.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
  it('crash after reservation fails closed and never treats an incomplete trade as successful', () => {
    const j = new Journal();
    try {
      j.claim('crashed', 'preview');
      expect(j.halted()).toBe(true);
      expect(() => j.replay('crashed', 'preview')).toThrow(
        'INCOMPLETE_TRADE_REQUIRES_RECONCILIATION',
      );
    } finally {
      j.close();
    }
  });
  it('structured audit events omit extra secret-bearing properties', () => {
    const j = new Journal();
    try {
      j.log({
        timestamp: NOW,
        masterTradeId: 'audit',
        status: 'PREVIEWED',
        adapter: 'MockVestAdapter',
        password: 'NEVER_LOG',
        bearerToken: 'NEVER_LOG',
        headers: { cookie: 'NEVER_LOG' },
      } as AuditEvent);
      expect(JSON.stringify(j.events())).not.toContain('NEVER_LOG');
    } finally {
      j.close();
    }
  });
});
