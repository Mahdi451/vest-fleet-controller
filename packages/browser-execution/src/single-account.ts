import { D } from '../../core/src/index.ts';

/** States the orchestration layer can branch on. This module never sequences a fleet. */
export type AccountExecutionState =
  | 'FLAT'
  | 'ENTRY_UNKNOWN'
  | 'OPEN_UNPROTECTED'
  | 'OPEN_PROTECTED'
  | 'CONFIRMED_FLAT'
  | 'HALTED';

export type EntryReconciliation =
  'NO_ENTRY_OBSERVED' | 'ENTRY_CONFIRMED' | 'AMBIGUOUS';

export interface AccountObservation {
  account: string | null;
  observedAt: number | null;
}
export interface LiveTicket {
  account: string | null;
  symbol: string | null;
  sideContext: 'LONG' | 'SHORT' | null;
  leverageChoices: readonly string[];
  selectedLeverage: string | null;
  allocationPercent: string | null;
  orderValue: string | null;
  amount: string | null;
  buyEnabled: boolean;
  sellEnabled: boolean;
  marketOpen: boolean | null;
  blockingReason: string | null;
  /** Title or last-trade price. Exits must not be calculated from this. */
  tickerPrice: string | null;
}
export interface LivePosition {
  account: string | null;
  symbol: string | null;
  side: 'LONG' | 'SHORT' | null;
  size: string | null;
  averageEntry: string | null;
  unparsed: boolean;
}
export interface LiveExit {
  kind: 'STOP' | 'TARGET';
  price: string | null;
  account: string | null;
  symbol: string | null;
}
export type ClickResult = 'CLICKED' | 'CLICK_UNKNOWN';

/** Every method returns the page's current fact or performs one click. None may retry. */
export interface VestExecutionPage {
  tradingPageCount(): Promise<number>;
  readSession(): Promise<'AUTHENTICATED' | 'LOGIN_REQUIRED' | 'UNKNOWN'>;
  readAccount(): Promise<AccountObservation>;
  chooseAccount(account: string): Promise<ClickResult>;
  readSymbol(): Promise<string | null>;
  readTicket(): Promise<LiveTicket>;
  openLeverageMenu(): Promise<readonly string[]>;
  chooseLeverage(choice: string): Promise<ClickResult>;
  chooseAllocation(percent: string): Promise<ClickResult>;
  submitEntry(side: 'LONG' | 'SHORT'): Promise<ClickResult>;
  readPosition(): Promise<LivePosition | null>;
  readWorkingExits(): Promise<readonly LiveExit[] | 'UNPARSED'>;
  placeExit(kind: 'STOP' | 'TARGET', price: string): Promise<ClickResult>;
  submitFlatten(): Promise<ClickResult>;
}

export interface OrderIntent {
  id: string;
  runId: string;
  account: string;
  symbol: string;
  side: 'LONG' | 'SHORT' | 'FLATTEN';
  requestedLeverage: string | null;
  requestedAllocation: string | null;
  observedOrderValue: string | null;
  createdAt: number;
}
export interface IntentLog {
  save(intent: OrderIntent): Promise<void>;
  has(id: string): Promise<boolean>;
}
export interface OneAccountRequest {
  id: string;
  runId: string;
  account: string;
  symbol: string;
  action: 'LONG' | 'SHORT' | 'FLATTEN';
  leverage?: string;
  allocationPercent?: string;
  maxOrderValue?: string;
  stopDistance?: string;
  targetDistance?: string;
}
export interface OneAccountResult {
  state: AccountExecutionState;
  haltFleet: boolean;
  code: string | null;
  intent: OrderIntent | null;
  account: string | null;
  symbol: string | null;
  fill: string | null;
  stop: string | null;
  target: string | null;
  reconciliation: EntryReconciliation | null;
  entrySubmissions: number;
}

const empty = (
  state: AccountExecutionState,
  code: string | null,
  haltFleet: boolean,
  extra: Partial<OneAccountResult> = {},
): OneAccountResult => ({
  state,
  haltFleet,
  code,
  intent: null,
  account: null,
  symbol: null,
  fill: null,
  stop: null,
  target: null,
  reconciliation: null,
  entrySubmissions: 0,
  ...extra,
});

function sameNumber(actual: string | null, expected: string) {
  if (actual === null) return false;
  try {
    return new D(actual).eq(expected);
  } catch {
    return false;
  }
}

