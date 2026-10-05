import { afterAll, beforeAll, expect, it } from 'vitest';
import { chromium, type Browser } from 'playwright';
import {
  executeOneAccount,
  exitsFromFill,
  type ClickResult,
  type IntentLog,
  type LiveExit,
  type LivePosition,
  type OneAccountRequest,
  type OrderIntent,
  type VestExecutionPage,
} from '../packages/browser-execution/src/single-account.ts';
import { vestExecutionPage } from '../packages/browser-execution/src/vest-live-page.ts';

const now = 5_000;
const options = { now, maxHeaderAgeMs: 1_000 };

class MemoryLog implements IntentLog {
  readonly saved: OrderIntent[] = [];
  async save(intent: OrderIntent) {
    this.saved.push(intent);
  }
  async has(id: string) {
    return this.saved.some((intent) => intent.id === id);
  }
}

class ScriptedPage implements VestExecutionPage {
  pages = 1;
  session: 'AUTHENTICATED' | 'LOGIN_REQUIRED' | 'UNKNOWN' = 'AUTHENTICATED';
  account: string | null = 'Account 01';
  observedAt: number | null = now;
  accountAfterSwitch: string | null = null;
  accountClick: ClickResult = 'CLICKED';
  symbol: string | null = 'BTC-PERP';
  choices = ['1x', '2x', '5x', '15x'];
  leverage: string | null = null;
  leverageClick: ClickResult = 'CLICKED';
  percent: string | null = null;
  acceptPercent = true;
  allocationClick: ClickResult = 'CLICKED';
  orderValue: string | null = '8';
  amount: string | null = '8';
  buy = true;
  sell = true;
  marketOpen: boolean | null = true;
  blocking: string | null = null;
  ticker = '100';
  position: LivePosition | null = null;
  exits: readonly LiveExit[] | 'UNPARSED' = [];
  entryResult: ClickResult = 'CLICKED';
  revealOnUnknown = false;
  ambiguousPosition = false;
  fillPrice = '110';
  stopAppears = true;
  targetAppears = true;
  flattenClears = true;
  flattenResult: ClickResult = 'CLICKED';
  entryClicks = 0;
  accountClicks = 0;

  tradingPageCount() {
    return Promise.resolve(this.pages);
  }
  readSession() {
    return Promise.resolve(this.session);
  }
  readAccount() {
    return Promise.resolve({
      account: this.account,
      observedAt: this.observedAt,
    });
  }
  async chooseAccount() {
    this.accountClicks += 1;
    if (this.accountClick !== 'CLICKED') return this.accountClick;
    if (this.accountAfterSwitch) this.account = this.accountAfterSwitch;
    this.observedAt = now;
    return 'CLICKED' as const;
  }
  readSymbol() {
    return Promise.resolve(this.symbol);
  }
  readTicket() {
    return Promise.resolve({
      account: this.account,
      symbol: this.symbol,
      sideContext: null,
      leverageChoices: this.choices,
      selectedLeverage: this.leverage,
      allocationPercent: this.percent,
      orderValue: this.orderValue,
      amount: this.amount,
      buyEnabled: this.buy,
      sellEnabled: this.sell,
      marketOpen: this.marketOpen,
      blockingReason: this.blocking,
      tickerPrice: this.ticker,
    });
  }
  openLeverageMenu() {
    return Promise.resolve(this.choices);
  }
  async chooseLeverage(choice: string) {
    if (this.leverageClick !== 'CLICKED') return this.leverageClick;
    this.leverage = choice;
    return 'CLICKED' as const;
  }
  async chooseAllocation(percent: string) {
    if (this.allocationClick !== 'CLICKED') return this.allocationClick;
    if (this.acceptPercent) this.percent = percent;
    return 'CLICKED' as const;
  }
  async submitEntry(side: 'LONG' | 'SHORT') {
    this.entryClicks += 1;
    if (this.entryResult === 'CLICKED' || this.revealOnUnknown) {
      this.position = {
        account: this.account,
        symbol: this.symbol,
        side,
        size: '1',
        averageEntry: this.ambiguousPosition ? null : this.fillPrice,
        unparsed: this.ambiguousPosition,
      };
    }
    return this.entryResult;
  }
  readPosition() {
    return Promise.resolve(this.position);
  }
  readWorkingExits() {
    return Promise.resolve(this.exits);
  }
  async placeExit(kind: 'STOP' | 'TARGET', price: string) {
    const appears = kind === 'STOP' ? this.stopAppears : this.targetAppears;
    if (!appears || this.exits === 'UNPARSED') return 'CLICKED' as const;
    this.exits = [
      ...this.exits,
      {
        kind,
        price,
        account: this.account,
        symbol: this.symbol,
      },
    ];
    return 'CLICKED' as const;
  }
  async submitFlatten() {
    if (this.flattenResult === 'CLICKED' && this.flattenClears) {
      this.position = null;
      this.exits = [];
    }
    return this.flattenResult;
  }
}

