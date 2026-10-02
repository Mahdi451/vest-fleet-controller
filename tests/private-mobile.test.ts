import { createServer } from 'node:net';
import { mkdir } from 'node:fs/promises';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import { createDashboard } from '../apps/dashboard/server.ts';
import { PrivateAccess } from '../apps/dashboard/src/private-access.ts';
import { config } from './helpers.ts';
import { Journal, type AuditEvent } from '../packages/execution/src/journal.ts';
import { privateHost } from './fixtures/private-host.ts';

// Native diagnosis: measure existing durable calls without adding hot-path writes.
let audit: AuditEvent[];
let storage: Record<string, { count: number; totalMs: number; maxMs: number }>;
function measure<T>(name: string, action: () => T): T {
  const start = performance.now();
  try {
    return action();
  } finally {
    const duration = performance.now() - start;
    const stat = (storage[name] ??= { count: 0, totalMs: 0, maxMs: 0 });
    stat.count++;
    stat.totalMs += duration;
    stat.maxMs = Math.max(stat.maxMs, duration);
  }
}
beforeEach(() => {
  audit = [];
  storage = {};
  const log = Journal.prototype.log;
  vi.spyOn(Journal.prototype, 'log').mockImplementation(function (
    this: Journal,
    event,
  ) {
    audit.push(event);
    return measure('log', () => log.call(this, event));
  });
  const saveSimulator = Journal.prototype.saveSimulator;
  vi.spyOn(Journal.prototype, 'saveSimulator').mockImplementation(function (
    this: Journal,
    snapshot,
  ) {
    return measure('saveSimulator', () => saveSimulator.call(this, snapshot));
  });
  const child = Journal.prototype.child;
  vi.spyOn(Journal.prototype, 'child').mockImplementation(function (
    this: Journal,
    master,
    result,
  ) {
    return measure('child', () => child.call(this, master, result));
  });
  const saveCommand = Journal.prototype.saveCommand;
  vi.spyOn(Journal.prototype, 'saveCommand').mockImplementation(function (
    this: Journal,
    command,
  ) {
    return measure('saveCommand', () => saveCommand.call(this, command));
  });
  const finish = Journal.prototype.finish;
  vi.spyOn(Journal.prototype, 'finish').mockImplementation(function (
    this: Journal,
    id,
    result,
  ) {
    return measure('finish', () => finish.call(this, id, result));
  });
});
afterEach(() => vi.restoreAllMocks());
function reportExecution(label: string) {
  process.stdout.write(
    'PRIVATE_MOBILE_EXECUTION_DIAGNOSTICS ' +
      JSON.stringify({
        label,
        platform: process.platform,
        clock: 'CONTROLLED_SYNTHETIC_TIME',
        storage,
        children: audit
          .filter((event) => event.revalidation)
          .map((event) => ({
            accountId: event.accountId,
            status: event.status,
            error: event.error,
            latencyMs: event.latency,
            revalidation: event.revalidation,
          })),
        protection: audit
          .filter((event) => event.status === 'PROTECTION_VERIFIED')
          .map((event) => ({
            accountId: event.accountId,
            protectionLatencyMs: event.protectionLatencyMs,
          })),
      }) +
      '\n',
  );
}

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
async function availablePort() {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const address = probe.address();
  if (!address || typeof address === 'string') throw new Error('NO_ADDRESS');
  const port = address.port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}