/** Stop and target distances apply to the fill that was read, never to a ticker price. */
export function exitsFromFill(
  side: 'LONG' | 'SHORT',
  fill: string,
  stopDistance: string,
  targetDistance: string,
) {
  const entry = new D(fill);
  const stop = new D(stopDistance);
  const target = new D(targetDistance);
  if (!entry.gt(0) || !stop.gt(0) || !target.gt(0))
    throw new Error('INVALID_EXIT_DISTANCE');
  const stopPrice = side === 'LONG' ? entry.minus(stop) : entry.plus(stop);
  const targetPrice =
    side === 'LONG' ? entry.plus(target) : entry.minus(target);
  if (!stopPrice.gt(0) || !targetPrice.gt(0))
    throw new Error('INVALID_EXIT_PRICE');
  return { stop: stopPrice.toFixed(), target: targetPrice.toFixed() };
}

export async function reconcileEntry(
  page: VestExecutionPage,
  intent: Pick<OrderIntent, 'account' | 'symbol' | 'side'>,
): Promise<EntryReconciliation> {
  if (intent.side === 'FLATTEN') return 'AMBIGUOUS';
  const position = await page.readPosition();
  if (position?.unparsed) return 'AMBIGUOUS';
  if (!position) return 'NO_ENTRY_OBSERVED';
  const exits = await page.readWorkingExits();
  if (exits === 'UNPARSED') return 'AMBIGUOUS';
  const matches =
    position.account === intent.account &&
    position.symbol === intent.symbol &&
    position.side === intent.side &&
    position.size !== null &&
    position.averageEntry !== null;
  return matches ? 'ENTRY_CONFIRMED' : 'AMBIGUOUS';
}

async function requireAccount(
  page: VestExecutionPage,
  expected: string,
  now: number,
  maxHeaderAgeMs: number,
): Promise<{ ok: true; account: string } | { ok: false; code: string }> {
  const observed = await page.readAccount();
  if (
    observed.observedAt === null ||
    !Number.isSafeInteger(observed.observedAt) ||
    now - observed.observedAt > maxHeaderAgeMs ||
    observed.observedAt > now
  )
    return { ok: false, code: 'STALE_ACCOUNT' };
  if (observed.account === expected) return { ok: true, account: expected };
  const clicked = await page.chooseAccount(expected);
  if (clicked !== 'CLICKED')
    return { ok: false, code: 'ACCOUNT_SWITCH_UNKNOWN' };
  const after = await page.readAccount();
  if (
    after.observedAt === null ||
    now - after.observedAt > maxHeaderAgeMs ||
    after.observedAt > now
  )
    return { ok: false, code: 'STALE_ACCOUNT' };
  if (after.account !== expected)
    return { ok: false, code: 'ACCOUNT_MISMATCH' };
  return { ok: true, account: expected };
}

async function requireLeverage(
  page: VestExecutionPage,
  requested: string,
): Promise<{ ok: true } | { ok: false; code: string }> {
  const choices = await page.openLeverageMenu();
  const canonical = choices.map((choice) => choice.replace(/x$/i, ''));
  const wanted = requested.replace(/x$/i, '');
  if (!canonical.includes(wanted))
    return { ok: false, code: 'LEVERAGE_UNAVAILABLE' };
  const clicked = await page.chooseLeverage(wanted);
  if (clicked !== 'CLICKED')
    return { ok: false, code: 'LEVERAGE_CLICK_UNKNOWN' };
  const ticket = await page.readTicket();
  const selected = ticket.selectedLeverage?.replace(/x$/i, '') ?? null;
  if (selected !== wanted) return { ok: false, code: 'LEVERAGE_MISMATCH' };
  return { ok: true };
}

function exitMatches(
  exits: readonly LiveExit[],
  kind: 'STOP' | 'TARGET',
  price: string,
  account: string,
  symbol: string,
) {
  return exits.some(
    (exit) =>
      exit.kind === kind &&
      exit.account === account &&
      exit.symbol === symbol &&
      sameNumber(exit.price, price),
  );
}

/**
 * One account, one page, one entry click. Fleet sequencing stays with the caller.
 * Every trading fact is read back from the page before it is trusted.
 */
