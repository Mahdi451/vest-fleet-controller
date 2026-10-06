import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  auditExecutionSource,
  assertPolicy,
} from '../scripts/security-policy.ts';
const root = process.cwd(),
  file = resolve(root, 'packages/browser-execution/src/managed-fixture.ts');
describe('reviewed offline managed fixture capability boundary', () => {
  it('permits only the reviewed fixture file to own a headless browser', () => {
    const source =
      "import { chromium } from 'playwright'; chromium.launchPersistentContext(profile, {headless:true});";
    expect(() => auditExecutionSource(source, file, root)).not.toThrow();
    expect(() =>
      auditExecutionSource(
        source,
        resolve(root, 'packages/browser-execution/src/other.ts'),
        root,
      ),
    ).toThrow();
  });
  it.each([
    'chromium.launchPersistentContext(profile,{headless:false})',
    'chromium.launchPersistentContext(profile,{...options,headless:true})',
    'chromium.connectOverCDP(endpoint)',
    'chromium.launchServer({headless:true})',
    "chromium['launch']({headless:false})",
    'const browser=chromium; browser.launch({headless:false})',
    'const launch=chromium.launchPersistentContext; launch(profile,{headless:false})',
    'chromium.launch.bind(chromium)({headless:false})',
    'chromium.launchPersistentContext(profile,{headless:true,headless:false})',
    "chromium.launchPersistentContext(profile,{headless:true,['headless']:false})",
    'chromium.launchPersistentContext(profile,{headless:true,get headless(){return false}})',
    "import { firefox } from 'playwright'; firefox.launch({headless:false})",
    "import { chromium as browser } from 'playwright'; browser.launch({headless:false})",
    "import browser from 'playwright'; browser.chromium.launch({headless:false})",
    "import * as browser from 'playwright'; browser.chromium.launch({headless:false})",
    "export { chromium } from 'playwright';",
  ])('rejects unreviewed browser launch/attachment %s', (source) => {
    expect(() => auditExecutionSource(source, file, root)).toThrow();
  });
  it('allows the fixed loopback prefix and rejects every other URL', () => {
    expect(() =>
      auditExecutionSource("const origin='http://127.0.0.1:';", file, root),
    ).not.toThrow();
    for (const url of [
      'https://next.vestmarkets.com',
      'http://localhost:1',
      'https://example.invalid',
      'http://127.0.0.1:9222',
    ])
      expect(() =>
        auditExecutionSource(`const origin='${url}';`, file, root),
      ).toThrow();
  });
  it('does not grant dynamic code capability through a benign typeof check', () => {
    expect(() =>
      auditExecutionSource(
        "const present = typeof handler === 'function';",
        file,
        root,
      ),
    ).not.toThrow();
    expect(() =>
      auditExecutionSource("new Function('return 1');", file, root),
    ).toThrow();
  });
  it('the managed fixture cannot be added to the inert production source or dependencies', () => {
    expect(() =>
      assertPolicy(
        'build-policy.json',
        JSON.stringify({
          version: 1,
          mode: 'LOCKED_OFFLINE_ONLY',
          entry: 'apps/local-trading/index.ts',
          sourceFiles: [
            'apps/local-trading/index.ts',
            'packages/browser-execution/src/managed-fixture.ts',
          ],
          artifactFiles: [],
          runtimeDependencies: ['playwright'],
        }),
      ),
    ).toThrow();
  });
});
