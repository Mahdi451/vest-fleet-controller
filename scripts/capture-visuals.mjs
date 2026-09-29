// Documentation-only browser dependency; not needed to run the dashboard.
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'yaml';
import { riskConfigSchema } from '../packages/core/src/index.ts';
import { createDashboard } from '../apps/dashboard/server.ts';

const require = createRequire(import.meta.url);
const { chromium } = require(
  process.env.PLAYWRIGHT_MODULE_PATH || 'playwright',
);
const config = riskConfigSchema.parse(
  parse(readFileSync('config/example.yaml', 'utf8')),
);
const app = await createDashboard(config);
await new Promise((done) => app.server.listen(0, '127.0.0.1', done));
const url = `http://127.0.0.1:${app.server.address().port}`;
const browser = await chromium.launch({
  headless: true,
  ...(process.env.DOCS_CHROMIUM_PATH
    ? { executablePath: process.env.DOCS_CHROMIUM_PATH }
    : {}),
  args: ['--no-sandbox', '--disable-gpu'],
});
const page = await browser.newPage({
  viewport: { width: 1512, height: 1120 },
  deviceScaleFactor: 1,
});
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
page.on('dialog', (dialog) => dialog.accept());
const capture = async (name) =>
  page.screenshot({ path: resolve(`docs/images/${name}.png`), fullPage: true });
try {
  await page.goto(url);
  await page.waitForFunction(
    () => document.querySelectorAll('#accounts tr').length === 10,
  );
  await page.locator('#preview').click();
  await page.waitForFunction(() =>
    document
      .querySelector('#message')
      .textContent.includes('10/10 accounts approved'),
  );
  await capture('dashboard-preview');
  // Re-preview immediately before entry to respect the real five-second expiry.
  await page.locator('#preview').click();
  await page.locator('#long').click();
  await page.waitForFunction(() =>
    document.querySelector('#message').textContent.includes('10 PROTECTED'),
  );
  if (
    (await page
      .locator('#accounts')
      .getByText('Protection ACTIVE', { exact: false })
      .count()) !== 10
  )
    throw new Error('Expected ten protected positions');
  await capture('dashboard-positions');
  await page.setViewportSize({ width: 390, height: 844 });
  await capture('dashboard-mobile');
  if (
    await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)
  )
    throw new Error('Mobile page overflow');
  await page.setViewportSize({ width: 1512, height: 1120 });
  await page.locator('#flatten').click();
  await page.waitForFunction(() =>
    document.querySelector('#message').textContent.includes('Entries halted'),
  );
  await page.locator('#reset').click();
  await page.waitForFunction(() =>
    document.querySelector('#positions').textContent.startsWith('0 /'),
  );
  await page.locator('[data-leverage="50"]').click();
  await page.waitForFunction(() =>
    document
      .querySelector('#message')
      .textContent.includes('0/10 accounts approved'),
  );
  await capture('dashboard-risk-rejection');
  if (errors.length) throw new Error(errors.join('\n'));
  const diagram = await browser.newPage({
    viewport: { width: 1500, height: 1100 },
  });
  await diagram.setContent(
    `<body style="margin:0">${readFileSync('docs/images/execution-flow.svg', 'utf8')}</body>`,
  );
  await diagram.screenshot({ path: resolve('docs/images/execution-flow.png') });
  console.log(
    'Captured four application screenshots and execution diagram. No browser errors or mobile page overflow.',
  );
} finally {
  await browser.close();
  await new Promise((done) => app.server.close(done));
  await app.close();
}
