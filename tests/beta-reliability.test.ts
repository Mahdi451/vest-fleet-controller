import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { rmSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { D } from '../packages/core/src/index.ts';
import { assessFilledRisk } from '../packages/risk-engine/src/index.ts';
import { FleetController } from '../packages/execution/src/controller.ts';
import { Journal } from '../packages/execution/src/journal.ts';
import { MockVestAdapter } from '../packages/simulator/src/index.ts';
import { SimulationStore } from '../packages/simulator/src/storage.ts';
import { createDashboard } from '../apps/dashboard/server.ts';
import { config, intent, NOW, setup } from './helpers.ts';
import { privateRuntime, writeFixtureFileSync } from './fixtures/runtime.ts';

let s: Awaited<ReturnType<typeof setup>>;
beforeEach(async () => {
  s = await setup();
});
afterEach(() => {
  s.journal.close();
});
async function enter(selected = ['01'], side: 'LONG' | 'SHORT' = 'LONG') {
  const p = await s.controller.preview({ ...intent, side }, selected);
  const r = await s.controller.execute(randomUUID(), p.previewId);
  return { p, r };
}
describe('terminal partial fills and actual risk', () => {
  it.each(['LONG', 'SHORT'] as const)(
    'protects terminal partial %s quantity and continues only after both exits',
    async (side) => {
      s.adapter.injectFault('01', 'PARTIAL_FILL');
      const { p, r } = await enter(['01', '02'], side);
      expect(r.every((x) => x.state === 'PROTECTED')).toBe(true);
      expect(r[0]?.entryWasPartial).toBe(true);
      expect(new D(r[0]!.filledSize).lt(p.orders[0]!.quantity)).toBe(true);
      const open = await s.adapter.getOpenOrders('01');
      expect(open).toHaveLength(2);
      expect(open.every((o) => o.quantity === r[0]!.filledSize)).toBe(true);
      const stop = open.find((o) => o.type === 'STOP_LOSS')!;
      await s.adapter.updatePrice(stop.triggerPrice);
      expect((await s.adapter.getAccountState('01')).positions).toEqual([]);
      expect(await s.adapter.getOpenOrders('01')).toEqual([]);
    },
  );
  it('does not accept a partial fill whose remainder can still grow', async () => {
    s.adapter.injectFault('01', 'PARTIAL_FILL_PENDING');
    const place = vi.spyOn(s.adapter, 'placeOrder');
    const { r } = await enter(['01', '02']);
    expect(r[0]).toMatchObject({ state: 'UNKNOWN', cleanupStatus: 'FLAT' });
    expect(r[1]?.state).toBe('HALTED');
    expect(place).toHaveBeenCalledTimes(1);
    expect((await s.controller.flattenAll())[0]?.status).toBe('UNKNOWN');
  });
  it('calculates final loss with actual entry fees and does not double-debit them from remaining balance', async () => {
    const { p, r } = await enter();
    const account = await s.adapter.getAccountState('01');
    const risk = assessFilledRisk(
      account,
      intent,
      config,
      r[0]!.fees,
      p.orders[0]!.totalPlannedLoss,
    );
    expect(risk.approved).toBe(true);
    expect(r[0]?.actualPlannedLoss).toBe(risk.totalLoss);
    expect(
      new D(risk.remainingAfterStop).eq(
        new D('504.55').minus(risk.totalLoss).minus('490'),
      ),
    ).toBe(true);
    expect(
      assessFilledRisk(
        { ...account, balance: '491', equity: '491', remainingDrawdown: '1' },
        intent,
        config,
        r[0]!.fees,
        p.orders[0]!.totalPlannedLoss,
      ).approved,
    ).toBe(false);
    expect(
      assessFilledRisk(
        account,
        intent,
        config,
        '20',
        p.orders[0]!.totalPlannedLoss,
      ).approved,
    ).toBe(false);
  });
  it('rejects changed post-fill risk and attempts cleanup before later entries', async () => {
    const real = s.adapter.getAccountState.bind(s.adapter);
    vi.spyOn(s.adapter, 'getAccountState').mockImplementation(async (id) => {
      const a = await real(id);
      if (a.positions.length) {
        a.drawdown.floor = '504';
        a.remainingDrawdown = new D(a.equity).minus('504').toFixed();
      }
      return a;
    });
    const { r } = await enter(['01', '02']);
    expect(r[0]).toMatchObject({ state: 'UNKNOWN', cleanupStatus: 'FLAT' });
    expect(r[1]?.state).toBe('HALTED');
  });
});

describe('book reconciliation and operational health', () => {
  it('reports SAFE only after fresh reconciliation and exposes stage timings', async () => {
    expect(s.controller.health().state).toBe('DEGRADED');
    expect((await s.controller.reconcile()).state).toBe('SAFE');
    await enter();
    expect((await s.controller.reconcile()).state).toBe('SAFE');
    const health = s.controller.health();
    expect(health.metrics.entries).toBe(1);
    expect(health.metrics.lastFillLatencyMs).toBeGreaterThanOrEqual(0);
    expect(health.metrics.lastProtectionLatencyMs).toBeGreaterThanOrEqual(0);
    expect(
      s.journal
        .events()
        .some(
          (e) =>
            e.status === 'PROTECTION_VERIFIED' &&
            e.protectionLatencyMs !== undefined,
        ),
    ).toBe(true);
    s.advance(5001);
    expect((await s.controller.reconcile()).state).toBe('DEGRADED');
  });
  it('allows normal SL/TP exits to reconcile without a false divergence', async () => {
    const { r } = await enter();
    await s.adapter.updatePrice(r[0]!.targetPrice!);
    expect((await s.controller.reconcile()).state).toBe('SAFE');
  });
  it('detects external manual close and latches a halt', async () => {
    await enter();
    await s.adapter.closePosition('01');
    const h = await s.controller.reconcile();
    expect(h.state).toBe('HALTED');
    expect(h.issues).toContainEqual({
      accountId: '01',
      code: 'EXTERNAL_OR_UNVERIFIED_EXIT',
    });
  });
  it('detects manual quantity changes, cleans up, and does not re-arm on a later good scan', async () => {
    const { r } = await enter();
    await s.adapter.closePosition(
      '01',
      new D(r[0]!.filledSize).div(2).toFixed(),
    );
    expect((await s.controller.reconcile()).state).toBe('HALTED');
    expect((await s.adapter.getAccountState('01')).positions).toEqual([]);
    expect((await s.controller.reconcile()).state).toBe('HALTED');
  });
  it.each(['STOP_LOSS', 'TAKE_PROFIT'] as const)(
    'detects missing %s protection outside execution and flattens',
    async (type) => {
      await enter();
      const order = (await s.adapter.getOpenOrders('01')).find(
        (o) => o.type === type,
      )!;
      await s.adapter.cancelOrder('01', order.orderId);
      const flat = vi.spyOn(s.adapter, 'flattenAccount');
      expect((await s.controller.reconcile()).state).toBe('HALTED');
      expect(flat).toHaveBeenCalledWith('01');
      expect((await s.adapter.getAccountState('01')).positions).toEqual([]);
    },
  );
  it('cleans an orphan order and verifies cancellation instead of trusting acknowledgement', async () => {
    const { r } = await enter();
    const order = (await s.adapter.getOpenOrders('01'))[0]!;
    await s.adapter.updatePrice(r[0]!.targetPrice!);
    const original = s.adapter.getOpenOrders.bind(s.adapter);
    vi.spyOn(s.adapter, 'getOpenOrders').mockImplementation(async (id) =>
      id === '01' ? [{ ...order, status: 'ACTIVE' }] : original(id),
    );
    const cancel = vi.spyOn(s.adapter, 'cancelOrder');
    const h = await s.controller.reconcile();
    expect(h.state).toBe('HALTED');
    expect(h.issues.some((i) => i.code === 'ORPHAN_PROTECTION')).toBe(true);
    expect(cancel).toHaveBeenCalledWith('01', order.orderId);
  });
  it('halts on disconnect, then reconciles after reconnect without restoring entry permission', async () => {
    await enter();
    await s.adapter.disconnect();
    expect((await s.controller.reconcile()).state).toBe('HALTED');
    await s.adapter.connect();
    expect((await s.controller.reconcile()).state).toBe('HALTED');
    expect(
      (await s.adapter.getAccountState('01')).positions[0]?.protectionStatus,
    ).toBe('ACTIVE');
  });
  it('rejects empty or shrinking inventory instead of reporting SAFE', async () => {
    await s.controller.reconcile();
    const all = await s.adapter.listAccounts();
    vi.spyOn(s.adapter, 'listAccounts').mockResolvedValue(all.slice(1));
    const h = await s.controller.reconcile();
    expect(h.state).toBe('HALTED');
    expect(h.issues).toContainEqual({
      accountId: '01',
      code: 'ACCOUNT_MISSING',
    });
  });
  it('times out hung reconciliation without clearing the circuit', async () => {
    vi.spyOn(s.adapter, 'getQuote').mockImplementation(
      () => new Promise(() => {}),
    );
    expect((await s.controller.reconcile()).state).toBe('HALTED');
  });
  it('bounds dashboard audit reads while preserving chronological order', async () => {
    await enter();
    expect(s.journal.events(3)).toEqual(s.journal.events().slice(-3));
    expect(() => s.journal.events(0)).toThrow('INVALID_AUDIT_LIMIT');
  });
  it('latches the circuit when reconciliation audit storage fails', async () => {
    vi.spyOn(s.journal, 'log').mockImplementation(() => {
      throw new Error('DISK_FULL');
    });
    await expect(s.controller.reconcile()).rejects.toThrow(
      'RECONCILIATION_AUDIT_FAILED',
    );
    expect(s.controller.health().state).toBe('HALTED');
  });
  it('halts and attempts flatten when persisting an entry fails', async () => {
    const adapter = new MockVestAdapter(
      config,
      s.clock,
      undefined,
      '30400',
      (e) => s.journal.log(e),
      (saved) => {
        if (JSON.stringify(saved).includes('"protectionStatus":"NONE"'))
          throw new Error('DISK_FULL');
      },
    );
    await adapter.connect();
    const controller = new FleetController(adapter, config, s.journal, s.clock);
    const p = await controller.preview(intent, ['01', '02']);
    const flat = vi.spyOn(adapter, 'flattenAccount');
    const r = await controller.execute('disk-failure', p.previewId);
    expect(r[0]?.state).toBe('UNKNOWN');
    expect(r[1]?.state).toBe('HALTED');
    expect(flat).toHaveBeenCalledWith('01');
  });
  it('retains the runtime live-mode veto', () => {
    const adapter = Object.create(s.adapter);
    Object.defineProperty(adapter, 'mode', { value: 'LIVE' });
    expect(() => new FleetController(adapter, config, s.journal)).toThrow(
      'LIVE_EXECUTION_DISABLED',
    );
  });
});

describe('durable simulator recovery', () => {
  it.each(['ENTRY_FILLED_UNPROTECTED', 'PROTECTION_ACTIVE'])(
    'recovers a real process kill at %s and fails closed',
    async (stage) => {
      const directory = privateRuntime('vest-crash-');
      const path = join(directory, 'journal.sqlite');
      try {
        const child = spawnSync(
          process.execPath,
          ['--import', 'tsx', 'tests/fixtures/crash-worker.ts', path, stage],
          { cwd: process.cwd(), timeout: 10000 },
        );
        expect(child.error, child.stderr.toString()).toBeUndefined();
        expect(child.stderr.toString()).not.toMatch(
          /CRASH_INJECTION_NOT_REACHED|(?:^|\n)\w*Error:/,
        );
        if (process.platform === 'win32') {
          expect(
            child.signal === 'SIGKILL' ||
              (child.status !== null && child.status !== 0),
          ).toBe(true);
        } else {
          expect(child.signal, child.stderr.toString()).toBe('SIGKILL');
        }
        const journal = new Journal(path);
        try {
          expect(journal.events().some((event) => event.status === stage)).toBe(
            true,
          );
          const adapter = new MockVestAdapter(
            config,
            () => NOW,
            undefined,
            '30400',
            (e) => journal.log(e),
            (v) => journal.saveSimulator(v),
            journal.loadSimulator(),
          );
          await adapter.connect();
          expect((await adapter.getAccountState('01')).positions).toHaveLength(
            1,
          );
          const controller = new FleetController(
            adapter,
            config,
            journal,
            () => NOW,
          );
          expect(controller.health().state).toBe('HALTED');
          await controller.reconcile();
          expect((await adapter.getAccountState('01')).positions).toEqual([]);
          expect(await adapter.getOpenOrders('01')).toEqual([]);
          expect((await adapter.getAccountState('02')).positions).toEqual([]);
          expect(controller.health().state).toBe('HALTED');
          const saved = journal.loadSimulator();
          expect(saved).not.toBeNull();
        } finally {
          journal.close();
        }
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    },
  );
  it('restores protection and entry deduplication from the snapshot', async () => {
    const spy = vi.spyOn(s.adapter, 'placeOrder');
    const protectionSpy = vi.spyOn(s.adapter, 'placeProtectionOrder');
    const { r } = await enter();
    const saved = s.adapter.exportSnapshot();
    const restored = new MockVestAdapter(
      config,
      s.clock,
      undefined,
      '30400',
      undefined,
      undefined,
      saved,
    );
    await restored.connect();
    expect(await restored.placeOrder(spy.mock.calls[0]![0])).toMatchObject({
      status: 'FILLED',
      filledSize: r[0]!.filledSize,
    });
    expect(await restored.getOpenOrders('01')).toHaveLength(2);
    expect(await restored.getAccountState('01')).toEqual(
      await s.adapter.getAccountState('01'),
    );
    const old = (await restored.getOpenOrders('01'))[0]!;
    const request = protectionSpy.mock.calls[0]![0];
    expect((await restored.placeProtectionOrder(request)).orderId).toBe(
      old.orderId,
    );
    expect(await restored.getOpenOrders('01')).toHaveLength(2);
  });
  it('rejects changed configuration and malformed durable state', () => {
    const saved = s.adapter.exportSnapshot();
    expect(
      () =>
        new MockVestAdapter(
          { ...config, maxLeverage: '40' },
          s.clock,
          undefined,
          '30400',
          undefined,
          undefined,
          saved,
        ),
    ).toThrow('SIMULATION_CONFIG_CHANGED');
    expect(
      () =>
        new MockVestAdapter(
          config,
          s.clock,
          undefined,
          '30400',
          undefined,
          undefined,
          { ...saved, version: 2 },
        ),
    ).toThrow();
  });
  it('refuses a second store owner and requires deliberate stale-lock recovery', () => {
    const directory = privateRuntime('vest-owner-');
    try {
      const first = new SimulationStore(directory);
      expect(() => new SimulationStore(directory)).toThrow(
        'SIMULATION_STORE_LOCKED',
      );
      first.close();
      writeFixtureFileSync(
        join(directory, 'controller.lock'),
        JSON.stringify({ pid: 999999999, id: 'stale' }),
      );
      expect(() => new SimulationStore(directory)).toThrow(
        'SIMULATION_STORE_LOCKED',
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
  it('does not invent a fresh fleet when the active session journal is missing', () => {
    const directory = privateRuntime('vest-missing-');
    try {
      const store = new SimulationStore(directory);
      writeFixtureFileSync(
        join(directory, 'active-session.json'),
        JSON.stringify({ sessionId: randomUUID() }),
      );
      expect(() => store.open()).toThrow('MISSING_SESSION_JOURNAL');
      store.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
  it('refuses a missing snapshot for a journal with execution history', () => {
    const directory = privateRuntime('vest-no-snapshot-');
    try {
      const store = new SimulationStore(directory);
      const session = store.open();
      session.journal.claim('pending', 'preview');
      session.journal.close();
      expect(() => store.open()).toThrow('MISSING_SIMULATOR_SNAPSHOT');
      store.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
  it('restores a dashboard fleet on restart, halts entries, and retains the old journal on reset', async () => {
    const directory = privateRuntime('vest-dashboard-');
    let app: Awaited<ReturnType<typeof createDashboard>> | undefined;
    const start = async () => {
      app = await createDashboard(config, directory);
      await new Promise<void>((done) =>
        app!.server.listen(0, '127.0.0.1', done),
      );
      const address = app.server.address();
      if (!address || typeof address === 'string')
        throw new Error('NO_ADDRESS');
      const base = `http://127.0.0.1:${address.port}`;
      const state = await (await fetch(`${base}/api/state`)).json();
      const post = async (path: string, body: unknown) =>
        fetch(`${base}/api/${path}`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Session-Token': state.token,
          },
          body: JSON.stringify(body),
        });
      return { base, state, post };
    };
    const stop = async () => {
      if (app) {
        await app.close();
        app = undefined;
      }
    };
    try {
      const first = await start();
      const preview = await (
        await first.post('preview', { intent, selected: ['01'] })
      ).json();
      const result = await (
        await first.post('execute', {
          masterTradeId: randomUUID(),
          previewId: preview.preview.previewId,
          sessionId: first.state.sessionId,
        })
      ).json();
      expect(result.results[0].state).toBe('PROTECTED');
      await stop();
      const second = await start();
      expect(second.state.sessionId).toBe(first.state.sessionId);
      expect(second.state.halted).toBe(true);
      expect(second.state.accounts[0].positions[0].protectionStatus).toBe(
        'ACTIVE',
      );
      expect(second.state.accounts[0].balance).toBe(
        result.state.accounts[0].balance,
      );
      expect(
        (await (await fetch(`${second.base}/api/health`)).json()).state,
      ).toBe('HALTED');
      expect(
        (await (await second.post('reconcile', {})).json()).state.halted,
      ).toBe(true);
      const reset = await (
        await second.post('reset', { confirm: 'RESET_SIMULATION' })
      ).json();
      expect(reset.state.sessionId).not.toBe(first.state.sessionId);
      expect(reset.state.accounts[0].positions).toEqual([]);
      expect(
        existsSync(join(directory, `${first.state.sessionId}.sqlite`)),
      ).toBe(true);
      expect(
        JSON.parse(readFileSync(join(directory, 'active-session.json'), 'utf8'))
          .sessionId,
      ).toBe(reset.state.sessionId);
    } finally {
      await stop();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
