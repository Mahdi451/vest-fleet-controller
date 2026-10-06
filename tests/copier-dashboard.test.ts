import { randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { request as httpRequest } from 'node:http';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import { createDashboard } from '../apps/dashboard/server.ts';
import { MockVestAdapter } from '../packages/simulator/src/index.ts';
import { PrivateAccess } from '../apps/dashboard/src/private-access.ts';
import { privateHost } from './fixtures/private-host.ts';
import { config, intent, NOW } from './helpers.ts';

const CANARY = 'synthetic-dashboard-canary_f18de8041f564d40a988755c709ed3e7';
const arm = {
  followers: ['02', '03'],
  maxLeverage: '50',
  maxNotional: '100000',
  maxPlannedLoss: '10',
  durationMs: 10000,
};
async function start(directory?: string) {
  const app = await createDashboard(config, directory, false, undefined, {
    now: () => NOW,
  });
  await new Promise<void>((resolve) =>
    app.server.listen(0, '127.0.0.1', resolve),
  );
  const address = app.server.address();
  if (!address || typeof address === 'string') throw new Error('NO_ADDRESS');
  const base = `http://127.0.0.1:${address.port}`;
  const state = await (await fetch(`${base}/api/copier/state`)).json();
  async function post(
    action: string,
    body: unknown,
    headers: Record<string, string> = {},
  ) {
    return fetch(`${base}/api/copier/${action}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Session-Token': state.token,
        ...headers,
      },
      body: JSON.stringify(body),
    });
  }
  return {
    app,
    base,
    post,
    state,
    read: async () => (await fetch(`${base}/api/copier/state`)).json(),
  };
}
type Fixture = Awaited<ReturnType<typeof start>>;
async function fixture(run: (f: Fixture) => Promise<void>) {
  const f = await start();
  try {
    await run(f);
  } finally {
    await f.app.close();
    vi.restoreAllMocks();
  }
}
const event = () => ({ eventKey: randomUUID(), sequence: 1, intent });
async function outcomes(f: Fixture) {
  expect((await f.post('arm', arm)).status).toBe(200);
  expect(
    (await f.post('scenario', { accountId: '02', fault: 'REJECT_STOP' }))
      .status,
  ).toBe(200);
  expect(
    (await f.post('scenario', { accountId: '03', fault: 'UNKNOWN_ENTRY' }))
      .status,
  ).toBe(200);
  const request = event(),
    response = await f.post('entry', request);
  expect(response.status).toBe(200);
  const state = await f.read();
  expect(
    state.events[0].followers.map(
      (row: { accountId: string }) => row.accountId,
    ),
  ).toEqual(['02', '03']);
  expect(state.events[0].followers[0].attempt.outcome).toMatchObject({
    submission: 'ACCEPTED',
    stop: 'FAILED',
    exposure: 'PRESENT',
  });
  expect(state.events[0].followers[1].attempt.outcome).toMatchObject({
    submission: 'UNKNOWN',
    exposure: 'UNKNOWN',
  });
  return { request, state, eventId: state.events[0].eventId };
}

describe('additive synthetic copier dashboard API', () => {
  it('starts LOCKED with zero dispatch and preserves the legacy API', async () =>
    fixture(async (f) => {
      const entry = vi.spyOn(MockVestAdapter.prototype, 'placeOrder');
      expect(f.state).toMatchObject({
        session: 'LOCKED',
        liveState: 'LOCKED',
        liveSend: false,
        events: [],
      });
      expect((await f.post('entry', event())).status).toBe(400);
      expect((await f.read()).events).toEqual([]);
      expect(entry).not.toHaveBeenCalled();
      expect((await fetch(`${f.base}/api/state`)).status).toBe(200);
    }));
  it('shows isolated outcomes, safely adds a stop, refuses UNKNOWN retry and replays without resend', async () =>
    fixture(async (f) => {
      const entry = vi.spyOn(MockVestAdapter.prototype, 'placeOrder');
      const { request, eventId } = await outcomes(f);
      expect(entry).toHaveBeenCalledTimes(2);
      const repair = await f.post('repair', {
        eventId,
        accountId: '02',
        operation: 'ADD_STOP',
        expectedAttemptId: (await f.read()).events[0].followers.find(
          (r: { accountId: string }) => r.accountId === '02',
        ).attempt.attemptId,
      });
      expect(repair.status).toBe(200);
      expect((await repair.json()).result.repair.state).toBe('VERIFIED');
      expect((await f.read()).events[0].followers[0].attempt.outcome.stop).toBe(
        'VERIFIED',
      );
      expect(
        (
          await f.post('repair', {
            eventId,
            accountId: '03',
            operation: 'RETRY',
            expectedAttemptId: (await f.read()).events[0].followers.find(
              (r: { accountId: string }) => r.accountId === '03',
            ).attempt.attemptId,
          })
        ).status,
      ).toBe(400);
      expect((await f.post('entry', request)).status).toBe(200);
      expect(entry).toHaveBeenCalledTimes(2);
      expect((await f.post('lock', {})).status).toBe(200);
      expect((await f.read()).session).toBe('LOCKED');
      expect((await f.post('entry', { ...event(), sequence: 2 })).status).toBe(
        400,
      );
      expect(entry).toHaveBeenCalledTimes(2);
    }));
  it('applies durable leader changes, preserves historical fills, and locks unknown capabilities', async () =>
    fixture(async (f) => {
      expect(
        (await f.post('arm', { ...arm, maxPlannedLoss: '1000' })).status,
      ).toBe(200);
      expect((await f.post('entry', event())).status).toBe(200);
      let state = await f.read();
      const entryEventId = state.events[0].eventId,
        filled = state.events[0].followers[0].attempt.outcome.filledQuantity;
      const request = {
        entryEventId,
        eventKey: randomUUID(),
        sequence: 2,
        kind: 'REDUCE',
        quantity: '0.5',
      };
      const send = vi.spyOn(MockVestAdapter.prototype, 'reduceOwnedPosition');
      expect((await f.post('change', request)).status).toBe(200);
      expect((await f.post('change', request)).status).toBe(200);
      expect(send).toHaveBeenCalledTimes(2);
      state = await f.read();
      expect(state.ownedRoots).toHaveLength(2);
      expect(
        state.mutations.every(
          (m: {
            state: string;
            request?: unknown;
            receipt?: unknown;
            leaderToSubmitMs: number;
          }) =>
            m.state === 'VERIFIED' &&
            m.request === undefined &&
            m.receipt === undefined &&
            m.leaderToSubmitMs === 0,
        ),
      ).toBe(true);
      expect(
        state.events.find(
          (e: { eventId: string }) => e.eventId === entryEventId,
        ).followers[0].attempt.outcome.filledQuantity,
      ).toBe(filled);
      await f.post('lock', {});
      expect(
        (
          await f.post('change', {
            ...request,
            eventKey: randomUUID(),
            sequence: 3,
          })
        ).status,
      ).toBe(400);
      expect(send).toHaveBeenCalledTimes(2);
      expect(
        (await f.post('change', { ...request, route: '/unexpected' })).status,
      ).toBe(400);
    }));
  it('shows the intended stop while provider submission is pending and lets other followers finish', async () =>
    fixture(async (f) => {
      await f.post('arm', { ...arm, maxPlannedLoss: '1000' });
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const original = MockVestAdapter.prototype.placeProtectionOrder;
      const hook = vi
        .spyOn(MockVestAdapter.prototype, 'placeProtectionOrder')
        .mockImplementation(async function (this: MockVestAdapter, request) {
          if (request.accountId === '02' && request.type === 'STOP_LOSS')
            await gate;
          return original.call(this, request);
        });
      const pending = f.post('entry', event());
      try {
        await vi.waitFor(async () => {
          const state = await f.read();
          const rows = state.events[0]?.followers;
          expect(
            rows?.find((r: { accountId: string }) => r.accountId === '02')
              ?.attempt?.outcome,
          ).toMatchObject({ stop: 'PENDING', stopPrice: expect.any(String) });
          expect(
            rows?.find((r: { accountId: string }) => r.accountId === '03')
              ?.attempt?.outcome.stop,
          ).toBe('VERIFIED');
        });
      } finally {
        release();
        await pending;
        hook.mockRestore();
      }
    }));
  it('repairs the current root through strict authenticated routes without creating leader events', async () =>
    fixture(async (f) => {
      await f.post('arm', { ...arm, maxPlannedLoss: '1000' });
      await f.post('scenario', { accountId: '02', fault: 'REJECT_TARGET' });
      await f.post('entry', event());
      let state = await f.read();
      const entryEventId = state.events[0].eventId;
      await f.post('change', {
        entryEventId,
        eventKey: randomUUID(),
        sequence: 2,
        kind: 'REDUCE',
        quantity: '0.25',
      });
      state = await f.read();
      let root = state.ownedRoots.find(
        (r: { accountId: string }) => r.accountId === '02',
      );
      const request = {
        actionId: randomUUID(),
        rootId: root.rootId,
        expectedRootRevision: root.revision,
        operation: 'ADD_TARGET',
        price: '30500',
      };
      expect((await f.post('root-repair', request)).status).toBe(200);
      expect((await f.post('root-repair', request)).status).toBe(200);
      state = await f.read();
      expect(state.events).toHaveLength(2);
      expect(state.ownedRepairs).toHaveLength(1);
      expect(state.ownedRepairs[0].state).toBe('VERIFIED');
      expect(state.ownedRepairs[0]).not.toHaveProperty('request');
      expect(state.ownedRepairs[0]).not.toHaveProperty('receipt');
      expect(
        (
          await f.post('root-repair', {
            ...request,
            actionId: randomUUID(),
            expectedRootRevision: root.revision,
          })
        ).status,
      ).toBe(200);
      expect((await f.read()).ownedRepairs[1].state).toBe('REFUSED');
      expect(
        (await f.post('root-repair', { ...request, route: '/arbitrary' }))
          .status,
      ).toBe(400);
      expect(
        (await f.post('root-repair', request, { 'X-Session-Token': '' }))
          .status,
      ).toBe(403);
      await f.post('lock', {});
      expect(
        (await f.post('root-reconcile', { rootId: root.rootId })).status,
      ).toBe(200);
      root = (await f.read()).ownedRoots.find(
        (r: { accountId: string }) => r.accountId === '02',
      );
      expect(
        (
          await f.post('root-repair', {
            actionId: randomUUID(),
            rootId: root.rootId,
            expectedRootRevision: root.revision,
            operation: 'FLATTEN',
          })
        ).status,
      ).toBe(400);
    }));
  it('rejects unauthorized and unknown capabilities with zero execution and sanitized errors', async () =>
    fixture(async (f) => {
      const entry = vi.spyOn(MockVestAdapter.prototype, 'placeOrder');
      expect((await f.post('arm', arm, { 'X-Session-Token': '' })).status).toBe(
        403,
      );
      expect(
        (await f.post('arm', arm, { Origin: 'https://unauthorized.invalid' }))
          .status,
      ).toBe(403);
      const wrongHost = await new Promise<number>((resolve, reject) => {
        const request = httpRequest(
          `${f.base}/api/copier/state`,
          {
            headers: { Host: 'unauthorized.invalid' },
          },
          (response) => {
            response.resume();
            resolve(response.statusCode!);
          },
        );
        request.on('error', reject);
        request.end();
      });
      expect(wrongHost).toBe(403);
      for (const [action, payload, status] of [
        ['arm', { ...arm, url: CANARY }, 400],
        ['entry', { ...event(), url: CANARY }, 400],
        [
          'repair',
          { eventId: 'a'.repeat(64), accountId: '02', operation: CANARY },
          400,
        ],
        ['arbitrary', { credential: CANARY }, 404],
      ] as const) {
        const response = await f.post(action, payload);
        expect(response.status).toBe(status);
        expect(await response.text()).not.toContain(CANARY);
      }
      expect((await f.read()).events).toEqual([]);
      expect(entry).not.toHaveBeenCalled();
    }));
  it('restores durable outcomes after restart while returning to LOCKED and never automatically trading', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'copier-dashboard-'));
    let f: Fixture | undefined;
    const entry = vi.spyOn(MockVestAdapter.prototype, 'placeOrder');
    try {
      f = await start(directory);
      const { request, state } = await outcomes(f);
      await f.app.close();
      f = undefined;
      expect(entry).toHaveBeenCalledTimes(2);
      f = await start(directory);
      expect(f.state.session).toBe('LOCKED');
      expect(
        f.state.events[0].followers.map(
          (row: { attempt: unknown }) => row.attempt,
        ),
      ).toEqual(
        state.events[0].followers.map(
          (row: { attempt: unknown }) => row.attempt,
        ),
      );
      expect((await f.post('entry', request)).status).toBe(200);
      expect(entry).toHaveBeenCalledTimes(2);
      expect((await fetch(`${f.base}/api/state`)).status).toBe(200);
    } finally {
      await f?.app.close();
      vi.restoreAllMocks();
      rmSync(directory, { recursive: true, force: true });
    }
  });
  it('publishes completed follower outcomes while another account submission is blocked', async () =>
    fixture(async (f) => {
      expect((await f.post('arm', arm)).status).toBe(200);
      let release!: () => void;
      const hold = new Promise<void>((resolve) => {
        release = resolve;
      });
      const original = MockVestAdapter.prototype.placeOrder;
      const entry = vi
        .spyOn(MockVestAdapter.prototype, 'placeOrder')
        .mockImplementation(async function (this: MockVestAdapter, request) {
          if (request.accountId === '02') await hold;
          return original.call(this, request);
        });
      const pending = f.post('entry', event());
      try {
        await vi.waitFor(async () => {
          const state = await f.read();
          const followers = state.events[0]?.followers;
          expect(
            followers?.find(
              (row: { accountId: string }) => row.accountId === '03',
            )?.attempt?.outcome.stop,
          ).toBe('VERIFIED');
          expect(
            followers?.find(
              (row: { accountId: string }) => row.accountId === '02',
            )?.attempt?.outcome.submission,
          ).toBe('SUBMITTING');
        });
        expect(entry).toHaveBeenCalledTimes(2);
      } finally {
        release();
        await pending;
      }
    }));
});

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
async function loaded(page: Page) {
  await page.waitForFunction(() =>
    document.getElementById('session')?.textContent?.includes('Simulation'),
  );
}
describe('headless synthetic copier dashboard', () => {
  it('inherits private HTTPS authentication, exact origin and revocation locking', async () => {
    const host = await privateHost();
    const reservation = createServer();
    await new Promise<void>((resolve) =>
      reservation.listen(0, '127.0.0.1', resolve),
    );
    const address = reservation.address();
    if (!address || typeof address === 'string') throw new Error('NO_ADDRESS');
    const port = address.port;
    await new Promise<void>((resolve, reject) =>
      reservation.close((error) => (error ? reject(error) : resolve())),
    );
    const origin = `https://localhost:${port}`;
    const app = await createDashboard(
      config,
      host.directory,
      false,
      new PrivateAccess({ ...host.config, origin, port }, host.tls),
      { now: () => NOW },
    );
    const context = await browser.newContext({ ignoreHTTPSErrors: true });
    try {
      await new Promise<void>((resolve) =>
        app.server.listen(port, '127.0.0.1', resolve),
      );
      expect(
        (await context.request.get(`${origin}/api/copier/state`)).status(),
      ).toBe(401);
      expect(
        (
          await context.request.post(`${origin}/api/copier/arm`, {
            data: arm,
            headers: { Origin: origin },
          })
        ).status(),
      ).toBe(401);
      expect(
        (
          await context.request.post(`${origin}/api/login`, {
            data: { secret: host.secret },
            headers: { Origin: origin },
          })
        ).status(),
      ).toBe(200);
      const state = await (
        await context.request.get(`${origin}/api/copier/state`)
      ).json();
      expect(
        (
          await context.request.post(`${origin}/api/copier/arm`, {
            data: arm,
            headers: { Origin: origin },
          })
        ).status(),
      ).toBe(403);
      expect(
        (
          await context.request.post(`${origin}/api/copier/arm`, {
            data: arm,
            headers: {
              Origin: 'https://wrong.invalid',
              'X-Session-Token': state.token,
            },
          })
        ).status(),
      ).toBe(403);
      const headers = { Origin: origin, 'X-Session-Token': state.token };
      expect(
        (
          await context.request.post(`${origin}/api/copier/arm`, {
            data: arm,
            headers,
          })
        ).status(),
      ).toBe(200);
      expect(
        (
          await context.request.post(`${origin}/api/logout`, {
            data: {},
            headers,
          })
        ).status(),
      ).toBe(200);
      expect(
        (await context.request.get(`${origin}/api/copier/state`)).status(),
      ).toBe(401);
      await context.request.post(`${origin}/api/login`, {
        data: { secret: host.secret },
        headers: { Origin: origin },
      });
      expect(
        (await (await context.request.get(`${origin}/api/copier/state`)).json())
          .session,
      ).toBe('LOCKED');
    } finally {
      await context.close();
      await app.close();
      await host.dispose();
    }
  });
  it.each([
    { width: 1440, height: 1100, name: 'desktop' },
    { width: 390, height: 844, name: 'mobile' },
  ])(
    'renders $name and exercises repair controls without external network or browser storage persistence',
    async (viewport) =>
      fixture(async (f) => {
        const context = await browser.newContext({
          viewport: { width: viewport.width, height: viewport.height },
        });
        const page = await context.newPage(),
          errors: string[] = [],
          requests: string[] = [];
        page.on('pageerror', (error) => errors.push(error.message));
        page.on('request', (request) => requests.push(request.url()));
        await context.route('**/*', async (route) => {
          if (new URL(route.request().url()).origin !== f.base) {
            await route.abort();
            return;
          }
          await route.continue();
        });
        try {
          await page.goto(`${f.base}/copier`);
          await loaded(page);
          expect(await page.locator('#entry').isDisabled()).toBe(true);
          await page.locator('#followers').fill('02,03');
          await page.locator('#leverage').fill('50');
          await page.locator('#loss').fill('10');
          await page.locator('#risk').fill(intent.riskValue);
          await page.locator('#arm').click();
          await page.waitForFunction(() =>
            document.getElementById('session')?.textContent?.includes('ARMED'),
          );
          await page.locator('#fault').selectOption('REJECT_STOP');
          await page.locator('#scenario').click();
          await page.waitForFunction(() =>
            document
              .getElementById('message')
              ?.textContent?.includes('Fault set'),
          );
          await page.locator('#scenario-account').selectOption('03');
          await page.locator('#fault').selectOption('UNKNOWN_ENTRY');
          await Promise.all([
            page.waitForResponse(
              (response) =>
                response.url().endsWith('/api/copier/scenario') &&
                response.request().method() === 'POST',
            ),
            page.locator('#scenario').click(),
          ]);
          await page.locator('#entry').click();
          await page.waitForFunction(() =>
            document
              .querySelector('tr[data-account="03"]')
              ?.textContent?.includes('UNKNOWN'),
          );
          expect(
            await page
              .locator('tr[data-account="03"] [data-operation="RETRY"]')
              .count(),
          ).toBe(0);
          expect(
            await page
              .locator('tr[data-account="02"] [data-operation="ADD_STOP"]')
              .count(),
          ).toBe(1);
          await page
            .locator('tr[data-account="02"] [data-operation="ADD_STOP"]')
            .click();
          await page.waitForFunction(() =>
            document
              .querySelector('tr[data-account="02"] td:nth-child(4)')
              ?.textContent?.startsWith('VERIFIED'),
          );
          const state = await f.read();
          expect(state.events[0].followers[0].attempt.outcome.stop).toBe(
            'VERIFIED',
          );
          expect(state.events[0].followers[1].attempt.outcome.submission).toBe(
            'UNKNOWN',
          );
          await page.locator('#change-kind').selectOption('STOP_CHANGED');
          await page.locator('#change-value').fill('30350');
          await page.locator('#change').click();
          await page.waitForFunction(() =>
            document
              .getElementById('changes')
              ?.textContent?.includes('VERIFIED'),
          );
          expect(await page.locator('#changes').textContent()).toContain(
            'desired price 30350',
          );
          expect(
            await page
              .locator('#owned-roots [data-root-account="02"]')
              .textContent(),
          ).toContain('stop 30350');
          await page.locator('#change-kind').selectOption('REDUCE');
          await page.locator('#change-value').fill('0.5');
          await page.locator('#change').click();
          await page.waitForFunction(() =>
            document
              .getElementById('message')
              ?.textContent?.includes('Leader change recorded'),
          );
          await page.waitForFunction(() =>
            document
              .getElementById('changes')
              ?.textContent?.includes('REDUCE · VERIFIED'),
          );
          const rootCard = page.locator(
            '#owned-roots [data-root-account="02"]',
          );
          const price = rootCard.locator(
            'input[aria-label="02 Add Target price"]',
          );
          await price.fill('30500');
          await page.waitForTimeout(600);
          expect(await price.inputValue()).toBe('30500');
          await rootCard.locator('[data-root-operation="ADD_TARGET"]').click();
          await page.waitForFunction(() =>
            document
              .getElementById('owned-repairs')
              ?.textContent?.includes('Add Target · VERIFIED'),
          );
          expect(await rootCard.textContent()).toContain('target 30500');
          await page.locator('#change-kind').selectOption('CLOSE');
          await page.locator('#change').click();
          await page.waitForFunction(() =>
            document
              .querySelector('#owned-roots [data-root-account="02"]')
              ?.textContent?.includes('CLOSED'),
          );
          expect(await page.locator('#events .event').count()).toBe(1);
          await page.locator('#lock').click();
          await page.waitForFunction(() =>
            document
              .getElementById('session')
              ?.textContent?.includes('Simulation LOCKED'),
          );
          expect(await page.locator('#entry').isDisabled()).toBe(true);
          const storage = await page.evaluate(() => ({
            local: { ...localStorage },
            session: { ...sessionStorage },
          }));
          expect(storage).toEqual({ local: {}, session: {} });
          expect(JSON.stringify(storage)).not.toContain(state.token);
          expect(errors).toEqual([]);
          expect(requests.length).toBeGreaterThan(3);
          expect(requests.every((url) => new URL(url).origin === f.base)).toBe(
            true,
          );
          const overflow = await page.evaluate(() => ({
            width: innerWidth,
            scroll: document.documentElement.scrollWidth,
            body: document.body.scrollWidth,
          }));
          expect(overflow.scroll).toBeLessThanOrEqual(overflow.width + 1);
          expect(overflow.body).toBeLessThanOrEqual(overflow.width + 1);
          mkdirSync('dist', { recursive: true });
          await page.screenshot({
            path: `dist/copier-dashboard-${viewport.name}.png`,
            fullPage: true,
          });
        } finally {
          await context.close();
        }
      }),
    30000,
  );
});
