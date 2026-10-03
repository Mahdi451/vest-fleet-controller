import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { get } from 'node:http';
import { createDashboard } from '../apps/dashboard/server.ts';
import { config, intent, NOW } from './helpers.ts';
import { MockVestAdapter } from '../packages/simulator/src/index.ts';

let app: Awaited<ReturnType<typeof createDashboard>>;
let base: string;
let token: string;
let sessionId: string;
const selected = ['01', '02', '03', '04', '05', '06', '07', '08', '09', '10'];
async function post(
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
) {
  return fetch(`${base}/api/${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Session-Token': token,
      ...headers,
    },
    body: JSON.stringify(body),
  });
}
async function preview() {
  const response = await post('preview', {
    intent: {
      ...intent,
      riskMode: 'MARGIN_PERCENT',
      riskValue: '25',
      leverage: '10',
    },
    selected,
  });
  expect(response.status).toBe(200);
  return (await response.json()).preview;
}
async function start(now?: () => number) {
  app = await createDashboard(
    config,
    undefined,
    false,
    undefined,
    now ? { now } : {},
  );
  await new Promise<void>((resolve) =>
    app.server.listen(0, '127.0.0.1', resolve),
  );
  const address = app.server.address();
  if (!address || typeof address === 'string') throw new Error('NO_ADDRESS');
  base = `http://127.0.0.1:${address.port}`;
  const state = await (await fetch(`${base}/api/state`)).json();
  expect(state.liveSend).toBe(false);
  token = state.token;
  sessionId = state.sessionId;
}
beforeEach(() => start());
afterEach(async () => {
  await app.close();
  vi.restoreAllMocks();
});
describe('local dashboard API', () => {
  it('expires controlled-time commands before dispatch and reports aged evidence', async () => {
    await app.close();
    let now = NOW;
    await start(() => now);
    const orders = vi.spyOn(MockVestAdapter.prototype, 'placeOrder');
    const { command } = await (
      await post('preview', { intent, selected })
    ).json();
    now += config.maxPreviewAgeMs + 1;
    const response = await post('execute', {
      commandId: command.id,
      payloadHash: command.payloadHash,
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'COMMAND_EXPIRED' });
    expect(orders).not.toHaveBeenCalled();
    const state = await (await fetch(`${base}/api/state`)).json();
    expect(state.freshness).toMatchObject({
      fresh: false,
      ageMs: config.maxPreviewAgeMs + 1,
    });
    expect(state.commands[0].status).toBe('PREVIEWED');
  });
  it('reports a completed partial fleet after controlled-time expiry during revalidation and replays without entry', async () => {
    await app.close();
    let now = NOW;
    await start(() => now);
    const orders = vi.spyOn(MockVestAdapter.prototype, 'placeOrder');
    const getAccountState = MockVestAdapter.prototype.getAccountState;
    let delayed = false;
    const { command } = await (
      await post('preview', { intent, selected })
    ).json();
    vi.spyOn(MockVestAdapter.prototype, 'getAccountState').mockImplementation(
      function (this: MockVestAdapter, id) {
        // Periodic reconciliation also reads account 08. Advance only after
        // execution has submitted the first seven entries, while its busy guard holds.
        if (id === '08' && orders.mock.calls.length === 7 && !delayed) {
          delayed = true;
          now += config.maxDataAgeMs + 1;
        }
        return getAccountState.call(this, id);
      },
    );
    const request = { commandId: command.id, payloadHash: command.payloadHash };
    const response = await post('execute', request);
    expect(response.status).toBe(200);
    const result = await response.json();
    expect(result.command.status).toBe('COMPLETE');
    expect(result.results.map((r: { state: string }) => r.state)).toEqual([
      ...Array(7).fill('PROTECTED'),
      'REJECTED',
      'HALTED',
      'HALTED',
    ]);
    expect(result.results[7].error).toBe('PRETRADE_REVALIDATION_FAILED');
    expect(result.state.halted).toBe(true);
    expect(
      result.state.accounts
        .slice(0, 7)
        .every(
          (a: { positions: { protectionStatus: string }[] }) =>
            a.positions.length === 1 &&
            a.positions[0]!.protectionStatus === 'ACTIVE',
        ),
    ).toBe(true);
    expect(orders.mock.calls.map(([order]) => order.accountId)).toEqual(
      selected.slice(0, 7),
    );
    const replay = await (await post('execute', request)).json();
    expect(replay.command.status).toBe('COMPLETE');
    expect(replay.results).toEqual(result.results);
    expect(orders).toHaveBeenCalledTimes(7);
  });
  it('serves a simulation-only interface with all ten accounts and security headers', async () => {
    const response = await fetch(base);
    expect(await response.text()).toContain('SIMULATION ONLY');
    expect(response.headers.get('Content-Security-Policy')).toContain(
      "frame-ancestors 'none'",
    );
    const state = await (await fetch(`${base}/api/state`)).json();
    expect(state.accounts).toHaveLength(10);
    expect(state.accounts[0].balance).toBe('504.55');
  });
  it('reports health, runs periodic reconciliation, and never re-arms through the reconcile route', async () => {
    const before = await (await fetch(`${base}/api/health`)).json();
    expect(before.state).toBe('SAFE');
    await new Promise((resolve) => setTimeout(resolve, 1100));
    const after = await (await fetch(`${base}/api/health`)).json();
    expect(after.metrics.reconciliationRuns).toBeGreaterThan(
      before.metrics.reconciliationRuns,
    );
    expect(
      (await post('reconcile', {}, { 'X-Session-Token': 'wrong' })).status,
    ).toBe(403);
    await post('flatten', {});
    const reconciled = await (await post('reconcile', {})).json();
    expect(reconciled.state.health.state).toBe('HALTED');
  });
  it('rejects cross-origin writes, missing tokens, non-loopback Hosts and invalid payloads', async () => {
    expect(
      (await post('flatten', {}, { Origin: 'https://example.com' })).status,
    ).toBe(403);
    expect(
      (await post('flatten', {}, { 'X-Session-Token': 'wrong' })).status,
    ).toBe(403);
    const badHostStatus = await new Promise<number | undefined>(
      (resolve, reject) => {
        get(
          `${base}/api/state`,
          { headers: { Host: 'example.com' } },
          (response) => {
            response.resume();
            resolve(response.statusCode);
          },
        ).on('error', reject);
      },
    );
    expect(badHostStatus).toBe(403);
    expect((await post('preview', { intent, selected: [] })).status).toBe(400);
    expect((await post('price', { price: '-1' })).status).toBe(400);
    expect((await fetch(`${base}/server.ts`)).status).toBe(404);
  });
  it('executes a preview, replays its ID without doubling positions, then flattens and halts', async () => {
    const p = await preview();
    const request = {
      previewId: p.previewId,
      masterTradeId: randomUUID(),
      sessionId,
    };
    const executed = await (await post('execute', request)).json();
    expect(
      executed.results.every((r: { status: string }) => r.status === 'FILLED'),
    ).toBe(true);
    const replay = await (await post('execute', request)).json();
    expect(replay.results).toEqual(executed.results);
    expect(
      replay.state.accounts.every(
        (a: { positions: unknown[] }) => a.positions.length === 1,
      ),
    ).toBe(true);
    const flat = await (await post('flatten', {})).json();
    expect(
      flat.results.every((r: { status: string }) => r.status === 'FLAT'),
    ).toBe(true);
    expect(flat.state.halted).toBe(true);
    expect(
      flat.state.accounts.every(
        (a: { positions: unknown[] }) => !a.positions.length,
      ),
    ).toBe(true);
    expect((await post('execute', request)).status).toBe(400);
  });
  it('rejects changed account state before filling', async () => {
    const p = await preview();
    await post('enabled', { accountId: '01', enabled: false });
    const result = await (
      await post('execute', {
        previewId: p.previewId,
        masterTradeId: randomUUID(),
        sessionId,
      })
    ).json();
    expect(result.results[0].status).toBe('REJECTED');
    expect(
      result.state.accounts.every(
        (a: { positions: unknown[] }) => !a.positions.length,
      ),
    ).toBe(true);
  });
  it('applies price moves through simulator stops and starts an explicit new session', async () => {
    const p = await preview();
    await post('execute', {
      previewId: p.previewId,
      masterTradeId: randomUUID(),
      sessionId,
    });
    const moved = await (await post('price', { price: '30500' })).json();
    expect(
      moved.state.accounts.every(
        (a: { positions: unknown[] }) => !a.positions.length,
      ),
    ).toBe(true);
    expect(Number(moved.state.accounts[1].balance)).toBeGreaterThan(500);
    expect((await post('reset', {})).status).toBe(400);
    const reset = await (
      await post('reset', { confirm: 'RESET_SIMULATION' })
    ).json();
    expect(reset.state.sessionId).not.toBe(sessionId);
    expect(reset.state.accounts[1].balance).toBe('500');
    expect(
      (
        await post('execute', {
          previewId: p.previewId,
          masterTradeId: randomUUID(),
          sessionId,
        })
      ).status,
    ).toBe(400);
  });
  it('shows unsafe requested exposure without silently reducing the requested size', async () => {
    const response = await post('preview', {
      intent: {
        ...intent,
        riskMode: 'MARGIN_PERCENT',
        riskValue: '25',
        leverage: '50',
      },
      selected,
    });
    const p = (await response.json()).preview;
    expect(p.orders.every((o: { approved: boolean }) => !o.approved)).toBe(
      true,
    );
    expect(Number(p.orders[1].notional)).toBeGreaterThan(6249);
    expect(p.orders[1].reasons).toContain('DRAWDOWN_RESERVE');
  });
});
