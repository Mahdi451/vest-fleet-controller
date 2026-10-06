import { chromium, type BrowserContext } from 'playwright';
import { vi } from 'vitest';
/** Test-only launch observation; the production-facing fixture API exposes no handles. */
export function observeManagedLaunch() {
  const original = chromium.launchPersistentContext.bind(chromium);
  let context: BrowserContext | undefined, profile: string | undefined;
  const launch = vi
    .spyOn(chromium, 'launchPersistentContext')
    .mockImplementation(async (directory, options) => {
      profile = directory;
      context = await original(directory, options);
      return context;
    });
  return {
    launch,
    context: () => context!,
    profile: () => profile!,
    restore: () => launch.mockRestore(),
  };
}