function request(patch: Partial<OneAccountRequest> = {}): OneAccountRequest {
  return {
    id: 'intent-1',
    runId: 'run-1',
    account: 'Account 01',
    symbol: 'BTC-PERP',
    action: 'LONG',
    leverage: '2',
    allocationPercent: '25',
    maxOrderValue: '10',
    stopDistance: '1',
    targetDistance: '2',
    ...patch,
  };
}

it('protects from the read fill rather than the pre-click ticker', async () => {
  const page = new ScriptedPage();
  const result = await executeOneAccount(
    page,
    request(),
    new MemoryLog(),
    options,
  );
  expect(result).toMatchObject({
    state: 'OPEN_PROTECTED',
    haltFleet: false,
    code: null,
    fill: '110',
    stop: '109',
    target: '112',
    entrySubmissions: 1,
    reconciliation: 'ENTRY_CONFIRMED',
  });
  expect(page.ticker).toBe('100');
  expect(result.intent?.observedOrderValue).toBe('8');
  expect(exitsFromFill('LONG', '100', '1', '2').stop).toBe('99');
});

it('halts when another Vest page is open or the session is gone', async () => {
  const competing = new ScriptedPage();
  competing.pages = 2;
  expect(
    (await executeOneAccount(competing, request(), new MemoryLog(), options))
      .code,
  ).toBe('COMPETING_PAGE');
  const signedOut = new ScriptedPage();
  signedOut.session = 'LOGIN_REQUIRED';
  const lost = await executeOneAccount(
    signedOut,
    request(),
    new MemoryLog(),
    options,
  );
  expect(lost).toMatchObject({ code: 'LOGIN_LOSS', entrySubmissions: 0 });
  expect(signedOut.entryClicks).toBe(0);
});

it('refuses a stale header and a switch that does not show the requested account', async () => {
  const stale = new ScriptedPage();
  stale.observedAt = now - 1_001;
  expect(
    (await executeOneAccount(stale, request(), new MemoryLog(), options)).code,
  ).toBe('STALE_ACCOUNT');
  expect(stale.accountClicks).toBe(0);
  const wrong = new ScriptedPage();
  wrong.account = 'Account 02';
  wrong.accountAfterSwitch = 'Account 02';
  const result = await executeOneAccount(
    wrong,
    request(),
    new MemoryLog(),
    options,
  );
  expect(result.code).toBe('ACCOUNT_MISMATCH');
  expect(wrong.entryClicks).toBe(0);
  expect(wrong.accountClicks).toBe(1);
});

it('refuses leverage the open menu does not offer', async () => {
  const page = new ScriptedPage();
  page.leverage = '15';
  page.choices = ['1x', '2x', '5x'];
  const result = await executeOneAccount(
    page,
    request({ leverage: '15' }),
    new MemoryLog(),
    options,
  );
  expect(result.code).toBe('LEVERAGE_UNAVAILABLE');
  expect(page.entryClicks).toBe(0);
  expect(page.leverage).toBe('15');
});

it('refuses a percent or order value the ticket does not accept', async () => {
  const ignored = new ScriptedPage();
  ignored.acceptPercent = false;
  expect(
    (await executeOneAccount(ignored, request(), new MemoryLog(), options))
      .code,
  ).toBe('ALLOCATION_REJECTED');
  const capped = new ScriptedPage();
  capped.orderValue = '20';
  expect(
    (await executeOneAccount(capped, request(), new MemoryLog(), options)).code,
  ).toBe('ORDER_VALUE_CAP');
  expect(capped.entryClicks).toBe(0);
});

it('does not click Buy or Sell when the button is disabled or the market is closed', async () => {
  const disabled = new ScriptedPage();
  disabled.buy = false;
  expect(
    (await executeOneAccount(disabled, request(), new MemoryLog(), options))
      .code,
  ).toBe('ENTRY_DISABLED');
  const closed = new ScriptedPage();
  closed.marketOpen = false;
  expect(
    (await executeOneAccount(closed, request(), new MemoryLog(), options)).code,
  ).toBe('MARKET_CLOSED');
  expect(disabled.entryClicks + closed.entryClicks).toBe(0);
});

it('fails closed when the symbol or the position evidence is ambiguous', async () => {
  const wrongSymbol = new ScriptedPage();
  wrongSymbol.symbol = 'ETH-PERP';
  expect(
    (await executeOneAccount(wrongSymbol, request(), new MemoryLog(), options))
      .code,
  ).toBe('SYMBOL_MISMATCH');
  const ambiguous = new ScriptedPage();
  ambiguous.entryResult = 'CLICK_UNKNOWN';
  ambiguous.revealOnUnknown = true;
  ambiguous.ambiguousPosition = true;
  const result = await executeOneAccount(
    ambiguous,
    request(),
    new MemoryLog(),
    options,
  );
  expect(result).toMatchObject({
    state: 'HALTED',
    code: 'AMBIGUOUS_ENTRY',
    reconciliation: 'AMBIGUOUS',
    haltFleet: true,
  });
  expect(ambiguous.entryClicks).toBe(1);
});

