import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { get } from 'node:http';
import { createDashboard } from '../apps/dashboard/server.ts';
import { config, intent } from './helpers.ts';

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
beforeEach(async () => {
  app = await createDashboard(config);
  await new Promise<void>((resolve) =>
    app.server.listen(0, '127.0.0.1', resolve),
  );
  const address = app.server.address();
  if (!address || typeof address === 'string') throw new Error('NO_ADDRESS');
  base = `http://127.0.0.1:${address.port}`;
  const state = await (await fetch(`${base}/api/state`)).json();
  token = state.token;
  sessionId = state.sessionId;
});
afterEach(async () => {
  await new Promise<void>((resolve, reject) =>
    app.server.close((error) => (error ? reject(error) : resolve())),
  );
  await app.close();
});
describe('local dashboard API', () => {
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
