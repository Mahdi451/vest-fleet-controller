import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  chromium,
  type Browser,
  type BrowserContext,
  type Page,
} from 'playwright';
import { createDashboard } from '../apps/dashboard/server.ts';
import { config } from './helpers.ts';

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
async function fixture(
  run: (page: Page, context: BrowserContext, base: string) => Promise<void>,
  options = {},
) {
  const app = await createDashboard({
    ...config,
    maxDataAgeMs: 60000,
    maxPreviewAgeMs: 60000,
    ...options,
  });
  await new Promise<void>((resolve) =>
    app.server.listen(0, '127.0.0.1', resolve),
  );
  const address = app.server.address();
  if (!address || typeof address === 'string') throw new Error('NO_ADDRESS');
  const base = `http://127.0.0.1:${address.port}`;
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });
  const page = await context.newPage();
  try {
    await page.goto(base);
    await page.waitForFunction(() =>
      document.getElementById('connection')?.textContent?.includes('reachable'),
    );
    await run(page, context, base);
  } finally {
    await page.unrouteAll({ behavior: 'wait' });
    await context.close();
    await new Promise<void>((resolve) => app.server.close(() => resolve()));
    await app.close();
  }
}
async function prepare(page: Page) {
  await page.locator('#preview').click();
  await page.waitForFunction(
    () => !document.getElementById('long')?.hasAttribute('disabled'),
  );
}
async function execute(page: Page) {
  await prepare(page);
  await page.locator('#long').click();
  await page.locator('#confirm-submit').click();
}
async function completed(page: Page) {
  await page.waitForFunction(() =>
    document
      .getElementById('command-status')
      ?.textContent?.includes('COMPLETE'),
  );
}
const test = (
  name: string,
  fn: (page: Page, context: BrowserContext, base: string) => Promise<void>,
  options = {},
) => it(name, () => fixture(fn, options), 60000);

