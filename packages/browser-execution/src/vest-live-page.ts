import type { Page } from 'playwright';
import type {
  AccountObservation,
  ClickResult,
  LiveExit,
  LivePosition,
  LiveTicket,
  VestExecutionPage,
} from './single-account.ts';

const tradePath = /^\/trade\/([A-Z0-9]+(?:-[A-Z0-9]+){0,3})$/;

async function panelText(page: Page, tabName: string) {
  const tab = page.getByRole('tab', { name: tabName, exact: true }).first();
  if ((await tab.count()) < 1) return null;
  await tab.click({ timeout: 8000 });
  const id = await tab.getAttribute('aria-controls');
  const panel = id
    ? page.locator(`[id="${id.replace(/"/g, '')}"]`)
    : page.getByRole('tabpanel').last();
  return (await panel.innerText().catch(() => '')) || '';
}
async function text(page: Page) {
  return (
    (await page
      .locator('body')
      .innerText()
      .catch(() => '')) || ''
  );
}
async function clickOnce(run: () => Promise<void>): Promise<ClickResult> {
  try {
    await run();
    return 'CLICKED';
  } catch {
    return 'CLICK_UNKNOWN';
  }
}

/** Reads the open Vest trade page. Selectors are the ones inspection recorded. */
export function vestExecutionPage(
  page: Page,
  tradingPageCount: () => Promise<number>,
  clock: () => number = Date.now,
): VestExecutionPage {
  const bannerAccount = () =>
    page.getByRole('banner').getByRole('button', { name: /Account\s+\d+/ });
  return {
    tradingPageCount,
    async readSession() {
      if (
        (await page.getByText('Log in or sign up', { exact: true }).count()) > 0
      )
        return 'LOGIN_REQUIRED';
      const header = bannerAccount().first();
      if ((await header.count()) > 0) return 'AUTHENTICATED';
      return 'UNKNOWN';
    },
    async readAccount(): Promise<AccountObservation> {
      const header = bannerAccount().first();
      if ((await header.count()) < 1)
        return { account: null, observedAt: clock() };
      const name =
        (await header.getAttribute('aria-label')) ||
        (await header.innerText()) ||
        '';
      const match = name.match(/Account\s+\d+/);
      return {
        account: match ? match[0].replace(/\s+/g, ' ') : null,
        observedAt: clock(),
      };
    },
    chooseAccount(account) {
      return clickOnce(async () => {
        const header = bannerAccount().first();
        await header.click({ timeout: 8000 });
        const choice = page
          .locator('button, a, [role="menuitem"], [role="option"]')
          .filter({ hasText: account });
        const count = await choice.count();
        for (let index = 0; index < count; index += 1) {
          const candidate = choice.nth(index);
          const inBanner = await candidate.evaluate((element) =>
            Boolean(element.closest('header, [role="banner"]')),
          );
          if (inBanner) continue;
          const label = ((await candidate.innerText()) || '').replace(
            /\s+/g,
            ' ',
          );
          if (!new RegExp(`${account}(?!\\d)`).test(label)) continue;
          await candidate.click({ timeout: 8000 });
          return;
        }
        throw new Error('ACCOUNT_CHOICE_NOT_VISIBLE');
      });
    },
    async readSymbol() {
      try {
        return tradePath.exec(new URL(page.url()).pathname)?.[1] ?? null;
      } catch {
        return null;
      }
    },
    async readTicket(): Promise<LiveTicket> {
      const account = (await this.readAccount()).account;
      const symbol = await this.readSymbol();
      const leverageButton = page
        .getByRole('button', { name: /^\d+(?:\.\d+)?x$/ })
        .first();
      const selected =
        (await leverageButton.count()) > 0
          ? ((await leverageButton.innerText()) || '')
              .replace(/\s+/g, ' ')
              .trim()
          : null;
      const body = await text(page);
      const order = body.match(/Order Value\s*\$([\d,]+(?:\.\d+)?)/i);
      const amount = page.getByRole('textbox', {
        name: 'Amount USD',
        exact: true,
      });
      const percent = page.getByRole('textbox', {
        name: 'Amount USD %',
        exact: true,
      });
      const buy = page.getByRole('button', { name: 'Buy/Long', exact: true });
      const sell = page.getByRole('button', {
        name: 'Sell/Short',
        exact: true,
      });
      const title = await page.title();
      const ticker = title.match(/\$([\d,]+(?:\.\d+)?)/);
      const closed = /market is closed|Market Closed/i.test(body);
      const buyCount = await buy.count();
      const visibleChoices = (
        await page
          .getByRole('button')
          .evaluateAll((elements) =>
            elements.map((element) =>
              (element.textContent || '').replace(/\s+/g, ' ').trim(),
            ),
          )
      ).filter((label) => /^\d+(?:\.\d+)?x$/i.test(label));
      return {
        account,
        symbol,
        sideContext: null,
        leverageChoices: visibleChoices,
        selectedLeverage: selected,
        allocationPercent:
          (await percent.count()) === 1 ? await percent.inputValue() : null,
        orderValue: order ? order[1]!.replace(/,/g, '') : null,
        amount: (await amount.count()) === 1 ? await amount.inputValue() : null,
        buyEnabled: (await buy.count()) === 1 && (await buy.isEnabled()),
        sellEnabled: (await sell.count()) === 1 && (await sell.isEnabled()),
        marketOpen: closed ? false : buyCount === 1 ? true : null,
        blockingReason: null,
        tickerPrice: ticker ? ticker[1]!.replace(/,/g, '') : null,
      };
    },
    async openLeverageMenu() {
      const button = page
        .getByRole('button', { name: /^\d+(?:\.\d+)?x$/ })
        .first();
      await button.click({ timeout: 8000 });
      const labels = await page
        .getByRole('button')
        .evaluateAll((elements) =>
          elements.map((element) =>
            (element.textContent || '').replace(/\s+/g, ' ').trim(),
          ),
        );
      return labels.filter((label) => /^\d+(?:\.\d+)?x$/i.test(label));
    },
    chooseLeverage(choice) {
      const label = /x$/i.test(choice) ? choice : `${choice}x`;
      return clickOnce(() =>
        page
          .getByRole('button', { name: label, exact: true })
          .click({ timeout: 8000 }),
      );
    },
    chooseAllocation(percent) {
      return clickOnce(() =>
        page
          .getByRole('button', { name: `${percent}%`, exact: true })
          .click({ timeout: 8000 }),
      );
    },
    submitEntry(side) {
      const name = side === 'LONG' ? 'Buy/Long' : 'Sell/Short';
      return clickOnce(() =>
        page
          .getByRole('button', { name, exact: true })
          .click({ timeout: 8000 }),
      );
    },
    async readPosition(): Promise<LivePosition | null> {
      const marked = page.locator('[data-vest-position]');
      if ((await marked.count()) === 1) {
        const row = marked.first();
        return {
          account: await row.getAttribute('data-account'),
          symbol: await row.getAttribute('data-symbol'),
          side: (await row.getAttribute('data-side')) as
            'LONG' | 'SHORT' | null,
          size: await row.getAttribute('data-size'),
          averageEntry: await row.getAttribute('data-entry'),
          unparsed: false,
        };
      }
      const panel = await panelText(page, 'Active Positions');
      if (panel === null) return { unparsed: true } as LivePosition;
      if (/No positions/i.test(panel)) return null;
      return {
        account: null,
        symbol: null,
        side: null,
        size: null,
        averageEntry: null,
        unparsed: true,
      };
    },
    async readWorkingExits() {
      const marked = page.locator('[data-vest-exit]');
      const count = await marked.count();
      if (count > 0) {
        const exits: LiveExit[] = [];
        for (let index = 0; index < count; index += 1) {
          const row = marked.nth(index);
          const kind = await row.getAttribute('data-kind');
          if (kind !== 'STOP' && kind !== 'TARGET') return 'UNPARSED';
          exits.push({
            kind,
            price: await row.getAttribute('data-price'),
            account: await row.getAttribute('data-account'),
            symbol: await row.getAttribute('data-symbol'),
          });
        }
        return exits;
      }
      const panel = await panelText(page, 'Open Orders');
      if (panel === null) return 'UNPARSED';
      if (/No open orders|No orders/i.test(panel)) return [];
      return 'UNPARSED';
    },
    placeExit(kind, price) {
      const name = kind === 'STOP' ? 'Stop Loss $' : 'Take Profit $';
      return clickOnce(async () => {
        const field = page.getByRole('textbox', { name, exact: true });
        if ((await field.count()) !== 1)
          throw new Error('EXIT_FIELD_NOT_UNIQUE');
        await field.fill(price);
      });
    },
    submitFlatten() {
      return clickOnce(async () => {
        const tab = page.getByRole('tab', {
          name: 'Active Positions',
          exact: true,
        });
        if ((await tab.count()) === 1) await tab.click({ timeout: 8000 });
        const button = page.getByRole('button', { name: 'Close', exact: true });
        if ((await button.count()) !== 1)
          throw new Error('FLATTEN_CONTROL_NOT_UNIQUE');
        await button.click({ timeout: 8000 });
      });
    },
  };
}
