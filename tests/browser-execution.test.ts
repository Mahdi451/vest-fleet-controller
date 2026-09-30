import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, afterAll, describe, it, expect, vi } from 'vitest';
import { chromium, type Browser } from 'playwright';
import { initialFleet, D } from '../packages/core/src/index.ts';
import { BrowserExecutionAdapter } from '../packages/browser-execution/src/adapter.ts';
import { SequentialBrowserCoordinator } from '../packages/browser-execution/src/coordinator.ts';
import type { BrowserDom } from '../packages/browser-execution/src/dom.ts';
import { Journal } from '../packages/execution/src/journal.ts';
import { MockVestAdapter } from '../packages/simulator/src/index.ts';
import { fixturePage } from './fixtures/browser-page.ts';
import { config, intent } from './helpers.ts';

let browser: Browser;
beforeAll(async () => {
  browser = await chromium.launch({
    headless: true,
    ...(process.env.BROWSER_TEST_EXECUTABLE
      ? { executablePath: process.env.BROWSER_TEST_EXECUTABLE }
      : {}),
  });
});
afterAll(async () => {
  await browser?.close();
});
const c = { ...config, maxDataAgeMs: 60000, maxPreviewAgeMs: 60000 }; // Test browser duration; production defaults unchanged.
async function setup() {
  const journal = new Journal();
  const mock = new MockVestAdapter(c, Date.now, undefined, '30400');
  await mock.connect();
  const f = await fixturePage(browser, mock);
  const bindings = initialFleet(Date.now()).map((a) => ({
    accountId: a.accountId,
    label: a.label,
    contextId: f.dom.contextId,
  }));
  const adapter = new BrowserExecutionAdapter(f.dom, bindings, journal, {
    maxAgeMs: 60000,
  });
  await adapter.connect();
  const coordinator = new SequentialBrowserCoordinator(
    adapter,
    c,
    journal,
    '5',
  );
  return { ...f, bindings, adapter, coordinator, mock, journal };
}
type Setup = Awaited<ReturnType<typeof setup>>;
async function withFixture(run: (s: Setup) => Promise<void>) {
  const s = await setup();
  try {
    await run(s);
  } finally {
    await s.context.close();
    s.journal.close();
  }
}
async function execute(
  s: Setup,
  ids = ['01', '02'],
  side: 'LONG' | 'SHORT' = 'LONG',
) {
  const p = await s.coordinator.preview({ ...intent, side }, ids);
  return { p, ...(await s.coordinator.execute('browser-trade', p.previewId)) };
}
const test = (name: string, run: (s: Setup) => Promise<void>) =>
  it(name, () => withFixture(run), 60000);