describe('phone simulation dashboard acceptance (Chromium emulation)', () => {
  test('Trade, Accounts and Activity fit phone widths and landscape with visible simulation labeling', async (page) => {
    for (const [width, height] of [
      [320, 740],
      [360, 800],
      [375, 812],
      [390, 844],
      [430, 932],
      [844, 390],
    ]) {
      await page.setViewportSize({ width: width!, height: height! });
      for (const screen of ['trade', 'accounts', 'activity']) {
        if (width! <= 700)
          await page.locator(`[data-screen="${screen}"]`).click();
        expect(await page.locator('.badge').isVisible()).toBe(true);
        expect(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= window.innerWidth,
          ),
        ).toBe(true);
        expect(await page.locator('#flatten').isVisible()).toBe(true);
      }
    }
    await page.setViewportSize({ width: 320, height: 740 });
    await page.locator('[data-screen="accounts"]').click();
    expect(await page.locator('#accounts tr').count()).toBe(10);
    expect(
      await page
        .locator('#accounts td[data-label="Equity / floor"]')
        .first()
        .isVisible(),
    ).toBe(true);
    await page.locator('[data-screen="trade"]').click();
    const box = await page.locator('#long').boundingBox();
    expect(box!.height).toBeGreaterThanOrEqual(44);
  });
  test('manifest, branded icons and no service worker mutation delivery queue', async (page, context, base) => {
    const response = await context.request.get(`${base}/manifest.webmanifest`);
    expect(response.status()).toBe(200);
    const manifest = await response.json();
    expect(manifest.name).toContain('SIMULATION');
    expect(manifest.display).toBe('standalone');
    expect(manifest.scope).toBe('/');
    expect(manifest.start_url).toBe('/');
    for (const icon of manifest.icons)
      expect((await context.request.get(`${base}${icon.src}`)).status()).toBe(
        200,
      );
    expect(
      (
        await context.request.get(`${base}/brand/apple-touch-icon.png`)
      ).status(),
    ).toBe(200);
    expect(
      await page.evaluate(
        async () => (await navigator.serviceWorker.getRegistrations()).length,
      ),
    ).toBe(0);
  });
  test('offline blocks entry and reconnect only queries state without replaying mutations', async (page, context) => {
    await prepare(page);
    let writes = 0;
    page.on('request', (r) => {
      if (r.url().endsWith('/api/execute')) writes++;
    });
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
      document.getElementById('connection')?.textContent?.includes('reachable'),
    );
    expect(writes).toBe(0);
    expect(await page.locator('#long').isDisabled()).toBe(true);
  });
  test('reachable controller with stale evidence disables entries but keeps flatten and reconciliation available', async (page) => {
    await prepare(page);
    await page.route('**/api/state', async (route) => {
      const response = await route.fetch();
      const state = await response.json();
      state.freshness = { ...state.freshness, fresh: false, ageMs: 70000 };
      await route.fulfill({ response, json: state });
    });
    await page.waitForFunction(() =>
      document.getElementById('freshness')?.textContent?.includes('STALE'),
    );
    expect(await page.locator('#long').isDisabled()).toBe(true);
    expect(await page.locator('#flatten').isEnabled()).toBe(true);
    await page.locator('[data-screen="activity"]').click();
    expect(await page.locator('#reconcile').isEnabled()).toBe(true);
  });
  test(
    'preview expiry blocks confirmation',
    async (page) => {
      await prepare(page);
      await page.waitForFunction(
        () => document.getElementById('long')?.hasAttribute('disabled'),
        undefined,
        { timeout: 5000 },
      );
      expect(await page.locator('#expiry').textContent()).toContain('expired');
    },
    { maxPreviewAgeMs: 900 },
  );
  test('confirmation and double tap produce only one accepted command with protected positions', async (page, context, base) => {
    let writes = 0;
    page.on('request', (r) => {
      if (r.url().endsWith('/api/execute')) writes++;
    });
    await prepare(page);
    await page.locator('#long').click();
    expect(writes).toBe(0);
    await page.locator('#confirm-submit').evaluate((b) => {
      (b as HTMLButtonElement).click();
      (b as HTMLButtonElement).click();
    });
    await completed(page);
    expect(writes).toBe(1);
    const state = await (await context.request.get(`${base}/api/state`)).json();
    expect(
      state.accounts.every(
        (a: { positions: unknown[] }) => a.positions.length === 1,
      ),
    ).toBe(true);
    expect(
      state.commands.filter((c: { status: string }) => c.status === 'COMPLETE'),
    ).toHaveLength(1);
    await page.locator('[data-screen="accounts"]').click();
    expect(await page.locator('#accounts').textContent()).toContain(
      'PROTECTED',
    );
    await page.locator('#flatten').click();
    await page.waitForFunction(() =>
      document.getElementById('circuit')?.textContent?.includes('HALTED'),
    );
  });
  test('lost accepted response recovers existing status across reload and a second tab without resubmission', async (page, context, base) => {
    let writes = 0;
    context.on('request', (r) => {
      if (r.url().endsWith('/api/execute')) writes++;
    });
    await page.route('**/api/execute', async (route) => {
      await route.fetch();
      await route.abort('failed');
    });
    await execute(page);
    await completed(page);
    await page.reload();
    await completed(page);
    const second = await context.newPage();
    await second.goto(base);
    await completed(second);
    expect(writes).toBe(1);
    const state = await (await context.request.get(`${base}/api/state`)).json();
    expect(
      state.commands.filter((c: { status: string }) => c.status === 'COMPLETE'),
    ).toHaveLength(1);
  });
  test('reload while request is in transit retains uncertainty even when status still says PREVIEWED', async (page, context) => {
    let writes = 0;
    context.on('request', (r) => {
      if (r.url().endsWith('/api/execute')) writes++;
    });
    await page.route('**/api/execute', async (route) => {
      await route.abort('failed');
    });
    await execute(page);
    await page.waitForFunction(() =>
      document
        .getElementById('command-status')
        ?.textContent?.includes('UNKNOWN'),
    );
    await page.reload();
    await page.waitForFunction(() =>
      document
        .getElementById('command-status')
        ?.textContent?.includes('UNKNOWN'),
    );
    expect(await page.locator('#preview').isDisabled()).toBe(true);
    expect(await page.locator('#long').isDisabled()).toBe(true);
    expect(writes).toBe(1);
  });
  test('unknown host outcome stays visibly unknown with unsafe entry blocked and cleanup reachable', async (page) => {
    let executeFinished!: () => void, statusFinished!: () => void;
    const executeHandled = new Promise<void>((resolve) => {
      executeFinished = resolve;
    });
    const statusHandled = new Promise<void>((resolve) => {
      statusFinished = resolve;
    });
    await page.route('**/api/execute', async (route) => {
      const response = await route.fetch();
      const result = await response.json();
      result.command.status = 'UNKNOWN';
      await route.fulfill({ response, json: result });
      executeFinished();
    });
    await page.route('**/api/commands/*', async (route) => {
      const response = await route.fetch();
      const result = await response.json();
      result.command.status = 'UNKNOWN';
      await route.fulfill({ response, json: result });
      statusFinished();
    });
    await execute(page);
    await Promise.all([executeHandled, statusHandled]);
    await page.waitForFunction(() =>
      document
        .getElementById('command-status')
        ?.textContent?.includes('UNKNOWN'),
    );
    expect(await page.locator('#long').isDisabled()).toBe(true);
    expect(await page.locator('#preview').isDisabled()).toBe(true);
    expect(await page.locator('#flatten').isEnabled()).toBe(true);
  });
  test('storage failure blocks execution before any mutation', async (page) => {
    let writes = 0;
    page.on('request', (r) => {
      if (r.url().endsWith('/api/execute')) writes++;
    });
    await page.evaluate(() => {
      Storage.prototype.setItem = () => {
        throw new Error('Storage unavailable');
      };
    });
    await execute(page);
    await page.waitForFunction(() =>
      document
        .getElementById('message')
        ?.textContent?.includes('Storage unavailable'),
    );
    expect(writes).toBe(0);
    expect(await page.locator('#long').isDisabled()).toBe(true);
  });
  test('pending status propagates to a second tab and prevents a second intent', async (page, context, base) => {
    const other = await context.newPage();
    await other.goto(base);
    await prepare(other);
    await page.route('**/api/execute', async (route) => {
      await route.abort('failed');
    });
    await execute(page);
    await other.waitForFunction(() =>
      document
        .getElementById('command-status')
        ?.textContent?.includes('UNKNOWN'),
    );
    expect(await other.locator('#long').isDisabled()).toBe(true);
    expect(await other.locator('#preview').isDisabled()).toBe(true);
  });
  test(
    'an unaccepted lost request blocks until an authoritative expired status permits a fresh preview',
    async (page) => {
      await page.route('**/api/execute', async (route) => {
        await route.abort('failed');
      });
      await execute(page);
      await page.waitForFunction(() =>
        document
          .getElementById('command-status')
          ?.textContent?.includes('UNKNOWN'),
      );
      expect(await page.locator('#preview').isDisabled()).toBe(true);
      await page.waitForFunction(
        () => !document.getElementById('preview')?.hasAttribute('disabled'),
        undefined,
        { timeout: 8000 },
      );
      await prepare(page);
    },
    { maxPreviewAgeMs: 2500 },
  );
  test('foreign owner or instance storage records never become current command identity', async (page) => {
    await page.evaluate(() =>
      localStorage.setItem(
        'fleet-simulation-command-v1',
        JSON.stringify({
          id: 'a'.repeat(64),
          ownerId: 'other-owner',
          instanceId: 'other-instance',
          status: 'PENDING',
          expiresAt: Date.now() + 60000,
        }),
      ),
    );
    await page.reload();
    await prepare(page);
    expect(await page.locator('#command-status').textContent()).not.toContain(
      'aaaaaaaa',
    );
    expect(await page.locator('#long').isEnabled()).toBe(true);
  });
});
