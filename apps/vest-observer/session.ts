import type { BrowserContext, Page } from 'playwright';
import {
  assertObservationAuthorization,
  observationAuthorizationSchema,
  type ObservationAuthorization,
} from '../../packages/browser-execution/src/authorization.ts';
import { publishPrivateFileSync } from '../../packages/host/src/storage.ts';
import { join } from 'node:path';
import { acquireObserverProfile } from './profile.ts';
import {
  ObserverLifecycle,
  type InspectionCloseCause,
  type LifecycleEvent,
} from './lifecycle.ts';

export const VEST_OFFICIAL_START = 'https://next.vestmarkets.com/';
/** Exact origin observed on 2026-10-02 for the same-page Google button. */
export const VEST_SIGN_IN_ORIGIN = 'https://accounts.google.com';
export const manualBrowserLaunchArgs = [
  '--hide-crash-restore-bubble',
  '--disable-session-crashed-bubble',
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-notifications',
  '--disable-sync',
  '--disable-search-engine-choice-screen',
  '--disable-prompt-on-repost',
  '--window-position=40,40',
  '--window-size=1200,720',
  '--disable-features=InfiniteSessionRestore,Translate,DiceWebSigninIntercept',
] as const;
const allowedOrigin = new URL(VEST_OFFICIAL_START).origin;
type ProfileLease = Awaited<ReturnType<typeof acquireObserverProfile>>;
export interface ManualBrowser {
  pages(): readonly ManualPage[];
  newPage(): Promise<ManualPage>;
  onPage(callback: (page: ManualPage) => void): void;
  onClosed(callback: () => void): void;
  close(): Promise<void>;
  version?(): string | null;
}
export interface ManualPage {
  url(): string;
  openOfficialStart(): Promise<void>;
  onMainNavigation(callback: () => void): void;
}
export type ManualBrowserFactory = (
  privateProfile: string,
) => Promise<ManualBrowser>;

/** The only real browser operations: launch, official navigation, lifecycle guards,
 * close. There are no credential, account-selector, evidence-export or order APIs. */
export async function headedBrowser(
  privateProfile: string,
): Promise<ManualBrowser> {
  const { chromium } = await import('playwright');
  const context = await chromium.launchPersistentContext(privateProfile, {
    headless: false,
    acceptDownloads: false,
    timeout: 30000,
    viewport: null,
    args: [...manualBrowserLaunchArgs],
  });
  return wrapManualBrowser(context);
}
export function wrapManualBrowser(context: BrowserContext): ManualBrowser {
  let closed = context.browser()?.isConnected() === false;
  const closedListeners = new Set<() => void>();
  context.on('close', () => {
    closed = true;
    for (const callback of closedListeners) callback();
  });
  const pages = new WeakMap<Page, ManualPage>();
  const wrap = (page: Page): ManualPage => {
    let value = pages.get(page);
    if (!value) {
      value = {
        url: () => page.url(),
        openOfficialStart: async () => {
          await page.goto(VEST_OFFICIAL_START, {
            waitUntil: 'domcontentloaded',
            timeout: 30000,
          });
        },
        onMainNavigation: (callback) => {
          page.on('framenavigated', (frame) => {
            if (frame === page.mainFrame()) callback();
          });
        },
      };
      pages.set(page, value);
    }
    return value;
  };
  return {
    pages: () => context.pages().map(wrap),
    newPage: async () => wrap(await context.newPage()),
    onPage: (callback) => {
      context.on('page', (page) => callback(wrap(page)));
    },
    onClosed: (callback) => {
      closedListeners.add(callback);
      if (closed) callback();
    },
    close: () => context.close(),
    version: () => context.browser()?.version() ?? null,
  };
}
export type ManualInspectionState =
  | 'STARTING'
  | 'OPEN_FOR_MANUAL_SIGN_IN'
  | 'MANUAL_INSPECTION_ACKNOWLEDGED'
  | 'QUARANTINED'
  | 'CLOSED';
export type InspectionStopReason =
  | 'UNEXPECTED_BROWSER_CLOSE'
  | 'EXTRA_PAGE'
  | 'UNREVIEWED_NAVIGATION'
  | 'AUTHORIZATION_EXPIRED'
  | 'START_UNVERIFIED'
  | 'CLOSE_UNCONFIRMED';

