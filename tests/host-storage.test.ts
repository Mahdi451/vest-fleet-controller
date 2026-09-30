import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  linkSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  canonicalRuntime,
  ensurePrivateDirectory,
  ensurePrivateDirectorySync,
  machineBinding,
  machineBindingSync,
  protectedFile,
  protectedFileSync,
  protectFile,
  protectFileSync,
  publishPrivateFileSync,
  removeOwnedPrivateFileSync,
  validateRuntimeDirectorySync,
  validateRuntimeFileSync,
  writeExclusivePrivateFileSync,
} from '../packages/host/src/storage.ts';
import { SimulationStore } from '../packages/simulator/src/storage.ts';
import { grantEveryoneRead, privateRuntime } from './fixtures/runtime.ts';

let directory: string;
beforeEach(() => {
  directory = privateRuntime('vfc-host-storage-');
});
afterEach(() => rmSync(directory, { recursive: true, force: true }));

function powershell(script: string, path?: string): string {
  return execFileSync(
    join(
      process.env.SystemRoot!,
      'System32',
      'WindowsPowerShell',
      'v1.0',
      'powershell.exe',
    ),
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script],
    {
      encoding: 'utf8',
      env: { ...process.env, VFC_TEST_PATH: path ?? '' },
      timeout: 30_000,
    },
  ).trim();
}

