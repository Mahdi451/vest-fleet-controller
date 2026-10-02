import { randomUUID } from 'node:crypto';
import { PassThrough } from 'node:stream';
import { EventEmitter } from 'node:events';
import { attachObserverControls } from '../apps/vest-observer/cli.ts';
import { existsSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { acquireObserverProfile } from '../apps/vest-observer/profile.ts';
import {
  ManualInspectionSession,
  VEST_OFFICIAL_START,
  wrapManualBrowser,
  type ManualBrowser,
  type ManualPage,
} from '../apps/vest-observer/session.ts';
import { chromium, type BrowserContext } from 'playwright';
import {
  observationAuthorizationSchema,
  assertObservationAuthorization,
} from '../packages/browser-execution/src/authorization.ts';
import {
  machineBindingSync,
  publishPrivateFileSync,
} from '../packages/host/src/storage.ts';
import { privateRuntime } from './fixtures/runtime.ts';

let runtime: string;
let profile: string;
let owner: {
  ownerId: string;
  instanceId: string;
  machineHash: string;
  runtimeDirectory: string;
  state: string;
};
let sessions: ManualInspectionSession[];
beforeEach(() => {
  runtime = privateRuntime('vfc-observer-runtime-');
  profile = privateRuntime('vfc-observer-profile-');
  owner = {
    ownerId: randomUUID(),
    instanceId: randomUUID(),
    machineHash: machineBindingSync(),
    runtimeDirectory: runtime,
    state: 'ACTIVE',
  };
  publishPrivateFileSync(join(runtime, 'identity.json'), JSON.stringify(owner));
  sessions = [];
});
afterEach(async () => {
  for (const session of sessions) await session.close().catch(() => {});
  vi.useRealTimers();
  rmSync(runtime, { recursive: true, force: true });
  rmSync(profile, { recursive: true, force: true });
});
class Page implements ManualPage {
  location = 'about:blank';
  navigation: (() => void)[] = [];
  opened = 0;
  url() {
    return this.location;
  }
  async openOfficialStart() {
    this.opened++;
    this.navigate(VEST_OFFICIAL_START);
  }
  onMainNavigation(callback: () => void) {
    this.navigation.push(callback);
  }
  navigate(url: string) {
    this.location = url;
    for (const callback of this.navigation) callback();
  }
}
class Browser implements ManualBrowser {
  page = new Page();
  list: Page[] = [this.page];
  added: ((page: ManualPage) => void)[] = [];
  closed: (() => void)[] = [];
  alreadyClosed = false;
  failClose = false;
  closeCount = 0;
  pages() {
    return this.list;
  }
  async newPage() {
    const page = new Page();
    this.add(page);
    return page;
  }
  onPage(callback: (page: ManualPage) => void) {
    this.added.push(callback);
  }
  onClosed(callback: () => void) {
    this.closed.push(callback);
    if (this.alreadyClosed) callback();
  }
  add(page: Page) {
    this.list.push(page);
    for (const callback of this.added) callback(page);
  }
  crash() {
    this.alreadyClosed = true;
    for (const callback of this.closed) callback();
  }
  async close() {
    this.closeCount++;
    if (this.failClose) throw new Error('SECRET_BROWSER_DETAIL');
    this.crash();
  }
}
async function open(browser = new Browser(), clock?: () => number) {
  const session = await ManualInspectionSession.open({
    runtimeDirectory: runtime,
    profileDirectory: profile,
    ownerAuthorizesReadOnly: true,
    factory: async () => browser,
    ...(clock ? { clock } : {}),
  });
  sessions.push(session);
  return { session, browser };
}
function lockPresent() {
  return existsSync(join(runtime, 'vest-observer.lock'));
}
it.each(['USER_OWNER_AUTHORIZATION', 'VENUE_WRITTEN_APPROVAL'] as const)(
  'preserves explicit authorization basis %s without converting it to venue approval',
  (basis) => {
    const auth = observationAuthorizationSchema.parse({
      ownerId: owner.ownerId,
      instanceId: owner.instanceId,
      basis,
      termsReviewReference: 'PUBLIC_TERMS_REVIEW',
      reference: 'LOCAL_REFERENCE',
      scope: 'READ_ONLY_OWNER_ACCOUNTS',
      approvedAt: 1000,
      expiresAt: 2000,
      revoked: false,
    });
    expect(auth.basis).toBe(basis);
    expect(() =>
      assertObservationAuthorization(auth, owner, 1500),
    ).not.toThrow();
    expect(() =>
      assertObservationAuthorization({ ...auth, revoked: true }, owner, 1500),
    ).toThrow('OBSERVATION_AUTHORIZATION_REQUIRED');
    expect(() =>
      assertObservationAuthorization(
        auth,
        { ...owner, ownerId: randomUUID() },
        1500,
      ),
    ).toThrow('OBSERVATION_OWNER_MISMATCH');
    const { basis: omitted, ...missingBasis } = auth;
    expect(omitted).toBe(basis);
    expect(observationAuthorizationSchema.safeParse(missingBasis).success).toBe(
      false,
    );
  },
);
it('requires owner opt-in before any profile write or browser launch', async () => {
  const factory = vi.fn();
  await expect(
    ManualInspectionSession.open({
      runtimeDirectory: runtime,
      profileDirectory: profile,
      ownerAuthorizesReadOnly: false,
      factory,
    }),
  ).rejects.toThrow('OWNER_READ_ONLY_AUTHORIZATION_REQUIRED');
  expect(factory).not.toHaveBeenCalled();
  expect(readdirSync(profile)).toEqual([]);
  expect(lockPresent()).toBe(false);
});
it.each([
  { state: 'ADOPTING' },
  { machineHash: '0'.repeat(64) },
  { runtimeDirectory: '/wrong/runtime' },
])(
  'rejects an unverified host without rewriting identity: %j',
  async (override) => {
    const contents = JSON.stringify({ ...owner, ...override });
    publishPrivateFileSync(join(runtime, 'identity.json'), contents, true);
    await expect(acquireObserverProfile(runtime, profile)).rejects.toThrow(
      'INITIALIZED_VERIFIED_HOST_REQUIRED',
    );
    expect(readFileSync(join(runtime, 'identity.json'), 'utf8')).toBe(contents);
    expect(readdirSync(profile)).toEqual([]);
  },
);
it('rejects uninitialized runtime without provisioning an owner', async () => {
  const missing = join(runtime, 'missing');
  await expect(acquireObserverProfile(missing, profile)).rejects.toThrow(
    'INITIALIZED_VERIFIED_HOST_REQUIRED',
  );
  expect(existsSync(missing)).toBe(false);
});
it('binds a protected private profile and releases only observer locks, preserving execution records', async () => {
  const records = {
    'controller.lock': JSON.stringify({ pid: process.pid, id: randomUUID() }),
    'journal.sqlite': 'PRESERVE_UNRESOLVED_RECORD',
    'halt.json': 'HALTED',
  };
  for (const [name, content] of Object.entries(records))
    publishPrivateFileSync(join(runtime, name), content);
  const { session, browser } = await open();
  expect(session.status()).toBe('OPEN_FOR_MANUAL_SIGN_IN');
  expect(browser.page.opened).toBe(1);
  session.acknowledgeManualInspection();
  expect(session.status()).toBe('MANUAL_INSPECTION_ACKNOWLEDGED');
  const binding = JSON.parse(
    readFileSync(join(profile, 'binding.json'), 'utf8'),
  );
  expect(binding).toMatchObject({
    ownerId: owner.ownerId,
    instanceId: owner.instanceId,
    runtimeDirectory: runtime,
    profileDirectory: profile,
  });
  const authorization = JSON.parse(
    readFileSync(join(profile, 'owner-authorization.json'), 'utf8'),
  );
  expect(authorization.basis).toBe('USER_OWNER_AUTHORIZATION');
  expect(authorization.scope).toBe('READ_ONLY_OWNER_ACCOUNTS');
  await session.close();
  expect(session.status()).toBe('CLOSED');
  expect(lockPresent()).toBe(false);
  expect(existsSync(join(profile, 'observer.lock'))).toBe(false);
  expect(existsSync(join(profile, 'binding.json'))).toBe(true);
  for (const [name, content] of Object.entries(records))
    expect(readFileSync(join(runtime, name), 'utf8')).toBe(content);
});
it('rejects competing or stale instance observer locks across different profiles without deleting them', async () => {
  const stale = JSON.stringify({ pid: 2147483647, id: randomUUID() });
  publishPrivateFileSync(join(runtime, 'vest-observer.lock'), stale);
  await expect(acquireObserverProfile(runtime, profile)).rejects.toThrow(
    'OBSERVER_INSTANCE_LOCKED_REVIEW_REQUIRED',
  );
  expect(readFileSync(join(runtime, 'vest-observer.lock'), 'utf8')).toBe(stale);
  expect(readdirSync(profile)).toEqual([]);
});
it('preserves another profile lock when profile acquisition fails', async () => {
  publishPrivateFileSync(join(profile, 'observer.lock'), 'OTHER_OWNER');
  await expect(acquireObserverProfile(runtime, profile)).rejects.toThrow(
    'OBSERVER_PROFILE_LOCKED_REVIEW_REQUIRED',
  );
  expect(readFileSync(join(profile, 'observer.lock'), 'utf8')).toBe(
    'OTHER_OWNER',
  );
  expect(lockPresent()).toBe(false);
});
it('rejects preexisting unbound browser material without adopting it', async () => {
  publishPrivateFileSync(join(profile, 'old-profile'), 'SENSITIVE');
  await expect(acquireObserverProfile(runtime, profile)).rejects.toThrow(
    'UNBOUND_BROWSER_PROFILE_REJECTED',
  );
  expect(readFileSync(join(profile, 'old-profile'), 'utf8')).toBe('SENSITIVE');
  expect(lockPresent()).toBe(false);
});
it.each([
  'ownerId',
  'instanceId',
  'machineHash',
  'runtimeDirectory',
  'profileDirectory',
])('rejects mismatched profile binding %s without rebinding', async (field) => {
  const lease = await acquireObserverProfile(runtime, profile);
  lease.release();
  const changed = {
    ...lease.binding,
    [field]: field.endsWith('Id')
      ? randomUUID()
      : field === 'machineHash'
        ? '0'.repeat(64)
        : '/wrong/path',
  };
  const contents = JSON.stringify(changed);
  publishPrivateFileSync(join(profile, 'binding.json'), contents, true);
  await expect(acquireObserverProfile(runtime, profile)).rejects.toThrow(
    'OBSERVER_HOST_OWNER_INSTANCE_MISMATCH',
  );
  expect(readFileSync(join(profile, 'binding.json'), 'utf8')).toBe(contents);
  expect(lockPresent()).toBe(false);
});
it('rejects a profile inside a Git checkout before creating browser material', async () => {
  publishPrivateFileSync(join(profile, '.git'), 'gitdir: elsewhere');
  await expect(
    acquireObserverProfile(runtime, join(profile, 'nested')),
  ).rejects.toThrow('OBSERVER_PROFILE_MUST_BE_OUTSIDE_GIT');
  expect(existsSync(join(profile, 'nested'))).toBe(false);
  expect(lockPresent()).toBe(false);
});
it('rejects two restored pages before opening Vest', async () => {
  const browser = new Browser();
  browser.list.push(new Page());
  await expect(open(browser)).rejects.toThrow(
    'MANUAL_OBSERVER_START_FAILED_REVIEW_LOCKS',
  );
  expect(browser.page.opened).toBe(0);
  expect(browser.closeCount).toBe(1);
  expect(lockPresent()).toBe(false);
});
it('quarantines an added page instead of assuming separate account context', async () => {
  const { session, browser } = await open();
  browser.add(new Page());
  await session.whenClosed();
  expect(session.status()).toBe('QUARANTINED');
  expect(browser.closeCount).toBe(1);
});
it.each([
  'https://unreviewed-login.example/',
  'http://next.vestmarkets.com/',
  'https://next.vestmarkets.com.evil.example/',
  'about:blank',
])(
  'quarantines unexpected navigation %s without a guessed login allowlist',
  async (url) => {
    const { session, browser } = await open();
    browser.page.navigate(url);
    await session.whenClosed();
    expect(session.status()).toBe('QUARANTINED');
  },
);
it('retains locks after an ambiguous launch failure and redacts raw browser errors', async () => {
  await expect(
    ManualInspectionSession.open({
      runtimeDirectory: runtime,
      profileDirectory: profile,
      ownerAuthorizesReadOnly: true,
      factory: async () => {
        throw new Error('SECRET_BROWSER_DETAIL');
      },
    }),
  ).rejects.toThrow(/^MANUAL_OBSERVER_START_FAILED_REVIEW_LOCKS$/);
  expect(lockPresent()).toBe(true);
  expect(existsSync(join(profile, 'observer.lock'))).toBe(true);
  await expect(acquireObserverProfile(runtime, profile)).rejects.toThrow(
    'OBSERVER_INSTANCE_LOCKED_REVIEW_REQUIRED',
  );
});
it('retains locks after a crash and rejects acknowledgement or automatic takeover', async () => {
  vi.useFakeTimers();
  const { session, browser } = await open();
  browser.crash();
  await session.whenClosed();
  expect(session.status()).toBe('QUARANTINED');
  expect(session.stopReason()).toBe('UNEXPECTED_BROWSER_CLOSE');
  expect(vi.getTimerCount()).toBe(0);
  expect(() => session.acknowledgeManualInspection()).toThrow(
    'MANUAL_OBSERVER_NOT_OPEN',
  );
  await vi.advanceTimersByTimeAsync(3600001);
  await expect(session.close()).rejects.toThrow(
    'OBSERVER_CLOSE_UNCONFIRMED_LOCKS_RETAINED',
  );
  expect(browser.closeCount).toBe(0);
  expect(lockPresent()).toBe(true);
  await expect(acquireObserverProfile(runtime, profile)).rejects.toThrow(
    'OBSERVER_INSTANCE_LOCKED_REVIEW_REQUIRED',
  );
});
it('retains locks when a crash precedes initialization callback registration', async () => {
  const browser = new Browser();
  browser.crash();
  await expect(open(browser)).rejects.toThrow(
    'MANUAL_OBSERVER_START_FAILED_REVIEW_LOCKS',
  );
  expect(browser.page.opened).toBe(0);
  expect(browser.closeCount).toBe(0);
  expect(lockPresent()).toBe(true);
});
it('subscribes immediately and replays context closure to a late session listener', () => {
  let closed: (() => void) | undefined;
  const context = {
    browser: () => ({ isConnected: () => true }),
    on: (_event: string, callback: () => void) => {
      closed = callback;
    },
  } as unknown as BrowserContext;
  const wrapped = wrapManualBrowser(context);
  closed!();
  const listener = vi.fn();
  wrapped.onClosed(listener);
  expect(listener).toHaveBeenCalledOnce();
});
it('retains locks when browser closure cannot be confirmed', async () => {
  const { session, browser } = await open();
  browser.failClose = true;
  await expect(session.close()).rejects.toThrow(
    /^OBSERVER_CLOSE_UNCONFIRMED_LOCKS_RETAINED$/,
  );
  expect(session.status()).toBe('QUARANTINED');
  expect(lockPresent()).toBe(true);
});
it('expires local authorization without claiming authentication or readiness', async () => {
  let now = 1000;
  const { session } = await open(new Browser(), () => now);
  now += 3600000;
  expect(() => session.acknowledgeManualInspection()).toThrow(
    'OBSERVATION_AUTHORIZATION_REQUIRED',
  );
});
it('closes the browser when the one-hour local inspection authorization expires', async () => {
  vi.useFakeTimers();
  const { session, browser } = await open();
  await vi.advanceTimersByTimeAsync(3600000);
  await session.whenClosed();
  expect(session.status()).toBe('QUARANTINED');
  expect(browser.closeCount).toBe(1);
});

function timeline() {
  const name = readdirSync(profile).find((name) =>
    /^lifecycle-.*\.json$/.test(name),
  );
  expect(name).toBeDefined();
  return JSON.parse(readFileSync(join(profile, name!), 'utf8')) as {
    event: string;
    cause: string | null;
    elapsedMs: number;
    closeObserved: boolean;
    closeResult: string;
    childExitInformation: string;
  }[];
}
it.each(['CLI_QUIT', 'STDIN_EOF', 'SIGINT', 'SIGTERM'] as const)(
  'records %s and releases only observer locks after confirmed closure',
  async (cause) => {
    const { session, browser } = await open();
    const input = new PassThrough();
    const signals = new EventEmitter();
    const detach = attachObserverControls(session, input, signals);
    try {
      if (cause === 'CLI_QUIT') input.write('quit\n');
      else if (cause === 'STDIN_EOF') input.end();
      else signals.emit(cause);
      await session.whenClosed();
      expect(session.closingCause()).toBe(cause);
      expect(session.status()).toBe('CLOSED');
      expect(browser.closeCount).toBe(1);
      expect(lockPresent()).toBe(false);
      const events = timeline();
      expect(events.map((e) => e.event)).toEqual([
        'LOCK_ACQUIRED',
        'LAUNCH_STARTED',
        'CONTEXT_OPENED',
        'OFFICIAL_START_CONFIRMED',
        'CLOSE_REQUESTED',
        'CONTEXT_CLOSE_OBSERVED',
        'CLOSE_CONFIRMED',
      ]);
      expect(events.slice(4).every((e) => e.cause === cause)).toBe(true);
      expect(events.at(-1)).toMatchObject({
        closeObserved: true,
        closeResult: 'RESOLVED',
        childExitInformation: 'UNAVAILABLE',
      });
      expect(
        events.every(
          (e, i) => i === 0 || e.elapsedMs >= events[i - 1]!.elapsedMs,
        ),
      ).toBe(true);
    } finally {
      detach();
      input.destroy();
    }
  },
);
it('retains locks when close resolves without an observed context close', async () => {
  const { session, browser } = await open();
  vi.spyOn(browser, 'close').mockResolvedValue(undefined);
  await expect(session.close()).rejects.toThrow(
    'OBSERVER_CLOSE_UNCONFIRMED_LOCKS_RETAINED',
  );
  expect(lockPresent()).toBe(true);
  expect(existsSync(join(profile, 'observer.lock'))).toBe(true);
  expect(timeline().at(-1)).toMatchObject({
    event: 'CLOSE_UNCONFIRMED_LOCKS_RETAINED',
    closeObserved: false,
    closeResult: 'RESOLVED',
  });
});
it('keeps the first close cause across competing signals and ignores late navigation', async () => {
  const { session, browser } = await open();
  const first = session.close('SIGINT');
  expect(session.close('SIGTERM')).toBe(first);
  browser.page.navigate('https://secret.example/?token=NEVER_LOG');
  browser.add(new Page());
  await first;
  expect(session.closingCause()).toBe('SIGINT');
  expect(session.status()).toBe('CLOSED');
  browser.page.navigate('https://late.example/?token=NEVER_LOG');
  browser.add(new Page());
  expect(session.status()).toBe('CLOSED');
  expect(session.stopReason()).toBeNull();
  expect(browser.closeCount).toBe(1);
  expect(JSON.stringify(timeline())).not.toContain('NEVER_LOG');
});
it('preserves expiry as the first cause when quit and late guards race it', async () => {
  vi.useFakeTimers();
  const { session, browser } = await open();
  await vi.advanceTimersByTimeAsync(3600000);
  await session.close('CLI_QUIT');
  browser.page.navigate('https://late.example/');
  expect(session.closingCause()).toBe('AUTHORIZATION_EXPIRED');
  expect(session.stopReason()).toBe('AUTHORIZATION_EXPIRED');
  expect(session.status()).toBe('QUARANTINED');
  expect(browser.closeCount).toBe(1);
});
it('does not let late navigation replace an unexpected-close cause or release locks', async () => {
  const { session, browser } = await open();
  browser.crash();
  browser.page.navigate('https://secret.example/?token=NEVER_LOG');
  browser.add(new Page());
  expect(session.closingCause()).toBe('UNEXPECTED_BROWSER_CLOSE');
  expect(session.stopReason()).toBe('UNEXPECTED_BROWSER_CLOSE');
  expect(lockPresent()).toBe(true);
  const json = JSON.stringify(timeline());
  expect(json).not.toContain('NEVER_LOG');
  expect(json).not.toContain(owner.ownerId);
  expect(json).not.toContain(profile);
  expect(timeline().at(-1)?.event).toBe('CONTEXT_CLOSE_OBSERVED');
});

it.each(['requested', 'unexpected'] as const)(
  'observes real Chromium context closure for a %s close on a synthetic signed-out page',
  async (kind) => {
    let context: BrowserContext | undefined;
    const session = await ManualInspectionSession.open({
      runtimeDirectory: runtime,
      profileDirectory: profile,
      ownerAuthorizesReadOnly: true,
      factory: async (directory) => {
        context = await chromium.launchPersistentContext(directory, {
          headless: true,
        });
        await context.route('**/*', (route) =>
          route.fulfill({
            contentType: 'text/html',
            body: '<h1>Signed-out lifecycle fixture</h1>',
          }),
        );
        return wrapManualBrowser(context);
      },
    });
    sessions.push(session);
    try {
      expect(session.status()).toBe('OPEN_FOR_MANUAL_SIGN_IN');
      expect(await context!.pages()[0]!.locator('h1').textContent()).toBe(
        'Signed-out lifecycle fixture',
      );
      if (kind === 'requested') {
        await session.close('CLI_QUIT');
        expect(session.status()).toBe('CLOSED');
        expect(lockPresent()).toBe(false);
      } else {
        await context!.close();
        await session.whenClosed();
        expect(session.stopReason()).toBe('UNEXPECTED_BROWSER_CLOSE');
        expect(lockPresent()).toBe(true);
      }
    } finally {
      await context?.close();
    }
  },
  // Match the native helper startup allowance used by the Windows suite.
  // This is the test deadline, not the observer's authorization or close policy.
  process.platform === 'win32' ? 60000 : 30000,
);
