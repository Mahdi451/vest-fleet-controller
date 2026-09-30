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
  await page.locator('.brand img').evaluate(async (img) => {
    await img.decode();
    if (!img.naturalWidth) throw new Error('Header logo failed to load');
  });
  const favicon = await page.request.get(`${url}/brand/favicon.svg`);
  if (
    !favicon.ok() ||
    !favicon.headers()['content-type'].includes('image/svg+xml')
  )
    throw new Error('Favicon not served as SVG');
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
  const brand = await browser.newPage({
    viewport: { width: 1100, height: 640 },
  });
  const asset = (name) =>
    readFileSync(`apps/dashboard/public/brand/${name}.svg`, 'utf8');
  await brand.setContent(`<!doctype html><html><head><style>
    *{box-sizing:border-box}body{margin:0;padding:48px;background:#0b1118;color:#edf4f8;font:16px system-ui,sans-serif}
    h1{font-size:30px;margin:8px 0 12px;letter-spacing:-1px}p{color:#91a0b3;margin:0 0 32px}.eyebrow{color:#19ddb5;font-size:12px;letter-spacing:3px}
    .grid{display:grid;grid-template-columns:1fr 1fr 1fr;gap:20px}.card{background:#121c27;border:1px solid #283545;border-radius:16px;padding:26px}
    h2{font-size:16px;margin:24px 0 10px}.stage{height:154px;display:flex;align-items:center;justify-content:center;gap:20px}
    .stage>svg{width:164px;height:110px}.light{background:#f2f5f7;border-radius:9px;color:#0b1118}.sizes{align-items:center}
    .sizes div{text-align:center;color:#91a0b3;font-size:12px}.sizes svg{display:block;margin:0 auto 12px}.sizes div:nth-child(1) svg{width:16px;height:16px}.sizes div:nth-child(2) svg{width:24px;height:24px}.sizes div:nth-child(3) svg{width:32px;height:32px}
    .card p{font-size:14px;line-height:1.6;margin:0}footer{margin-top:30px;color:#91a0b3;font-size:13px}
  </style></head><body><div class="eyebrow">VEST FLEET CONTROLLER</div><h1>One identity. Sized for the job.</h1><p>Editable vector assets derived from the approved fleet / F concept.</p><div class="grid">
    <div class="card"><div class="stage">${asset('mark')}</div><h2>Dashboard mark</h2><p>Mint, transparent background.<br>Full fleet motif for the header.</p></div>
    <div class="card"><div class="stage light">${asset('mark-mono')}</div><h2>Monochrome mark</h2><p>One color, transparent background.<br>For documents and single-color use.</p></div>
    <div class="card"><div class="stage sizes"><div>${asset('favicon')}16 px</div><div>${asset('favicon')}24 px</div><div>${asset('favicon')}32 px</div></div><h2>Browser favicon</h2><p>Simplified F on a dark tile.<br>Readable in light and dark tabs.</p></div>
  </div><footer>Independent fleet control · Original full logo remains in the README.</footer></body></html>`);
  await brand.screenshot({ path: resolve('docs/images/brand-variants.png') });
  console.log(
    'Captured four application screenshots, execution diagram and brand variants. Header logo and SVG favicon load. No browser errors or mobile page overflow.',
  );
} finally {
  await browser.close();
  await new Promise((done) => app.server.close(done));
  await app.close();
}