it('does not click a second time when the first entry result is unknown', async () => {
  const page = new ScriptedPage();
  page.entryResult = 'CLICK_UNKNOWN';
  const log = new MemoryLog();
  const first = await executeOneAccount(page, request(), log, options);
  expect(first).toMatchObject({
    state: 'ENTRY_UNKNOWN',
    code: 'ENTRY_UNKNOWN',
    reconciliation: 'NO_ENTRY_OBSERVED',
    entrySubmissions: 1,
    haltFleet: true,
  });
  const second = await executeOneAccount(page, request(), log, options);
  expect(second.code).toBe('DUPLICATE_INTENT');
  expect(page.entryClicks).toBe(1);
});

it('continues from a fill discovered after an ambiguous click and still uses that fill', async () => {
  const page = new ScriptedPage();
  page.entryResult = 'CLICK_UNKNOWN';
  page.revealOnUnknown = true;
  const result = await executeOneAccount(
    page,
    request(),
    new MemoryLog(),
    options,
  );
  expect(result).toMatchObject({
    state: 'OPEN_PROTECTED',
    fill: '110',
    stop: '109',
    entrySubmissions: 1,
  });
  expect(page.entryClicks).toBe(1);
});

it('halts the fleet when the read position has no verified stop or target', async () => {
  const naked = new ScriptedPage();
  naked.stopAppears = false;
  const missingStop = await executeOneAccount(
    naked,
    request(),
    new MemoryLog(),
    options,
  );
  expect(missingStop).toMatchObject({
    state: 'OPEN_UNPROTECTED',
    code: 'MISSING_STOP',
    haltFleet: true,
    fill: '110',
  });
  const oneSided = new ScriptedPage();
  oneSided.targetAppears = false;
  const missingTarget = await executeOneAccount(
    oneSided,
    request(),
    new MemoryLog(),
    options,
  );
  expect(missingTarget).toMatchObject({
    state: 'HALTED',
    code: 'MISSING_TARGET',
    haltFleet: true,
    stop: '109',
    target: null,
  });
});

it('does not report flat unless the page shows no position and no working exits', async () => {
  const page = new ScriptedPage();
  page.position = {
    account: 'Account 01',
    symbol: 'BTC-PERP',
    side: 'LONG',
    size: '1',
    averageEntry: '110',
    unparsed: false,
  };
  page.flattenClears = false;
  const result = await executeOneAccount(
    page,
    request({ action: 'FLATTEN' }),
    new MemoryLog(),
    options,
  );
  expect(result).toMatchObject({
    state: 'HALTED',
    code: 'FLATTEN_UNCONFIRMED',
    haltFleet: true,
  });
  page.flattenClears = true;
  const flat = await executeOneAccount(
    page,
    request({ id: 'flatten-2', action: 'FLATTEN' }),
    new MemoryLog(),
    options,
  );
  expect(flat.state).toBe('CONFIRMED_FLAT');
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

it('reads the displayed account from the page instead of the requested account', async () => {
  const context = await browser.newContext();
  const page = await context.newPage();
  const html = `<!doctype html>
    <header role="banner"><button aria-label="Account 02">Account 02</button></header>
    <p>Order Value $8.00</p>
    <button>15x</button>
    <label>Amount USD <input aria-label="Amount USD" value="8" /></label>
    <label>Amount USD % <input aria-label="Amount USD %" value="25" /></label>
    <button>Buy/Long</button>
    <button disabled>Sell/Short</button>
    <div role="tablist">
      <button role="tab" aria-controls="positions">Active Positions</button>
      <button role="tab" aria-controls="orders">Open Orders</button>
    </div>
    <button id="dialog-close" onclick="this.dataset.clicked='yes'">Close</button>
    <div id="positions" role="tabpanel"><h2>No positions yet</h2></div>
    <div id="orders" role="tabpanel">No open orders yet</div>`;
  await page.route('https://next.vestmarkets.com/**', (route) =>
    route.fulfill({ contentType: 'text/html', body: html }),
  );
  await page.goto('https://next.vestmarkets.com/trade/BTC-PERP');
  const reader = vestExecutionPage(
    page,
    async () => 1,
    () => now,
  );
  expect(await reader.readAccount()).toEqual({
    account: 'Account 02',
    observedAt: now,
  });
  expect(await reader.readSymbol()).toBe('BTC-PERP');
  const ticket = await reader.readTicket();
  expect(ticket).toMatchObject({
    account: 'Account 02',
    symbol: 'BTC-PERP',
    selectedLeverage: '15x',
    leverageChoices: ['15x'],
    allocationPercent: '25',
    orderValue: '8.00',
    amount: '8',
    buyEnabled: true,
    sellEnabled: false,
  });
  expect(await reader.readPosition()).toBeNull();
  expect(await reader.readWorkingExits()).toEqual([]);
  const result = await executeOneAccount(
    reader,
    request(),
    new MemoryLog(),
    options,
  );
  expect(result.code).toBe('ACCOUNT_SWITCH_UNKNOWN');
  expect(result.entrySubmissions).toBe(0);
  expect(await reader.submitFlatten()).toBe('CLICK_UNKNOWN');
  expect(
    await page.locator('#dialog-close').getAttribute('data-clicked'),
  ).toBeNull();
  await context.close();
});