async function privateViewCleared(
  page: Page,
  identity: { ownerId: string; instanceId: string },
) {
  await page.waitForSelector('#login-panel:not([hidden])');
  expect(await page.locator('#simulation-workspace').isHidden()).toBe(true);
  expect(await page.locator('#accounts').textContent()).toBe('');
  expect(await page.locator('#activity').textContent()).toBe('');
  expect(await page.locator('#equity').textContent()).toBe('—');
  expect(await page.locator('#instance').textContent()).not.toContain(
    identity.ownerId,
  );
  expect(await page.locator('#instance').textContent()).not.toContain(
    identity.instanceId,
  );
  expect(await page.locator('#command-status').textContent()).not.toContain(
    'COMPLETE',
  );
  expect(await page.locator('#logout').isHidden()).toBe(true);
  expect(await page.locator('.badge').isVisible()).toBe(true);
  expect(await page.locator('#access-status').textContent()).toContain(
    'Authentication required',
  );
  const saved = await page.evaluate(() =>
    JSON.parse(localStorage.getItem('fleet-simulation-command-v1') || 'null'),
  );
  if (saved) {
    expect(saved.id).toMatch(/^[a-f0-9]{64}$/);
    expect(saved).not.toHaveProperty('results');
    expect(saved).not.toHaveProperty('selected');
  }
}
async function signIn(page: Page, secret: string) {
  await page.waitForSelector('#login-panel:not([hidden])');
  await page.locator('#login-secret').fill(secret);
  await page.locator('#login-form button').click();
  await page.waitForFunction(() =>
    document.getElementById('connection')?.textContent?.includes('reachable'),
  );
  // Reachability can render while refresh is still recovering command status.
  // Wait for the authenticated view, rather than assert during that transition.
  await page.waitForSelector('#logout:not([hidden])');
}
async function enter(page: Page) {
  await page.locator('#preview').click();
  await page.waitForFunction(
    () => !document.getElementById('long')?.hasAttribute('disabled'),
  );
  await page.locator('#long').click();
  await page.locator('#confirm-submit').click();
}
async function complete(page: Page) {
  await page.waitForFunction(() =>
    document
      .getElementById('command-status')
      ?.textContent?.includes('COMPLETE'),
  );
}
async function close(app: Awaited<ReturnType<typeof createDashboard>>) {
  // The host lifecycle drains accepted work and connections before releasing its runtime lock.
  await app.close();
}