describe('fixture-only visible browser execution', () => {
  for (const side of ['LONG', 'SHORT'] as const)
    test(`${side}: sequential fill-relative protection and retry replay`, async (s) => {
      const r = await execute(s, ['01', '02'], side);
      expect(r.results.map((r) => r.state)).toEqual(['PROTECTED', 'PROTECTED']);
      expect(s.actions.map((a) => a.kind)).toEqual([
        'ENTRY',
        'PROTECTION',
        'PROTECTION',
        'ENTRY',
        'PROTECTION',
        'PROTECTION',
      ]);
      for (const child of r.results) {
        const orders = await s.mock.getOpenOrders(child.accountId);
        const sign = side === 'LONG' ? 1 : -1;
        expect(orders.find((o) => o.type === 'STOP_LOSS')!.triggerPrice).toBe(
          new D(child.entryPrice!)
            .minus(new D(intent.stopDistancePoints).mul(sign))
            .toFixed(),
        );
        expect(orders.find((o) => o.type === 'TAKE_PROFIT')!.triggerPrice).toBe(
          new D(child.entryPrice!)
            .plus(new D(intent.takeProfitPoints).mul(sign))
            .toFixed(),
        );
        expect(child.entryPrice).not.toBe(r.p.quote.price);
      }
      const replay = await s.coordinator.execute(
        'browser-trade',
        r.p.previewId,
      );
      expect(replay.replayed).toBe(true);
      expect(s.actions).toHaveLength(6);
      expect(r.fanOutMs).toBeGreaterThan(0);
      expect(r.browser.metrics.switches).toBeGreaterThan(0);
    });
  test('wrong account selection aborts without any write', async (s) => {
    s.faults.wrongSelection = true;
    await expect(s.coordinator.preview(intent, ['01'])).rejects.toThrow();
    expect(s.actions).toHaveLength(0);
    expect(s.adapter.health().entriesBlocked).toBe(true);
  });
  test('context changes after form preparation abort the entry and cleanup never clicks the wrong account', async (s) => {
    const p = await s.coordinator.preview(intent, ['01', '02']);
    s.faults.switchAfterPrepare = true;
    const r = await s.coordinator.execute('wrong-context', p.previewId);
    expect(r.results[0]!.state).toBe('UNKNOWN');
    expect(r.results[1]!.state).toBe('HALTED');
    expect(s.actions).toHaveLength(0);
  });
  for (const fault of ['stale', 'duplicateRows', 'omitEntry'] as const)
    test(`${fault} visible evidence fails closed`, async (s) => {
      const p = await s.coordinator.preview(intent, ['01', '02']);
      const submit = s.dom.submitPrepared.bind(s.dom);
      vi.spyOn(s.dom, 'submitPrepared').mockImplementation(async () => {
        await submit();
        s.faults[fault] = true;
      });
      const r = await s.coordinator.execute('bad-evidence', p.previewId);
      expect(r.results[0]!.state).toBe('UNKNOWN');
      expect(r.results[1]!.state).toBe('HALTED');
      expect(s.actions.filter((a) => a.kind === 'ENTRY')).toHaveLength(1);
      expect(s.journal.halted()).toBe(true);
    });
  for (const type of ['STOP_LOSS', 'TAKE_PROFIT'] as const)
    test(`${type} rejection closes affected account and halts later accounts`, async (s) => {
      s.mock.injectProtectionFault('01', type, 'REJECT');
      const r = await execute(s);
      expect(r.results[0]!.state).toBe('UNKNOWN');
      expect(r.results[1]!.state).toBe('HALTED');
      expect((await s.mock.getAccountState('01')).positions).toHaveLength(0);
      expect(await s.mock.getOpenOrders('01')).toHaveLength(0);
    });
  test('lost entry response uses visible evidence and never resubmits', async (s) => {
    const p = await s.coordinator.preview(intent, ['01', '02']);
    s.faults.lostResponse = true;
    const r = await s.coordinator.execute('lost-response', p.previewId);
    expect(r.results[0]!.state).toBe('PROTECTED');
    expect(s.actions.filter((a) => a.kind === 'ENTRY')).toHaveLength(1);
    expect(r.results[1]!.state).not.toBe('PROTECTED');
  });
  test('terminal partial fill protects actual quantity through DOM', async (s) => {
    s.mock.injectFault('01', 'PARTIAL_FILL');
    const r = await execute(s, ['01']);
    expect(r.results[0]!.state).toBe('PROTECTED');
    expect(r.results[0]!.entryWasPartial).toBe(true);
    expect(
      (await s.mock.getOpenOrders('01')).every(
        (o) => o.quantity === r.results[0]!.filledSize,
      ),
    ).toBe(true);
  });
  test('pending partial remainder triggers cleanup and no later entries', async (s) => {
    s.mock.injectFault('01', 'PARTIAL_FILL_PENDING');
    const r = await execute(s);
    expect(r.results.map((r) => r.state)).toEqual(['UNKNOWN', 'HALTED']);
    expect(s.actions.filter((a) => a.kind === 'ENTRY')).toHaveLength(1);
  });
  test('fleet drift at next account blocks entry and retains earlier protection', async (s) => {
    const coordinator = new SequentialBrowserCoordinator(
      s.adapter,
      c,
      s.journal,
      '2',
    );
    const p = await coordinator.preview(intent, ['01', '02']);
    const original = s.adapter.placeOrder.bind(s.adapter);
    vi.spyOn(s.adapter, 'placeOrder').mockImplementation(async (r) => {
      if (r.accountId === '02') await s.mock.updatePrice('30403');
      return original(r);
    });
    const r = await coordinator.execute('drift', p.previewId);
    expect(r.results.map((r) => r.state)).toEqual(['PROTECTED', 'REJECTED']);
    expect(r.results[1]!.error).toBe('FLEET_PRICE_DRIFT');
    expect(await s.mock.getOpenOrders('01')).toHaveLength(2);
    expect(s.actions.filter((a) => a.kind === 'ENTRY')).toHaveLength(1);
  });
  test('fill drift beyond tolerance protects that fill then stops the next entry', async (s) => {
    const coordinator = new SequentialBrowserCoordinator(
      s.adapter,
      c,
      s.journal,
      '0.5',
    );
    const p = await coordinator.preview(intent, ['01', '02']);
    const r = await coordinator.execute('fill-drift', p.previewId);
    expect(r.results.map((r) => r.state)).toEqual(['PROTECTED', 'REJECTED']);
    expect(await s.mock.getOpenOrders('01')).toHaveLength(2);
  });
  test('protection and cancellation retries do not duplicate clicks', async (s) => {
    await execute(s, ['01']);
    const order = (await s.mock.getOpenOrders('01'))[0]!;
    const {
      orderId: _id,
      status: _status,
      filledSize: _size,
      error: _error,
      ...request
    } = order;
    void _id;
    void _status;
    void _size;
    void _error;
    await s.adapter.placeProtectionOrder(request);
    expect(s.actions.filter((a) => a.kind === 'PROTECTION')).toHaveLength(2);
    await s.adapter.cancelOrder('01', order.orderId);
    await s.adapter.cancelOrder('01', order.orderId);
    expect(s.actions.filter((a) => a.kind === 'CANCEL')).toHaveLength(1);
    await s.coordinator.controller.reconcile();
    expect((await s.mock.getAccountState('01')).positions).toHaveLength(0);
    expect(s.coordinator.controller.health().state).toBe('HALTED');
  });
  test('manual close is detected and flatten stays available', async (s) => {
    await execute(s, ['01']);
    await s.mock.flattenAccount('01');
    await s.coordinator.controller.reconcile();
    expect(s.coordinator.controller.health().state).toBe('HALTED');
    expect(
      (await s.coordinator.flattenAll()).every((r) => r.status === 'FLAT'),
    ).toBe(true);
  });
  test('closed browser after fill produces UNKNOWN; no cleanup success is invented', async (s) => {
    const submit = s.dom.submitPrepared.bind(s.dom);
    let first = true;
    vi.spyOn(s.dom, 'submitPrepared').mockImplementation(async () => {
      await submit();
      if (first) {
        first = false;
        await s.page.close();
      }
    });
    const r = await execute(s);
    expect(r.results.map((r) => r.state)).toEqual(['UNKNOWN', 'HALTED']);
    expect(r.results[0]!.cleanupStatus).toBe('UNKNOWN');
    expect(s.actions).toHaveLength(1);
  });
  test('timeout quarantines browser rather than retrying a possibly accepted click', async (s) => {
    s.faults.stall = true;
    const r = await execute(s);
    expect(r.results[0]!.state).toBe('UNKNOWN');
    expect(s.adapter.health().metrics.timeouts).toBe(1);
    await vi.waitFor(() => expect(s.page.isClosed()).toBe(true));
    expect(s.actions).toHaveLength(1);
    expect(s.journal.halted()).toBe(true);
  });
  test('restart retains command identity and requires halted reconciliation', async (s) => {
    await execute(s, ['01']);
    const restored = new BrowserExecutionAdapter(s.dom, s.bindings, s.journal, {
      maxAgeMs: 60000,
    });
    await restored.connect();
    expect(restored.health().state).toBe('RECOVERY_REQUIRED');
    expect(() =>
      restored.beginFleet(
        'new',
        { symbol: 'NDX', price: '30400', timestamp: Date.now() },
        '5',
      ),
    ).toThrow('BROWSER_ENTRIES_BLOCKED');
    expect((await restored.getAccountState('01')).positions).toHaveLength(1);
    await restored.flattenAccount('01');
    expect((await s.mock.getAccountState('01')).positions).toHaveLength(0);
  });
  test('hedge guard sees unselected enabled opposite exposure', async (s) => {
    await execute(s, ['01'], 'LONG');
    const p = await s.coordinator.preview({ ...intent, side: 'SHORT' }, ['02']);
    expect(p.orders[0]!.approved).toBe(false);
    expect(p.orders[0]!.reasons).toContain('CROSS_ACCOUNT_HEDGE_GUARD');
    s.mock.setEnabled('01', false);
    const allowed = await s.coordinator.preview({ ...intent, side: 'SHORT' }, [
      '02',
    ]);
    expect(allowed.orders[0]!.approved).toBe(true);
  });
  test('concurrent execute is rejected rather than interleaving account contexts', async (s) => {
    const p = await s.coordinator.preview(intent, ['01']);
    const running = s.coordinator.execute('first', p.previewId);
    await expect(s.coordinator.execute('second', p.previewId)).rejects.toThrow(
      'BROWSER_FLEET_BUSY',
    );
    await running;
  });
  test('identity bindings are copied and frozen; non-fixture drivers are rejected', async (s) => {
    s.bindings[0]!.accountId = 'changed';
    expect((await s.adapter.listAccounts())[0]!.accountId).toBe('01');
    expect(
      () =>
        new BrowserExecutionAdapter(
          { ...s.dom, environment: 'LIVE' } as unknown as BrowserDom,
          s.bindings,
          s.journal,
        ),
    ).toThrow('LIVE_BROWSER_DISABLED');
  });

  for (const stage of ['ENTRY', 'PROTECTION'] as const)
    it(`new browser context and disk journal recover crash after ${stage} without redispatch`, async () => {
      const dir = mkdtempSync(join(tmpdir(), 'vest-browser-'));
      const path = join(dir, 'journal.sqlite');
      let journal = new Journal(path);
      let context:
        Awaited<ReturnType<typeof fixturePage>>['context'] | undefined;
      let recoveredContext: typeof context;
      try {
        const mock = new MockVestAdapter(c);
        await mock.connect();
        const f = await fixturePage(browser, mock);
        context = f.context;
        const bindings = initialFleet(Date.now()).map((a) => ({
          accountId: a.accountId,
          label: a.label,
          contextId: f.dom.contextId,
        }));
        const adapter = new BrowserExecutionAdapter(f.dom, bindings, journal, {
          maxAgeMs: 60000,
        });
        await adapter.connect();
        const coordinator = new SequentialBrowserCoordinator(
          adapter,
          c,
          journal,
        );
        const submit = f.dom.submitPrepared.bind(f.dom);
        vi.spyOn(f.dom, 'submitPrepared').mockImplementation(async () => {
          const action = await f.dom.readPrepared();
          await submit();
          if (action.kind === stage) await f.page.close();
        });
        const p = await coordinator.preview(intent, ['01', '02']);
        const r = await coordinator.execute('crash', p.previewId);
        expect(r.results.map((r) => r.state)).toEqual(['UNKNOWN', 'HALTED']);
        const snapshot = mock.exportSnapshot();
        journal.close();
        journal = new Journal(path);
        expect(
          journal.browserActionAccount(`entry:${r.results[0]!.requestId}`),
        ).toBe('01');
        const restoredMock = new MockVestAdapter(
          c,
          Date.now,
          undefined,
          '30400',
          undefined,
          undefined,
          snapshot,
        );
        await restoredMock.connect();
        const restored = await fixturePage(browser, restoredMock);
        recoveredContext = restored.context;
        const restoredAdapter = new BrowserExecutionAdapter(
          restored.dom,
          bindings,
          journal,
          { maxAgeMs: 60000 },
        );
        await restoredAdapter.connect();
        const recovered = new SequentialBrowserCoordinator(
          restoredAdapter,
          c,
          journal,
        );
        expect(restoredAdapter.health().state).toBe('RECOVERY_REQUIRED');
        await recovered.controller.reconcile();
        expect(
          (await restoredMock.getAccountState('01')).positions,
        ).toHaveLength(0);
        expect(await restoredMock.getOpenOrders('01')).toHaveLength(0);
        expect(restored.actions.some((a) => a.kind === 'ENTRY')).toBe(false);
        expect(recovered.controller.health().state).toBe('HALTED');
      } finally {
        await context?.close();
        await recoveredContext?.close();
        journal.close();
        rmSync(dir, { recursive: true, force: true });
      }
    }, 60000);
  test('form tampering aborts before submit', async (s) => {
    const p = await s.coordinator.preview(intent, ['01']);
    const read = s.dom.readPrepared.bind(s.dom);
    vi.spyOn(s.dom, 'readPrepared').mockImplementation(async () => ({
      ...(await read()),
      accountId: '02',
    }));
    const r = await s.coordinator.execute('tamper', p.previewId);
    expect(r.results[0]!.state).toBe('UNKNOWN');
    expect(s.actions).toHaveLength(0);
  });
  test('journal write failure prevents browser dispatch', async (s) => {
    const p = await s.coordinator.preview(intent, ['01']);
    vi.spyOn(s.journal, 'claimBrowserAction').mockImplementation(() => {
      throw new Error('STORAGE_FAILURE');
    });
    const r = await s.coordinator.execute('storage-failure', p.previewId);
    expect(r.results[0]!.state).toBe('UNKNOWN');
    expect(s.actions).toHaveLength(0);
  });
  test('post-fill active protection cannot be inferred from a missing DOM order book', async (s) => {
    const submit = s.dom.submitPrepared.bind(s.dom);
    vi.spyOn(s.dom, 'submitPrepared').mockImplementation(async () => {
      const a = await s.dom.readPrepared();
      await submit();
      if (a.kind === 'PROTECTION') s.faults.omitProtection = true;
    });
    const r = await execute(s);
    expect(r.results.map((r) => r.state)).toEqual(['UNKNOWN', 'HALTED']);
    expect((await s.mock.getAccountState('01')).positions).toHaveLength(0);
  });
  test('ten-account fan-out remains strictly sequential with independent size', async (s) => {
    const r = await execute(
      s,
      initialFleet(Date.now()).map((a) => a.accountId),
    );
    expect(r.results).toHaveLength(10);
    expect(r.results.every((r) => r.state === 'PROTECTED')).toBe(true);
    expect(
      new Set(
        s.actions.filter((a) => a.kind === 'ENTRY').map((a) => a.accountId),
      ).size,
    ).toBe(10);
    expect(r.results[0]!.filledSize).not.toBe(r.results[1]!.filledSize);
    for (let index = 0; index < 10; index++)
      expect(
        s.actions.slice(index * 3, index * 3 + 3).map((a) => a.kind),
      ).toEqual(['ENTRY', 'PROTECTION', 'PROTECTION']);
  });
  test('account changes while filling the form abort before entry', async (s) => {
    const p = await s.coordinator.preview(intent, ['01']);
    const prepare = s.dom.prepare.bind(s.dom);
    vi.spyOn(s.dom, 'prepare').mockImplementation(async (a) => {
      await prepare(a);
      if (a.kind === 'ENTRY') s.mock.setEnabled('01', false);
    });
    const r = await s.coordinator.execute('form-account-change', p.previewId);
    expect(r.results[0]!.state).toBe('UNKNOWN');
    expect(s.actions).toHaveLength(0);
  });
  test('changed protection payload with reused ID is rejected without a second click', async (s) => {
    await execute(s, ['01']);
    const order = (await s.mock.getOpenOrders('01'))[0]!;
    const action = s.actions.find((a) => a.kind === 'PROTECTION');
    if (!action || action.kind !== 'PROTECTION')
      throw new Error('FIXTURE_MISSING_PROTECTION');
    await expect(
      s.adapter.placeProtectionOrder({
        ...action.order,
        triggerPrice: new D(order.triggerPrice).plus(1).toFixed(),
      }),
    ).rejects.toThrow();
    expect(s.actions.filter((a) => a.kind === 'PROTECTION')).toHaveLength(2);
  });
  it('unconfirmed durable browser actions halt a new controller even without a master record', () => {
    const journal = new Journal();
    try {
      expect(journal.halted()).toBe(false);
      expect(
        journal.claimBrowserAction('entry:pending', 'fingerprint', '01'),
      ).toBe(true);
      expect(journal.halted()).toBe(true);
      expect(
        journal.claimBrowserAction('entry:pending', 'fingerprint', '01'),
      ).toBe(false);
      expect(() =>
        journal.claimBrowserAction('entry:pending', 'changed', '01'),
      ).toThrow('IDEMPOTENCY_CONFLICT');
    } finally {
      journal.close();
    }
  });
});