export class ManualInspectionSession {
  private state: ManualInspectionState = 'STARTING';
  private reason: InspectionStopReason | null = null;
  private browser: ManualBrowser | null = null;
  private closing: Promise<void> | null = null;
  private closureAmbiguous = false;
  private closeObserved = false;
  private closeCause: InspectionCloseCause | null = null;
  private closeResult: LifecycleEvent['closeResult'] = 'UNAVAILABLE';
  private readonly lifecycle: ObserverLifecycle;
  private expiration: ReturnType<typeof setTimeout> | undefined;
  private primary: ManualPage | null = null;
  private readonly completed: Promise<void>;
  private complete!: () => void;
  private constructor(
    private readonly lease: ProfileLease,
    private readonly authorization: ObservationAuthorization,
    private readonly clock: () => number,
  ) {
    this.lifecycle = new ObserverLifecycle(lease.directory);
    this.completed = new Promise((resolve) => {
      this.complete = resolve;
    });
  }
  static async open(options: {
    runtimeDirectory: string;
    profileDirectory: string;
    ownerAuthorizesReadOnly: boolean;
    factory?: ManualBrowserFactory;
    clock?: () => number;
  }) {
    if (options.ownerAuthorizesReadOnly !== true)
      throw new Error('OWNER_READ_ONLY_AUTHORIZATION_REQUIRED');
    const lease = await acquireObserverProfile(
      options.runtimeDirectory,
      options.profileDirectory,
    );
    const clock = options.clock ?? Date.now;
    const authorization = observationAuthorizationSchema.parse({
      ownerId: lease.binding.ownerId,
      instanceId: lease.binding.instanceId,
      reference: 'OWNER_CLI_READ_ONLY_OPT_IN',
      basis: 'USER_OWNER_AUTHORIZATION',
      termsReviewReference:
        'docs/vest-facts.md#owner-authorized-read-only-review--2026-10-01',
      scope: 'READ_ONLY_OWNER_ACCOUNTS',
      approvedAt: clock(),
      expiresAt: clock() + 3600000,
      revoked: false,
    });
    const session = new ManualInspectionSession(lease, authorization, clock);
    try {
      session.record('LOCK_ACQUIRED');
      if (!session.diagnosticsAvailable())
        throw new Error('OBSERVER_DIAGNOSTICS_UNAVAILABLE');
      publishPrivateFileSync(
        join(lease.directory, 'owner-authorization.json'),
        JSON.stringify(authorization),
        true,
      );
      session.record('LAUNCH_STARTED');
      session.browser = await (options.factory ?? headedBrowser)(
        lease.chromiumDirectory,
      );
      await session.initialize();
      return session;
    } catch {
      session.record('START_FAILED');
      if (session.browser)
        await session.quarantine('START_UNVERIFIED').catch(() => {});
      // A failed launch without an authoritative context handle is ambiguous.
      // Preserve both locks rather than permit another potentially live browser.
      throw new Error('MANUAL_OBSERVER_START_FAILED_REVIEW_LOCKS');
    }
  }
  status() {
    return this.state;
  }
  stopReason() {
    return this.reason;
  }
  whenClosed() {
    return this.completed;
  }
  closingCause() {
    return this.closeCause;
  }
  diagnosticsAvailable() {
    return this.lifecycle.isAvailable();
  }
  private record(event: LifecycleEvent['event']) {
    return this.lifecycle.record({
      event,
      state: this.state,
      cause: this.closeCause,
      browserVersion: this.browser?.version?.() ?? null,
      closeObserved: this.closeObserved,
      closeResult: this.closeResult,
    });
  }
  private active() {
    return (
      !this.closing &&
      !this.closureAmbiguous &&
      (this.state === 'STARTING' ||
        this.state === 'OPEN_FOR_MANUAL_SIGN_IN' ||
        this.state === 'MANUAL_INSPECTION_ACKNOWLEDGED')
    );
  }
  private async initialize() {
    const browser = this.browser!;
    browser.onClosed(() => {
      if (this.closeObserved) return;
      this.closeObserved = true;
      // Unexpected closure/crash is not proof every browser child has stopped.
      if (!this.closing) {
        this.closureAmbiguous = true;
        this.state = 'QUARANTINED';
        this.reason = 'UNEXPECTED_BROWSER_CLOSE';
        this.closeCause ??= 'UNEXPECTED_BROWSER_CLOSE';
        if (this.expiration) clearTimeout(this.expiration);
        this.record('CONTEXT_CLOSE_OBSERVED');
        this.complete();
      } else this.record('CONTEXT_CLOSE_OBSERVED');
    });
    if (this.closureAmbiguous) throw new Error('OBSERVER_ALREADY_CLOSED');
    this.record('CONTEXT_OPENED');
    browser.onPage((page) => {
      if (this.active() && this.primary !== null && page !== this.primary)
        void this.quarantine('EXTRA_PAGE').catch(() => {});
    });
    if (browser.pages().length > 1)
      throw new Error('OBSERVER_REQUIRES_ONE_PAGE');
    this.primary = browser.pages()[0] ?? (await browser.newPage());
    const page = this.primary;
    const verifyNavigation = () => {
      if (!this.active()) return;
      let origin: string;
      try {
        origin = new URL(page.url()).origin;
      } catch {
        void this.quarantine('UNREVIEWED_NAVIGATION').catch(() => {});
        return;
      }
      if (!this.originAllowed(origin))
        void this.quarantine('UNREVIEWED_NAVIGATION').catch(() => {});
    };
    page.onMainNavigation(verifyNavigation);
    await page.openOfficialStart();
    if (
      this.state !== 'STARTING' ||
      browser.pages().length !== 1 ||
      new URL(page.url()).origin !== allowedOrigin
    )
      throw new Error('OBSERVER_NAVIGATION_UNVERIFIED');
    assertObservationAuthorization(
      this.authorization,
      this.lease.binding,
      this.clock(),
    );
    this.expiration = setTimeout(() => {
      if (this.active())
        void this.quarantine('AUTHORIZATION_EXPIRED').catch(() => {});
    }, this.authorization.expiresAt - this.clock());
    this.state = 'OPEN_FOR_MANUAL_SIGN_IN';
    this.record('OFFICIAL_START_CONFIRMED');
  }
  private originAllowed(origin: string) {
    if (origin === allowedOrigin) return true;
    // Google is permitted only while the owner is still signing in, and only for
    // the one observed same-page origin. Acknowledgement locks the page to Vest.
    return (
      this.state === 'OPEN_FOR_MANUAL_SIGN_IN' && origin === VEST_SIGN_IN_ORIGIN
    );
  }
  acknowledgeManualInspection() {
    assertObservationAuthorization(
      this.authorization,
      this.lease.binding,
      this.clock(),
    );
    if (this.state !== 'OPEN_FOR_MANUAL_SIGN_IN')
      throw new Error('MANUAL_OBSERVER_NOT_OPEN');
    let origin = '';
    try {
      origin = new URL(this.primary?.url() ?? '').origin;
    } catch {
      origin = '';
    }
    if (origin !== allowedOrigin) throw new Error('VEST_RETURN_REQUIRED');
    // Operator acknowledgement is never authentication/account/evidence verification.
    this.state = 'MANUAL_INSPECTION_ACKNOWLEDGED';
  }
  private quarantine(
    reason: Exclude<InspectionStopReason, 'CLOSE_UNCONFIRMED'>,
  ) {
    if (!this.active()) return this.closing ?? Promise.resolve();
    this.reason ??= reason;
    this.state = 'QUARANTINED';
    return this.close(reason, true);
  }
  close(
    cause: InspectionCloseCause = 'CLI_QUIT',
    quarantined = false,
  ): Promise<void> {
    if (this.closureAmbiguous)
      return Promise.reject(
        new Error('OBSERVER_CLOSE_UNCONFIRMED_LOCKS_RETAINED'),
      );
    if (this.closing) return this.closing;
    if (this.expiration) clearTimeout(this.expiration);
    this.closeCause ??= cause;
    this.closeResult = 'PENDING';
    this.record('CLOSE_REQUESTED');
    this.closing = Promise.resolve()
      .then(async () => {
        // Closing the window keeps the Chromium profile. Vest/Google cookies stay
        // on disk; this is not a Vest logout.
        await this.browser!.close(); // Failure preserves locks and prevents takeover.
        this.closeResult = 'RESOLVED';
        if (!this.closeObserved) throw new Error('CONTEXT_CLOSE_NOT_OBSERVED');
        this.lease.release();
        this.state = quarantined ? 'QUARANTINED' : 'CLOSED';
        this.record('CLOSE_CONFIRMED');
        this.complete();
      })
      .catch(() => {
        this.state = 'QUARANTINED';
        this.reason ??= 'CLOSE_UNCONFIRMED';
        if (this.closeResult === 'PENDING') this.closeResult = 'REJECTED';
        this.record('CLOSE_UNCONFIRMED_LOCKS_RETAINED');
        this.complete();
        throw new Error('OBSERVER_CLOSE_UNCONFIRMED_LOCKS_RETAINED');
      });
    return this.closing;
  }
}