export async function executeOneAccount(
  page: VestExecutionPage,
  request: OneAccountRequest,
  log: IntentLog,
  options: { now: number; maxHeaderAgeMs: number },
): Promise<OneAccountResult> {
  if (await log.has(request.id))
    return empty('HALTED', 'DUPLICATE_INTENT', true);
  const pages = await page.tradingPageCount();
  if (pages !== 1)
    return empty('HALTED', pages === 0 ? 'NO_PAGE' : 'COMPETING_PAGE', true);
  if ((await page.readSession()) !== 'AUTHENTICATED')
    return empty('HALTED', 'LOGIN_LOSS', true);
  const account = await requireAccount(
    page,
    request.account,
    options.now,
    options.maxHeaderAgeMs,
  );
  if (!account.ok) return empty('HALTED', account.code, true);
  const symbol = await page.readSymbol();
  if (symbol !== request.symbol)
    return empty('HALTED', 'SYMBOL_MISMATCH', true);

  if (request.action === 'FLATTEN') return flatten(page, request, options);

  if (!request.leverage || !request.allocationPercent || !request.maxOrderValue)
    return empty('HALTED', 'ENTRY_TERMS_MISSING', true);
  if (!request.stopDistance || !request.targetDistance)
    return empty('HALTED', 'EXIT_DISTANCE_MISSING', true);
  const leverage = request.leverage;
  const allocation = request.allocationPercent;
  const maxOrderValue = request.maxOrderValue;
  const offered = await requireLeverage(page, leverage);
  if (!offered.ok) return empty('HALTED', offered.code, true);
  const sized = await page.chooseAllocation(allocation);
  if (sized !== 'CLICKED')
    return empty('HALTED', 'ALLOCATION_CLICK_UNKNOWN', true);
  const ticket = await page.readTicket();
  if (ticket.blockingReason)
    return empty('HALTED', ticket.blockingReason, true);
  if (ticket.marketOpen !== true) return empty('HALTED', 'MARKET_CLOSED', true);
  if (ticket.account !== request.account)
    return empty('HALTED', 'ACCOUNT_MISMATCH', true);
  if (ticket.symbol !== request.symbol)
    return empty('HALTED', 'SYMBOL_MISMATCH', true);
  if (!sameNumber(ticket.allocationPercent, allocation))
    return empty('HALTED', 'ALLOCATION_REJECTED', true);
  if (!sameNumber(ticket.orderValue, ticket.orderValue ?? ''))
    return empty('HALTED', 'ORDER_VALUE_UNREAD', true);
  const orderValue = ticket.orderValue ?? '';
  if (new D(orderValue).gt(maxOrderValue))
    return empty('HALTED', 'ORDER_VALUE_CAP', true);
  const enabled =
    request.action === 'LONG' ? ticket.buyEnabled : ticket.sellEnabled;
  if (!enabled) return empty('HALTED', 'ENTRY_DISABLED', true);

  const intent: OrderIntent = {
    id: request.id,
    runId: request.runId,
    account: request.account,
    symbol: request.symbol,
    side: request.action,
    requestedLeverage: leverage,
    requestedAllocation: allocation,
    observedOrderValue: orderValue,
    createdAt: options.now,
  };
  await log.save(intent);
  const again = await requireAccount(
    page,
    request.account,
    options.now,
    options.maxHeaderAgeMs,
  );
  if (!again.ok) return empty('HALTED', again.code, true, { intent });
  const symbolAgain = await page.readSymbol();
  const ticketAgain = await page.readTicket();
  if (
    symbolAgain !== request.symbol ||
    ticketAgain.symbol !== request.symbol ||
    ticketAgain.selectedLeverage?.replace(/x$/i, '') !==
      leverage.replace(/x$/i, '') ||
    !sameNumber(ticketAgain.allocationPercent, allocation) ||
    !sameNumber(ticketAgain.orderValue, orderValue)
  )
    return empty('HALTED', 'TICKET_CHANGED', true, { intent });
  const stillEnabled =
    request.action === 'LONG'
      ? ticketAgain.buyEnabled
      : ticketAgain.sellEnabled;
  if (!stillEnabled || ticketAgain.marketOpen !== true)
    return empty(
      'HALTED',
      ticketAgain.marketOpen === true ? 'ENTRY_DISABLED' : 'MARKET_CLOSED',
      true,
      { intent },
    );

  const clicked = await page.submitEntry(request.action);
  if (clicked !== 'CLICKED') {
    const reconciliation = await reconcileEntry(page, intent);
    if (reconciliation === 'ENTRY_CONFIRMED')
      return protect(page, request, intent, 1);
    return empty(
      reconciliation === 'AMBIGUOUS' ? 'HALTED' : 'ENTRY_UNKNOWN',
      reconciliation === 'AMBIGUOUS' ? 'AMBIGUOUS_ENTRY' : 'ENTRY_UNKNOWN',
      true,
      { intent, reconciliation, entrySubmissions: 1 },
    );
  }
  const reconciliation = await reconcileEntry(page, intent);
  if (reconciliation !== 'ENTRY_CONFIRMED')
    return empty(
      reconciliation === 'NO_ENTRY_OBSERVED' ? 'ENTRY_UNKNOWN' : 'HALTED',
      reconciliation === 'NO_ENTRY_OBSERVED'
        ? 'ENTRY_UNKNOWN'
        : 'AMBIGUOUS_ENTRY',
      true,
      { intent, reconciliation, entrySubmissions: 1 },
    );
  return protect(page, request, intent, 1);
}

