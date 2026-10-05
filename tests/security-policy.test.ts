import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  assertInertModule,
  assertPolicy,
  auditExecutionSource,
  auditRepository,
} from '../scripts/security-policy.ts';

describe('security containment policy', () => {
  it('audits protected execution sources and closed production graph', () => {
    expect(() => auditRepository(resolve('.'))).not.toThrow();
  });

  it.each([
    'const send = fetch; send("/orders");',
    'const xhr = new XMLHttpRequest();',
    'navigator.sendBeacon("/events", data);',
    'eval("code");',
    'new Function("return 1");',
    'import(variable);',
    'import "https://raw.githubusercontent.com/code.js";',
    'import { request } from "node:https";',
    'import "unknown-sdk";',
    'export * from "unknown-sdk";',
    'import x = require("unknown-sdk");',
    'const route = "/v3/capital/withdrawals";',
    'const route = "/v3/positions/open";',
    'const deposit = () => {};',
    'const wallet = "0x1234567890123456789012345678901234567890";',
    'const transferFunds = () => {};',
    'localStorage.setItem("accessToken", token);',
    'console.log(bearer);',
    'console.log(token);',
    'globalThis["localStorage"].setItem("session", secret);',
    'globalThis["fetch"]("/orders");',
    'const updateUrl = "https://github.com/release";',
    'const analytics = true;',
    'const downloadCode = () => {};',
    'const broken = ;',
  ])('rejects execution capability: %s', (source) => {
    expect(() => auditExecutionSource(source)).toThrow();
  });

  it.each([
    ['network-policy.json', 'approvedOrigins', ['https://api.github.com']],
    ['network-policy.json', 'enabledOrigins', ['https://next.vestmarkets.com']],
    [
      'network-policy.json',
      'vestApiRoutes',
      [{ method: 'GET', path: '/v3/accounts' }],
    ],
    [
      'network-policy.json',
      'vestWebSocketRoutes',
      ['wss://next.vestmarkets.com'],
    ],
    ['browser-policy.json', 'permissions', ['tabs']],
    [
      'browser-policy.json',
      'hostPermissions',
      ['https://next.vestmarkets.com/*'],
    ],
    ['browser-policy.json', 'automaticUpdates', true],
    ['build-policy.json', 'runtimeDependencies', ['playwright']],
    ['build-policy.json', 'sourceFiles', ['apps/dashboard/server.ts']],
  ])('requires review for %s %s', (name, key, value) => {
    const policy = JSON.parse(
      readFileSync(resolve('security', name as string), 'utf8'),
    );
    policy[key as string] = value;
    expect(() =>
      assertPolicy(name as string, JSON.stringify(policy)),
    ).toThrow();
  });

  it.each([
    'import "./other.js";',
    'import "node:child_process";',
    'const f = globalThis["fetch"];',
    'globalThis["fe" + "tch"]("https://example.org");',
    'process.exit();',
    'const script = document.createElement("script");',
    'export const mode = "LIVE";',
    'export const secrets = [];',
  ])('rejects any expansion of the inert module: %s', (extra) => {
    const entry = readFileSync(resolve('apps/local-trading/index.ts'), 'utf8');
    expect(() => assertInertModule(entry + '\n' + extra)).toThrow();
  });

  it('rejects refusing functions changed to invoke code', () => {
    const entry = readFileSync(resolve('apps/local-trading/index.ts'), 'utf8');
    expect(() =>
      assertInertModule(entry.replace('throw new Error', 'return fetch')),
    ).toThrow();
  });

  it('rejects unknown policy keys', () => {
    const policy = JSON.parse(
      readFileSync(resolve('security/browser-policy.json'), 'utf8'),
    );
    policy.extra = true;
    expect(() =>
      assertPolicy('browser-policy.json', JSON.stringify(policy)),
    ).toThrow();
  });

  it('rejects imports and reexports into unscanned application code', () => {
    for (const source of [
      'import "../../../apps/dashboard/server.ts";',
      'export * from "../../../apps/dashboard/server.ts";',
    ]) {
      expect(() =>
        auditExecutionSource(
          source,
          resolve('packages/execution/src/fixture.ts'),
          resolve('.'),
        ),
      ).toThrow('EXECUTION_IMPORT_ESCAPE');
    }
  });
});