describe('native host storage', () => {
  it('binds to the actual machine identifier consistently without an invented identity', async () => {
    let source: string;
    if (process.platform === 'linux') {
      source = readFileSync('/etc/machine-id', 'utf8').trim();
      expect(source).toMatch(/^[a-f0-9]{32}$/i);
    } else if (process.platform === 'darwin') {
      const report = execFileSync(
        '/usr/sbin/ioreg',
        ['-rd1', '-c', 'IOPlatformExpertDevice'],
        { encoding: 'utf8' },
      );
      const uuid = /"IOPlatformUUID"\s*=\s*"([a-f0-9-]+)"/i.exec(report)?.[1];
      expect(uuid).toBeTruthy();
      source = `darwin:${uuid!.toLowerCase()}`;
    } else {
      const uuid = powershell(
        "$hive = [Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::LocalMachine, [Microsoft.Win32.RegistryView]::Registry64); $key = $hive.OpenSubKey('SOFTWARE\\Microsoft\\Cryptography'); $key.GetValue('MachineGuid'); $key.Dispose(); $hive.Dispose()",
      );
      expect(uuid).toMatch(
        /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i,
      );
      source = `win32:${uuid.toLowerCase()}`;
    }
    const expected = createHash('sha256').update(source).digest('hex');
    expect(machineBindingSync()).toBe(expected);
    expect(await machineBinding()).toBe(expected);
    expect(machineBindingSync()).toMatch(/^[a-f0-9]{64}$/);
  });

  it('creates and validates private canonical directories through both entry points', async () => {
    expect(directory).toBe(canonicalRuntime(directory));
    const sync = join(directory, 'sync'),
      async = join(directory, 'async');
    ensurePrivateDirectorySync(sync);
    await ensurePrivateDirectory(async);
    for (const path of [directory, sync, async]) {
      expect(() => validateRuntimeDirectorySync(path)).not.toThrow();
      if (process.platform !== 'win32') {
        expect(statSync(path).mode & 0o777).toBe(0o700);
        expect(statSync(path).uid).toBe(process.getuid!());
      }
    }
  });

  it('rejects an unsafe existing runtime without repairing or deleting its records', () => {
    const path = join(directory, 'unsafe');
    ensurePrivateDirectorySync(path);
    const record = join(path, 'preserved.json');
    publishPrivateFileSync(record, 'preserved');
    if (process.platform === 'win32') grantEveryoneRead(path);
    else chmodSync(path, 0o755);
    expect(() => validateRuntimeDirectorySync(path)).toThrow();
    expect(() => ensurePrivateDirectorySync(path)).toThrow();
    expect(readFileSync(record, 'utf8')).toBe('preserved');
    if (process.platform !== 'win32')
      expect(statSync(path).mode & 0o777).toBe(0o755);
  });

  it('reads only protected regular files and rejects hardlinks and directories', async () => {
    const file = join(directory, 'key'),
      alias = join(directory, 'alias');
    writeFileSync(file, 'private bytes');
    await protectFile(file);
    expect(await protectedFile(file)).toEqual(Buffer.from('private bytes'));
    expect(protectedFileSync(file)).toEqual(Buffer.from('private bytes'));
    expect(() => validateRuntimeFileSync(file)).not.toThrow();
    if (process.platform !== 'win32') {
      expect(statSync(file).uid).toBe(process.getuid!());
      expect(statSync(file).mode & 0o777).toBe(0o600);
    }
    expect(() => protectedFileSync(directory)).toThrow();
    linkSync(file, alias);
    expect(() => protectedFileSync(file)).toThrow();
    expect(() => protectedFileSync(alias)).toThrow();
    expect(() => protectFileSync(alias)).toThrow();
    expect(readFileSync(file, 'utf8')).toBe('private bytes');
  });

  it('rejects public read access even when the file otherwise remains valid', async () => {
    const file = join(directory, 'public-key');
    publishPrivateFileSync(file, 'private');
    if (process.platform === 'win32') grantEveryoneRead(file);
    else chmodSync(file, 0o644);
    expect(() => protectedFileSync(file)).toThrow();
    await expect(protectedFile(file)).rejects.toThrow();
    expect(readFileSync(file, 'utf8')).toBe('private');
  });

  it.skipIf(process.platform === 'win32')(
    'rejects symlink files and runtime directories',
    () => {
      const file = join(directory, 'key');
      publishPrivateFileSync(file, 'private');
      const fileLink = join(directory, 'key-link'),
        directoryLink = join(directory, 'directory-link');
      symlinkSync(file, fileLink);
      symlinkSync(directory, directoryLink, 'dir');
      expect(() => protectedFileSync(fileLink)).toThrow();
      expect(() =>
        publishPrivateFileSync(fileLink, 'replacement', true),
      ).toThrow();
      const dangling = join(directory, 'dangling-link');
      symlinkSync(join(directory, 'missing'), dangling);
      expect(() =>
        publishPrivateFileSync(dangling, 'replacement', true),
      ).toThrow();
      expect(() => protectFileSync(fileLink)).toThrow();
      expect(() => validateRuntimeDirectorySync(directoryLink)).toThrow();
      expect(() => ensurePrivateDirectorySync(directoryLink)).toThrow();
    },
  );

  it('durably publishes the first writer, preserves it on collision, and safely replaces it', () => {
    const path = join(directory, 'identity.json');
    expect(publishPrivateFileSync(path, 'first')).toBe(true);
    expect(publishPrivateFileSync(path, 'second')).toBe(false);
    expect(protectedFileSync(path).toString()).toBe('first');
    expect(publishPrivateFileSync(path, Buffer.from('replacement'), true)).toBe(
      true,
    );
    expect(protectedFileSync(path).toString()).toBe('replacement');
    expect(readdirSync(directory)).toEqual(['identity.json']);
    if (process.platform !== 'win32')
      expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it('rejects publication onto an unsafe record and preserves its bytes and protection state', () => {
    const path = join(directory, 'unsafe-record');
    publishPrivateFileSync(path, 'authoritative');
    if (process.platform === 'win32') grantEveryoneRead(path);
    else chmodSync(path, 0o644);
    expect(() => publishPrivateFileSync(path, 'collision')).toThrow();
    expect(() => publishPrivateFileSync(path, 'replacement', true)).toThrow();
    expect(readFileSync(path, 'utf8')).toBe('authoritative');
    expect(() => protectedFileSync(path)).toThrow();
    expect(readdirSync(directory)).toEqual(['unsafe-record']);
    if (process.platform !== 'win32')
      expect(statSync(path).mode & 0o777).toBe(0o644);
  });

  it('preserves foreign and stale exclusive locks until their actual owner removes them', () => {
    const path = join(directory, 'controller.lock'),
      stale = JSON.stringify({ pid: 999999999, id: 'stale' });
    expect(writeExclusivePrivateFileSync(path, stale)).toBe(true);
    expect(writeExclusivePrivateFileSync(path, 'foreign')).toBe(false);
    expect(removeOwnedPrivateFileSync(path, 'foreign')).toBe(false);
    expect(protectedFileSync(path).toString()).toBe(stale);
    expect(() => new SimulationStore(directory)).toThrow(
      'SIMULATION_STORE_LOCKED',
    );
    expect(protectedFileSync(path).toString()).toBe(stale);
    expect(removeOwnedPrivateFileSync(path, stale)).toBe(true);
    expect(removeOwnedPrivateFileSync(path, stale)).toBe(false);
  });

  it('cannot delete a replacement lock when the former store owner closes', () => {
    const store = new SimulationStore(directory),
      path = join(directory, 'controller.lock');
    const former = protectedFileSync(path).toString();
    unlinkSync(path);
    const replacement = JSON.stringify({ pid: process.pid, id: 'replacement' });
    expect(writeExclusivePrivateFileSync(path, replacement)).toBe(true);
    expect(removeOwnedPrivateFileSync(path, former)).toBe(false);
    store.close();
    expect(protectedFileSync(path).toString()).toBe(replacement);
    expect(() => new SimulationStore(directory)).toThrow(
      'SIMULATION_STORE_LOCKED',
    );
  });

  it.skipIf(process.platform !== 'darwin')(
    'rejects real macOS extended allow ACLs despite owner-only mode bits',
    () => {
      const file = join(directory, 'acl-key'),
        runtime = join(directory, 'acl-runtime');
      publishPrivateFileSync(file, 'private');
      ensurePrivateDirectorySync(runtime);
      execFileSync('/bin/chmod', ['+a', 'everyone allow read', file]);
      execFileSync('/bin/chmod', ['+a', 'everyone allow read,search', runtime]);
      expect(statSync(file).mode & 0o777).toBe(0o600);
      expect(statSync(runtime).mode & 0o777).toBe(0o700);
      expect(() => protectedFileSync(file)).toThrow(
        'HOST_EXTENDED_ACL_REJECTED',
      );
      expect(() => validateRuntimeDirectorySync(runtime)).toThrow(
        'HOST_EXTENDED_ACL_REJECTED',
      );
      expect(() => ensurePrivateDirectorySync(runtime)).toThrow(
        'HOST_EXTENDED_ACL_REJECTED',
      );
      expect(readFileSync(file, 'utf8')).toBe('private');
    },
  );

  it.skipIf(process.platform !== 'darwin')(
    'accepts a clean native macOS write with F_FULLFSYNC durability',
    () => {
      const path = join(directory, 'flushed.json');
      expect(publishPrivateFileSync(path, 'flushed')).toBe(true);
      expect(protectedFileSync(path).toString()).toBe('flushed');
      expect(
        writeExclusivePrivateFileSync(join(directory, 'flushed.lock'), 'owner'),
      ).toBe(true);
    },
  );

  it.skipIf(process.platform !== 'win32')(
    'uses the current Windows SID and a protected native DACL for private files',
    () => {
      const path = join(directory, 'sid-key');
      publishPrivateFileSync(path, 'private');
      const security = JSON.parse(
        powershell(
          '$acl = Get-Acl -LiteralPath $env:VFC_TEST_PATH; @{ owner = $acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value; current = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value; protected = $acl.AreAccessRulesProtected } | ConvertTo-Json -Compress',
          path,
        ),
      );
      expect(security.owner).toBe(security.current);
      expect(security.protected).toBe(true);
      expect(protectedFileSync(path).toString()).toBe('private');
      grantEveryoneRead(path);
      expect(() => protectedFileSync(path)).toThrow();
    },
  );

  it.skipIf(process.platform !== 'win32')(
    'rejects native Windows junctions before accepting runtime data',
    () => {
      const target = join(directory, 'real-runtime'),
        junction = join(directory, 'junction-runtime');
      ensurePrivateDirectorySync(target);
      publishPrivateFileSync(join(target, 'identity.json'), 'preserved');
      symlinkSync(target, junction, 'junction');
      expect(() => validateRuntimeDirectorySync(junction)).toThrow();
      expect(() => ensurePrivateDirectorySync(junction)).toThrow();
      expect(() =>
        protectedFileSync(join(junction, 'identity.json')),
      ).toThrow();
      expect(protectedFileSync(join(target, 'identity.json')).toString()).toBe(
        'preserved',
      );
    },
  );
});
