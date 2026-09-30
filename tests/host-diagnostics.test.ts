import { spawnSync } from 'node:child_process';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import {
  existsSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
  symlinkSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { runHostCommand } from '../apps/dashboard/host.ts';
import { diagnoseHost } from '../apps/dashboard/src/host-diagnostics.ts';
import {
  machineBindingSync,
  protectedFileSync,
  publishPrivateFileSync,
} from '../packages/host/src/storage.ts';
import { privateRuntime } from './fixtures/runtime.ts';

let directory: string;
beforeEach(() => {
  directory = privateRuntime('vfc-doctor-');
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(directory, { recursive: true, force: true });
});
function identity(overrides = {}) {
  const saved = {
    ownerId: randomUUID(),
    instanceId: randomUUID(),
    machineHash: machineBindingSync(),
    runtimeDirectory: directory,
    state: 'ACTIVE',
    ...overrides,
  };
  publishPrivateFileSync(
    join(directory, 'identity.json'),
    JSON.stringify(saved),
  );
  return saved;
}
it('does not create storage or claim execution readiness for an uninitialized runtime', async () => {
  const path = join(directory, 'missing');
  const result = await diagnoseHost({ runtimeDirectory: path });
  expect(result.preflightPassed).toBe(true);
  expect(result.checks).toContainEqual({
    name: 'storage',
    status: 'INFO',
    code: 'NOT_INITIALIZED_START_LOCAL_DASHBOARD',
  });
  expect(result.executionReadiness).toBe('NOT_ESTABLISHED_BY_PREFLIGHT');
  expect(existsSync(path)).toBe(false);
  expect(readdirSync(directory)).toEqual([]);
});
it.skipIf(process.platform === 'win32')(
  'fails dangling runtime, identity and lock paths rather than reporting them missing',
  async () => {
    const missing = join(directory, 'missing');
    const runtime = join(directory, 'dangling-runtime');
    symlinkSync(missing, runtime, 'dir');
    expect(
      (await diagnoseHost({ runtimeDirectory: runtime })).preflightPassed,
    ).toBe(false);
    symlinkSync(missing, join(directory, 'identity.json'));
    expect(
      (await diagnoseHost({ runtimeDirectory: directory })).preflightPassed,
    ).toBe(false);
    rmSync(join(directory, 'identity.json'));
    identity();
    symlinkSync(missing, join(directory, 'controller.lock'));
    expect(
      (await diagnoseHost({ runtimeDirectory: directory })).preflightPassed,
    ).toBe(false);
  },
);
it('reports owner and active lock without opening the engine, rebinding or altering records', async () => {
  const saved = identity();
  const lock = JSON.stringify({ pid: process.pid, id: randomUUID() });
  publishPrivateFileSync(join(directory, 'controller.lock'), lock);
  const before = readFileSync(join(directory, 'identity.json'));
  const result = await diagnoseHost({ runtimeDirectory: directory });
  expect(result.preflightPassed).toBe(true);
  expect(result.identity).toEqual({
    ownerId: saved.ownerId,
    instanceId: saved.instanceId,
    state: 'ACTIVE',
  });
  expect(result.lock).toEqual({
    present: true,
    pid: process.pid,
    processPresent: true,
  });
  expect(result.executionReadiness).toBe('NOT_ESTABLISHED_BY_PREFLIGHT');
  expect(protectedFileSync(join(directory, 'controller.lock')).toString()).toBe(
    lock,
  );
  expect(readFileSync(join(directory, 'identity.json'))).toEqual(before);
  expect(readdirSync(directory).sort()).toEqual([
    'controller.lock',
    'identity.json',
  ]);
  expect(JSON.stringify(result)).not.toContain(saved.machineHash);
});
it('fails a moved identity without repairing the binding', async () => {
  identity({ runtimeDirectory: join(directory, 'different') });
  const before = readFileSync(join(directory, 'identity.json'));
  const result = await diagnoseHost({ runtimeDirectory: directory });
  expect(result.preflightPassed).toBe(false);
  expect(readFileSync(join(directory, 'identity.json'))).toEqual(before);
});
it('fails incomplete adoption without completing it or creating a journal', async () => {
  identity({ state: 'ADOPTING', legacyDatabases: ['existing.sqlite'] });
  const result = await diagnoseHost({ runtimeDirectory: directory });
  expect(result.preflightPassed).toBe(false);
  expect(result.checks).toContainEqual({
    name: 'identity',
    status: 'FAIL',
    code: 'ADOPTION_RECOVERY_REQUIRED',
  });
  expect(readdirSync(directory)).toEqual(['identity.json']);
});
it('redacts malformed private configuration and does not rewrite it', async () => {
  identity();
  const path = join(directory, 'private-access.json');
  const value = 'malformed-private-secret-must-not-appear';
  publishPrivateFileSync(path, value);
  const result = await diagnoseHost({
    runtimeDirectory: directory,
    privateConfigPath: path,
  });
  expect(result.preflightPassed).toBe(false);
  expect(JSON.stringify(result)).not.toContain(value);
  expect(readFileSync(path, 'utf8')).toBe(value);
});
it('runs the real doctor CLI with an explicit runtime and leaves records unchanged', () => {
  identity();
  const child = spawnSync(
    process.execPath,
    [
      '--import',
      'tsx',
      resolve('apps/dashboard/host.ts'),
      'doctor',
      '--runtime',
      directory,
    ],
    { encoding: 'utf8', timeout: 30_000 },
  );
  expect(child.error).toBeUndefined();
  expect(child.status).toBe(0);
  const result = JSON.parse(child.stdout);
  expect(result.runtimeDirectory).toBe(directory);
  expect(result.executionReadiness).toBe('NOT_ESTABLISHED_BY_PREFLIGHT');
  expect(readdirSync(directory)).toEqual(['identity.json']);
});
it('protects only an explicitly selected valid TLS key without printing its bytes', async () => {
  const path = join(directory, 'tls.key');
  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });
  writeFileSync(path, privateKey);
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  expect(await runHostCommand(['protect', '--path', path])).toBe(0);
  expect(protectedFileSync(path).toString()).toBe(privateKey);
  expect(JSON.stringify(log.mock.calls)).not.toContain(privateKey);
});
it('refuses to harden a journal or an invalid key masquerading as PEM', async () => {
  const record = join(directory, 'preserved.sqlite');
  const key = join(directory, 'invalid.pem');
  writeFileSync(record, 'runtime record');
  writeFileSync(key, 'invalid private key');
  await expect(runHostCommand(['protect', '--path', record])).rejects.toThrow();
  await expect(runHostCommand(['protect', '--path', key])).rejects.toThrow();
  expect(readFileSync(record, 'utf8')).toBe('runtime record');
  expect(readFileSync(key, 'utf8')).toBe('invalid private key');
});