async function protect(
  page: VestExecutionPage,
  request: OneAccountRequest,
  intent: OrderIntent,
  entrySubmissions: number,
): Promise<OneAccountResult> {
  const position = await page.readPosition();
  if (
    !position ||
    position.unparsed ||
    position.averageEntry === null ||
    position.account !== request.account ||
    position.symbol !== request.symbol ||
    position.side !== request.action
  )
    return empty('HALTED', 'MISSING_POSITION', true, {
      intent,
      reconciliation: 'AMBIGUOUS',
      entrySubmissions,
    });
  let prices;
  try {
    prices = exitsFromFill(
      request.action as 'LONG' | 'SHORT',
      position.averageEntry,
      request.stopDistance!,
      request.targetDistance!,
    );
  } catch {
    return empty('HALTED', 'INVALID_EXIT_PRICE', true, {
      intent,
      fill: position.averageEntry,
      entrySubmissions,
    });
  }
  const stopClick = await page.placeExit('STOP', prices.stop);
  const afterStop = await page.readWorkingExits();
  const stopVerified =
    stopClick === 'CLICKED' &&
    afterStop !== 'UNPARSED' &&
    exitMatches(
      afterStop,
      'STOP',
      prices.stop,
      request.account,
      request.symbol,
    );
  if (!stopVerified)
    return empty('OPEN_UNPROTECTED', 'MISSING_STOP', true, {
      intent,
      fill: position.averageEntry,
      account: request.account,
      symbol: request.symbol,
      entrySubmissions,
    });
  const targetClick = await page.placeExit('TARGET', prices.target);
  const afterTarget = await page.readWorkingExits();
  const targetVerified =
    targetClick === 'CLICKED' &&
    afterTarget !== 'UNPARSED' &&
    exitMatches(
      afterTarget,
      'TARGET',
      prices.target,
      request.account,
      request.symbol,
    );
  if (!targetVerified)
    return empty('HALTED', 'MISSING_TARGET', true, {
      intent,
      fill: position.averageEntry,
      stop: prices.stop,
      account: request.account,
      symbol: request.symbol,
      entrySubmissions,
    });
  return empty('OPEN_PROTECTED', null, false, {
    intent,
    fill: position.averageEntry,
    stop: prices.stop,
    target: prices.target,
    account: request.account,
    symbol: request.symbol,
    reconciliation: 'ENTRY_CONFIRMED',
    entrySubmissions,
  });
}

async function flatten(
  page: VestExecutionPage,
  request: OneAccountRequest,
  options: { now: number; maxHeaderAgeMs: number },
): Promise<OneAccountResult> {
  const before = await page.readPosition();
  const exits = await page.readWorkingExits();
  if (exits === 'UNPARSED' || before?.unparsed)
    return empty('HALTED', 'FLATNESS_UNPARSED', true);
  if (!before && exits.length === 0)
    return empty('CONFIRMED_FLAT', null, false, {
      account: request.account,
      symbol: request.symbol,
    });
  const clicked = await page.submitFlatten();
  if (clicked !== 'CLICKED')
    return empty('HALTED', 'FLATTEN_CLICK_UNKNOWN', true);
  const position = await page.readPosition();
  const remaining = await page.readWorkingExits();
  const account = await page.readAccount();
  const accountFresh =
    account.account === request.account &&
    account.observedAt !== null &&
    account.observedAt <= options.now &&
    options.now - account.observedAt <= options.maxHeaderAgeMs;
  if (
    !accountFresh ||
    position ||
    remaining === 'UNPARSED' ||
    remaining.length > 0
  )
    return empty('HALTED', 'FLATTEN_UNCONFIRMED', true);
  return empty('CONFIRMED_FLAT', null, false, {
    account: request.account,
    symbol: request.symbol,
  });
}
