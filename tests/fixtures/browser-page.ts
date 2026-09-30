import type { OrderResult } from '../../packages/execution/src/adapter.ts';
import type { Browser, Page } from 'playwright';
import { initialFleet } from '../../packages/core/src/index.ts';
import type {
  BrowserDom,
  BrowserAction,
  BrowserAccountIdentity,
  VisibleBook,
} from '../../packages/browser-execution/src/dom.ts';
import { MockVestAdapter } from '../../packages/simulator/src/index.ts';

/** Original synthetic DOM; not a copy of Vest, and not evidence about Vest's actual controls. */
export async function fixturePage(
  browser: Browser,
  mock: MockVestAdapter,
  contextId = 'fixture-context',
) {
  const context = await browser.newContext({ serviceWorkers: 'block' });
  // Local page only: no external network, cookies, persistent profile, CDP attachment or real login.
  await context.route('**/*', (route) => route.abort());
  const page = await context.newPage();
  const saved = mock.exportSnapshot();
  const entries = new Set(saved.orders.map((o) => o.result.requestId)),
    protections = new Map(
      saved.protection.map((p) => [p.order.orderId, p.order.accountId]),
    );
  const actions: BrowserAction[] = [];
  let selected = '01';
  const faults = {
    wrongSelection: false,
    switchAfterPrepare: false,
    stale: false,
    duplicateRows: false,
    omitEntry: false,
    omitProtection: false,
    lostResponse: false,
    stall: false,
    disconnect: false,
  };
  const book = async (): Promise<VisibleBook> => {
    const account = await mock.getAccountState(selected);
    const e = (
      await Promise.all([...entries].map((id) => mock.getOrder(id)))
    ).filter((v): v is OrderResult => v !== null && v.accountId === selected);
    const p = (
      await Promise.all(
        [...protections]
          .filter(([, id]) => id === selected)
          .map(([id]) => mock.getProtectionOrder(selected, id)),
      )
    ).filter((v) => v !== null);
    return {
      identity: { accountId: selected, label: account.label, contextId },
      observedAt: faults.stale ? 1 : Date.now(),
      account,
      inventory: await mock.listAccounts(),
      quote: await mock.getQuote(),
      entries: faults.omitEntry ? [] : faults.duplicateRows ? [...e, ...e] : e,
      protection: faults.omitProtection ? [] : p,
    };
  };
  await page.exposeFunction(
    'fixtureBridge',
    async (operation: string, value: string) => {
      if (faults.disconnect) throw new Error('FIXTURE_DISCONNECTED');
      if (operation === 'SELECT')
        selected = faults.wrongSelection ? '02' : value;
      if (operation === 'PREPARE' && faults.switchAfterPrepare) selected = '02';
      if (operation === 'SUBMIT') {
        const action: BrowserAction = JSON.parse(value);
        // Simulate an ordinary UI using its actual selected account, not trusting the requested account.
        actions.push(structuredClone(action));
        if (action.kind === 'ENTRY') {
          entries.add(action.order.requestId);
          await mock.placeOrder({ ...action.order, accountId: selected });
        } else if (action.kind === 'PROTECTION') {
          protections.set(action.order.requestId, selected);
          await mock.placeProtectionOrder({
            ...action.order,
            accountId: selected,
          });
        } else if (action.kind === 'CANCEL')
          await mock.cancelOrder(selected, action.orderId);
        else await mock.flattenAccount(selected);
        if (faults.lostResponse) {
          faults.lostResponse = false;
          throw new Error('FIXTURE_LOST_ACK');
        }
        if (faults.stall) await new Promise(() => {});
      }
      return { book: await book() };
    },
  );
  const options = initialFleet(Date.now())
    .map((a) => `<option value="${a.accountId}">${a.label}</option>`)
    .join('');
  await page.setContent(`<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'none'; form-action 'none'"></head><body>
    <h1>LOCAL FIXTURE ONLY — NO VEST CONNECTION</h1>
    <label for="account">Account</label><select id="account">${options}</select><button id="select">Select fixture account</button>
    <p>Original test UI. JSON fields expose the synthetic contract; these are not Vest selectors or real venue guarantees.</p>
    <label>Fixture command payload<textarea id="payload"></textarea></label>
    <button id="prepare">Prepare fixture command</button><button id="submit">Submit fixture command</button><button id="refresh">Refresh visible book</button>
    <output id="serial">0</output><p id="feedback"></p><pre id="book"></pre>
    <script>
    const book=document.querySelector('#book'), serial=document.querySelector('#serial'), feedback=document.querySelector('#feedback');
    async function run(op,value='') { feedback.textContent='Pending'; try { const r=await window.fixtureBridge(op,value);book.textContent=JSON.stringify(r.book);serial.textContent=Number(serial.textContent)+1;feedback.textContent='Complete';}catch{feedback.textContent='Error';serial.textContent=Number(serial.textContent)+1;} }
    document.querySelector('#select').onclick=()=>run('SELECT',document.querySelector('#account').value);
    document.querySelector('#prepare').onclick=()=>run('PREPARE');
    document.querySelector('#submit').onclick=()=>run('SUBMIT',document.querySelector('#payload').value);
    document.querySelector('#refresh').onclick=()=>run('READ');
    </script></body></html>`);
  const dom = new FixtureDom(page, contextId);
  await dom.click('Refresh visible book');
  return { dom, page, context, faults, actions, book };
}
class FixtureDom implements BrowserDom {
  readonly environment = 'LOCAL_FIXTURE' as const;
  constructor(
    private readonly page: Page,
    readonly contextId: string,
  ) {
    page.setDefaultTimeout(5000);
  }
  async assertLocalFixture() {
    if (
      this.page.url() !== 'about:blank' ||
      !(await this.page
        .getByRole('heading', {
          name: 'LOCAL FIXTURE ONLY — NO VEST CONNECTION',
          exact: true,
        })
        .isVisible())
    )
      throw new Error('NON_FIXTURE_BROWSER_TARGET');
  }
  async click(name: string) {
    await this.assertLocalFixture();
    const serial = await this.page.locator('#serial').innerText();
    await this.page.getByRole('button', { name, exact: true }).click();
    await this.page.waitForFunction(
      (old) => document.querySelector('#serial')!.textContent !== old,
      serial,
      { timeout: 5000 },
    );
    if ((await this.page.locator('#feedback').innerText()) !== 'Complete')
      throw new Error('FIXTURE_UNCERTAIN');
  }
  async selectAccount(identity: BrowserAccountIdentity) {
    await this.assertLocalFixture();
    await this.page
      .getByLabel('Account', { exact: true })
      .selectOption(identity.accountId);
    await this.click('Select fixture account');
  }
  async readBook() {
    await this.click('Refresh visible book');
    return JSON.parse(await this.page.locator('#book').innerText());
  }
  async prepare(action: BrowserAction) {
    await this.page
      .getByLabel('Fixture command payload', { exact: true })
      .fill(JSON.stringify(action));
    await this.click('Prepare fixture command');
  }
  async readPrepared(): Promise<BrowserAction> {
    return JSON.parse(
      await this.page
        .getByLabel('Fixture command payload', { exact: true })
        .inputValue(),
    );
  }
  async submitPrepared() {
    await this.click('Submit fixture command');
  }
  async quarantine() {
    await this.page.close();
  }
  async close() {
    await this.page.context().close();
  }
}