describe('private HTTPS phone workflow (Chromium emulation, isolated test certificate)', () => {
  it('authenticates, protects one intent through lost response/reload/disconnect, cleans up and revokes sessions', async () => {
    const host = await privateHost();
    const port = await availablePort();
    const origin = `https://localhost:${port}`;
    const accessConfig = { ...host.config, origin, port };
    // Durable I/O and browser timers remain real; only synthetic evidence time is fixed.
    const domainNow = Date.now();
    const domainClock = { now: () => domainNow };
    const access = new PrivateAccess(accessConfig, host.tls);
    const app = await createDashboard(
      config,
      host.directory,
      false,
      access,
      domainClock,
    );
    await new Promise<void>((resolve) =>
      app.server.listen(port, '127.0.0.1', resolve),
    );
    const context = await browser.newContext({
      ignoreHTTPSErrors: true,
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
    });
    const page = await context.newPage();
    await page.clock.setFixedTime(domainNow);
    try {
      const unauthenticated = await context.request.get(`${origin}/api/state`);
      expect(unauthenticated.status()).toBe(401);
      expect(await unauthenticated.json()).toEqual({
        error: 'AUTHENTICATION_REQUIRED',
      });
      await page.goto(origin);
      await page.waitForSelector('#login-panel:not([hidden])');
      await page.locator('#login-secret').fill(host.secret.slice(0, 12));
      await page.waitForTimeout(2300);
      expect(await page.locator('#login-secret').inputValue()).toBe(
        host.secret.slice(0, 12),
      );
      await signIn(page, host.secret);
      const session = await (
        await context.request.get(`${origin}/api/state`)
      ).json();
      expect(session.mode).toBe('SIMULATION_ONLY');
      expect(session.identity).toMatchObject({
        ownerId: host.config.ownerId,
        instanceId: host.config.instanceId,
        authenticated: true,
      });
      const cookie = (await context.cookies()).find(
        (c) => c.name === '__Host-vfc',
      );
      expect(cookie).toMatchObject({
        secure: true,
        httpOnly: true,
        sameSite: 'Strict',
        path: '/',
      });
      expect(await page.locator('#logout').isVisible()).toBe(true);
      let entryPosts = 0;
      context.on('request', (request) => {
        if (request.url().endsWith('/api/execute')) entryPosts++;
      });
      await page.route('**/api/execute', async (route) => {
        await route.fetch(); // The host accepts and protects the job; only its response is lost.
        await route.abort('failed');
      });
      await enter(page);
      await complete(page);
      reportExecution('lost-response');
      await page.reload();
      await complete(page);
      await context.setOffline(true);
      await page.waitForFunction(() =>
        document
          .getElementById('connection')
          ?.textContent?.includes('unreachable'),
      );
      expect(await page.locator('#long').isDisabled()).toBe(true);
      expect(await page.locator('#flatten').isEnabled()).toBe(true);
      await context.setOffline(false);
      await page.waitForFunction(() =>
        document
          .getElementById('connection')
          ?.textContent?.includes('reachable'),
      );
      await complete(page);
      const protectedState = await (
        await context.request.get(`${origin}/api/state`)
      ).json();
      expect(
        protectedState.commands.filter(
          (c: { status: string }) => c.status === 'COMPLETE',
        ),
      ).toHaveLength(1);
      expect(
        protectedState.accounts.every(
          (a: { positions: { protectionStatus: string }[] }) =>
            a.positions.length === 1 &&
            a.positions[0]!.protectionStatus === 'ACTIVE',
        ),
        JSON.stringify({
          halted: protectedState.halted,
          health: protectedState.health,
          results: protectedState.commands.map(
            (command: { results: unknown }) => command.results,
          ),
        }),
      ).toBe(true);
      expect(entryPosts).toBe(1);
      if (process.env.CAPTURE_MOBILE_EVIDENCE === '1') {
        await mkdir('docs/images', { recursive: true });
        await page.evaluate(() => window.scrollTo(0, 0));
        await page.screenshot({
          path: 'docs/images/mobile-private-trade.png',
        });
        await page.locator('[data-screen="accounts"]').click();
        expect(await page.locator('#accounts').textContent()).toContain(
          'PROTECTED',
        );
        await page.evaluate(() => {
          const panel = document.querySelector('.fleet')!;
          const header = document.querySelector('header')!;
          window.scrollTo(
            0,
            panel.getBoundingClientRect().top +
              window.scrollY -
              header.getBoundingClientRect().height -
              12,
          );
        });
        await page.screenshot({
          path: 'docs/images/mobile-private-accounts.png',
        });
      } else {
        await page.locator('[data-screen="accounts"]').click();
        expect(await page.locator('#accounts').textContent()).toContain(
          'PROTECTED',
        );
      }
      await page.locator('#flatten').click();
      await page.waitForFunction(() =>
        document.getElementById('circuit')?.textContent?.includes('HALTED'),
      );
      await page.locator('[data-screen="activity"]').click();
      await page.locator('#reconcile').click();
      await page.waitForFunction(() =>
        document
          .getElementById('message')
          ?.textContent?.includes('Reconciliation: HALTED'),
      );
      const cleaned = await (
        await context.request.get(`${origin}/api/state`)
      ).json();
      expect(cleaned.halted).toBe(true);
      expect(
        cleaned.accounts.every(
          (a: { positions: unknown[] }) => !a.positions.length,
        ),
      ).toBe(true);
      const secondPhone = await browser.newContext({
        ignoreHTTPSErrors: true,
        viewport: { width: 390, height: 844 },
        isMobile: true,
        hasTouch: true,
      });
      try {
        const second = await secondPhone.newPage();
        await second.clock.setFixedTime(domainNow);
        await second.goto(origin);
        await signIn(second, host.secret);
        expect(
          (await secondPhone.request.get(`${origin}/api/state`)).status(),
        ).toBe(200);
        const preservedId = await page.evaluate(
          () =>
            JSON.parse(localStorage.getItem('fleet-simulation-command-v1')!).id,
        );
        await page.locator('#logout').click();
        await privateViewCleared(page, host.config);
        expect(
          await page.evaluate(
            () =>
              JSON.parse(localStorage.getItem('fleet-simulation-command-v1')!)
                .id,
          ),
        ).toBe(preservedId);
        expect(
          (await context.request.get(`${origin}/api/state`)).status(),
        ).toBe(401);
        expect(
          (await secondPhone.request.get(`${origin}/api/state`)).status(),
        ).toBe(200);
        const revoked = await second.evaluate(async () => {
          const state = await (await fetch('/api/state')).json();
          return (
            await fetch('/api/revoke-sessions', {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'X-Session-Token': state.token,
              },
              body: '{}',
            })
          ).status;
        });
        expect(revoked).toBe(200);
        expect(
          (await secondPhone.request.get(`${origin}/api/state`)).status(),
        ).toBe(401);
        await second.waitForSelector('#login-panel:not([hidden])');
        await privateViewCleared(second, host.config);
      } finally {
        await secondPhone.close();
      }
    } finally {
      await context.close();
      await close(app);
      await host.dispose();
    }
  }, 60000);

  it('expires access, rejects prior sessions on host restart and retains protected positions with entries HALTED', async () => {
    const host = await privateHost();
    const port = await availablePort();
    const origin = `https://localhost:${port}`;
    const accessConfig = { ...host.config, origin, port };
    // Durable I/O and browser timers remain real; only synthetic evidence time is fixed.
    const domainNow = Date.now();
    const domainClock = { now: () => domainNow };
    let elapsed = 0;
    const access = new PrivateAccess(accessConfig, host.tls, {
      now: () => Date.now() + elapsed,
      sessionDurationMs: 60000,
    });
    let app = await createDashboard(
      config,
      host.directory,
      false,
      access,
      domainClock,
    );
    await new Promise<void>((resolve) =>
      app.server.listen(port, '127.0.0.1', resolve),
    );
    const context = await browser.newContext({
      ignoreHTTPSErrors: true,
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
    });
    const page = await context.newPage();
    await page.clock.setFixedTime(domainNow);
    let releaseForeground: (() => void) | undefined;
    try {
      await page.goto(origin);
      await signIn(page, host.secret);
      await enter(page);
      await complete(page);
      reportExecution('restart');
      let started!: () => void, release!: () => void;
      let routeFailure: unknown;
      const requestStarted = new Promise<void>((resolve) => {
        started = resolve;
      });
      const released = new Promise<void>((resolve) => {
        release = resolve;
        releaseForeground = resolve;
      });
      await page.route('**/api/state', async (route) => {
        started();
        try {
          await released;
          const response = await route.fetch();
          await route.fulfill({ response });
        } catch (error) {
          // Re-throw only after every interception has finished, avoiding detached handler failures.
          routeFailure = error;
        }
      });
      await page.evaluate(() => window.dispatchEvent(new Event('pageshow')));
      let deadline: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          requestStarted,
          new Promise<never>((_, reject) => {
            deadline = setTimeout(
              () =>
                reject(new Error('Foreground authorization GET never started')),
              10000,
            );
          }),
        ]);
      } finally {
        clearTimeout(deadline);
      }
      try {
        expect(await page.locator('#simulation-workspace').isHidden()).toBe(
          true,
        );
        expect(await page.locator('#accounts').textContent()).toBe('');
        expect(await page.locator('#instance').textContent()).not.toContain(
          host.config.ownerId,
        );
        expect(await page.locator('#access-status').isVisible()).toBe(true);
      } finally {
        release();
        await page.unrouteAll({ behavior: 'wait' });
      }
      if (routeFailure) throw routeFailure;
      await page.waitForFunction(
        () =>
          !document
            .getElementById('simulation-workspace')
            ?.hasAttribute('hidden'),
      );
      await complete(page);
      elapsed = 61000;
      expect((await context.request.get(`${origin}/api/state`)).status()).toBe(
        401,
      );
      await privateViewCleared(page, host.config);
      expect(await page.locator('#long').isDisabled()).toBe(true);
      await signIn(page, host.secret);
      await complete(page);
      const before = await (
        await context.request.get(`${origin}/api/state`)
      ).json();
      const existingCommand = before.commands.find(
        (c: { status: string }) => c.status === 'COMPLETE',
      );
      expect(existingCommand).toBeDefined();
      await close(app);
      app = await createDashboard(
        config,
        host.directory,
        false,
        new PrivateAccess(accessConfig, host.tls),
        domainClock,
      );
      await new Promise<void>((resolve) =>
        app.server.listen(port, '127.0.0.1', resolve),
      );
      expect((await context.request.get(`${origin}/api/state`)).status()).toBe(
        401,
      );
      await page.reload();
      await signIn(page, host.secret);
      await complete(page);
      const restored = await (
        await context.request.get(`${origin}/api/state`)
      ).json();
      expect(restored.halted).toBe(true);
      expect(restored.health.state).toBe('HALTED');
      expect(
        restored.commands.filter(
          (c: { status: string }) => c.status === 'COMPLETE',
        ),
      ).toHaveLength(1);
      expect(restored.commands[0].id).toBe(existingCommand.id);
      expect(
        restored.accounts.every(
          (a: { positions: { protectionStatus: string }[] }) =>
            a.positions.length === 1 &&
            a.positions[0]!.protectionStatus === 'ACTIVE',
        ),
      ).toBe(true);
      expect(await page.locator('#long').isDisabled()).toBe(true);
      await page.locator('[data-screen="activity"]').click();
      await page.locator('#reconcile').click();
      await page.waitForFunction(() =>
        document
          .getElementById('message')
          ?.textContent?.includes('Reconciliation: HALTED'),
      );
      expect(
        (await (await context.request.get(`${origin}/api/state`)).json())
          .halted,
      ).toBe(true);
      expect(await page.locator('#flatten').isEnabled()).toBe(true);
    } finally {
      releaseForeground?.();
      await page.unrouteAll({ behavior: 'wait' });
      await context.close();
      await close(app);
      await host.dispose();
    }
  }, 60000);
});
