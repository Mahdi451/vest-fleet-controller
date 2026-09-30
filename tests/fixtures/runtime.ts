import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  canonicalRuntime,
  protectDirectory,
  protectDirectorySync,
  protectFile,
  protectFileSync,
} from '../../packages/host/src/storage.ts';

/** Harden only fresh test directories, then use the OS's canonical path. */
export function privateRuntime(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  protectDirectorySync(directory);
  return canonicalRuntime(directory);
}
export async function privateRuntimeAsync(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  await protectDirectory(directory);
  return canonicalRuntime(directory);
}

/** Deliberately grant a real Windows ACL in negative security tests. */
export function grantEveryoneRead(path: string): void {
  if (process.platform !== 'win32') throw new Error('WINDOWS_TEST_ONLY');
  execFileSync(join(process.env.SystemRoot!, 'System32', 'icacls.exe'), [
    path,
    '/grant',
    '*S-1-1-0:(RX)',
  ]);
}

/** Existing-format fixture records keep their content and receive native protection. */
export async function writeFixtureFile(
  path: string,
  data: string | Uint8Array,
  options?: { mode: number },
): Promise<void> {
  await writeFile(path, data, options);
  await protectFile(path);
}
export function writeFixtureFileSync(
  path: string,
  data: string | Uint8Array,
): void {
  writeFileSync(path, data, { mode: 0o600 });
  protectFileSync(path);
}
