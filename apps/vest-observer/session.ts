import type { BrowserContext, Page } from 'playwright';
import {
  assertObservationAuthorization,
  observationAuthorizationSchema,
  type ObservationAuthorization,
} from '../../packages/browser-execution/src/authorization.ts';
import { publishPrivateFileSync } from '../../packages/host/src/storage.ts';
import { join } from 'node:path';
import { acquireObserverProfile } from './profile.ts';

export const VEST_OFFICIAL_START = 'https://next.vestmarkets.com/';
const allowedOrigin = new URL(VEST_OFFICIAL_START).origin;
type ProfileLease = Awaited<ReturnType<typeof acquireObserverProfile>>;
export interface ManualBrowser {
  pages(): readonly ManualPage[];
  newPage(): Promise<ManualPage>;
  onPage(callback: (page: ManualPage) => void): void;
  onClosed(callback: () => void): void;
  close(): Promise<void>;
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
  private expiration: ReturnType<typeof setTimeout> | undefined;
  private readonly completed: Promise<void>;
  private complete!: () => void;
  private constructor(
    private readonly lease: ProfileLease,
    private readonly authorization: ObservationAuthorization,
    private readonly clock: () => number,
  ) {
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
      publishPrivateFileSync(
        join(lease.directory, 'owner-authorization.json'),
        JSON.stringify(authorization),
        true,
      );
      session.browser = await (options.factory ?? headedBrowser)(
        lease.chromiumDirectory,
      );
      await session.initialize();
      return session;
    } catch {
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
  private async initialize() {
    const browser = this.browser!;
    browser.onClosed(() => {
      // Unexpected closure/crash is not proof every browser child has stopped.
      if (!this.closing) {
        this.closureAmbiguous = true;
        this.state = 'QUARANTINED';
        this.reason = 'UNEXPECTED_BROWSER_CLOSE';
        if (this.expiration) clearTimeout(this.expiration);
        this.complete();
      }
    });
    if (this.closureAmbiguous) throw new Error('OBSERVER_ALREADY_CLOSED');
    let primary: ManualPage | null = null;
    browser.onPage((page) => {
      if (primary !== null && page !== primary)
        void this.quarantine('EXTRA_PAGE').catch(() => {});
    });
    if (browser.pages().length > 1)
      throw new Error('OBSERVER_REQUIRES_ONE_PAGE');
    primary = browser.pages()[0] ?? (await browser.newPage());
    const page = primary;
    const verifyNavigation = () => {
      try {
        if (new URL(page.url()).origin !== allowedOrigin)
          void this.quarantine('UNREVIEWED_NAVIGATION').catch(() => {});
      } catch {
        void this.quarantine('UNREVIEWED_NAVIGATION').catch(() => {});
      }
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
      void this.quarantine('AUTHORIZATION_EXPIRED').catch(() => {});
    }, this.authorization.expiresAt - this.clock());
    this.state = 'OPEN_FOR_MANUAL_SIGN_IN';
  }
  acknowledgeManualInspection() {
    assertObservationAuthorization(
      this.authorization,
      this.lease.binding,
      this.clock(),
    );
    if (this.state !== 'OPEN_FOR_MANUAL_SIGN_IN')
      throw new Error('MANUAL_OBSERVER_NOT_OPEN');
    // Operator acknowledgement is never authentication/account/evidence verification.
    this.state = 'MANUAL_INSPECTION_ACKNOWLEDGED';
  }
  private quarantine(reason: InspectionStopReason) {
    this.reason ??= reason;
    this.state = 'QUARANTINED';
    return this.close(true);
  }
  close(quarantined = false): Promise<void> {
    if (this.closureAmbiguous)
      return Promise.reject(
        new Error('OBSERVER_CLOSE_UNCONFIRMED_LOCKS_RETAINED'),
      );
    if (this.closing) return this.closing;
    if (this.expiration) clearTimeout(this.expiration);
    this.closing = Promise.resolve()
      .then(async () => {
        await this.browser!.close(); // Failure preserves locks and prevents takeover.
        this.lease.release();
        this.state = quarantined ? 'QUARANTINED' : 'CLOSED';
        this.complete();
      })
      .catch(() => {
        this.state = 'QUARANTINED';
        this.reason = 'CLOSE_UNCONFIRMED';
        this.complete();
        throw new Error('OBSERVER_CLOSE_UNCONFIRMED_LOCKS_RETAINED');
      });
    return this.closing;
  }
}
