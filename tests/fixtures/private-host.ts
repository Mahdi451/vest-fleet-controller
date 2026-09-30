import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  PrivateAccess,
  machineBinding,
  secretVerifier,
  type PrivateAccessConfig,
} from '../../apps/dashboard/src/private-access.ts';

import { loadLocalIdentity } from '../../apps/dashboard/src/identity.ts';
import {
  ensurePrivateDirectory,
  protectDirectory,
  protectFile,
} from '../../packages/host/src/storage.ts';

function opensslExecutable(): string {
  const candidates = ['openssl'];
  if (process.platform === 'win32') {
    // Git for Windows bundles OpenSSL, but its executable is not always on PATH.
    for (const root of [
      process.env.ProgramFiles,
      process.env['ProgramFiles(x86)'],
    ]) {
      if (root) {
        candidates.push(
          join(root, 'Git', 'usr', 'bin', 'openssl.exe'),
          join(root, 'Git', 'mingw64', 'bin', 'openssl.exe'),
        );
      }
    }
  }
  for (const candidate of candidates) {
    try {
      execFileSync(candidate, ['version'], { stdio: 'ignore' });
      return candidate;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  throw new Error(
    'Private HTTPS test fixtures require OpenSSL on PATH or Git for Windows with bundled OpenSSL',
  );
}

/** Isolated TLS fixture. Localhost is deliberately permitted only by direct test construction. */
export async function privateHost(
  options: { now?: () => number; sessionDurationMs?: number } = {},
) {
  const directory = await realpath(
    await mkdtemp(join(tmpdir(), 'vfc-private-')),
  );
  await protectDirectory(directory);
  await ensurePrivateDirectory(directory);
  const certPath = join(directory, 'cert.pem'),
    keyPath = join(directory, 'key.pem');
  execFileSync(
    opensslExecutable(),
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      keyPath,
      '-out',
      certPath,
      '-days',
      '1',
      '-subj',
      '/CN=localhost',
      '-addext',
      'subjectAltName=DNS:localhost,IP:127.0.0.1',
    ],
    { stdio: 'ignore' },
  );
  await protectFile(keyPath);
  const secret = 'fixture-only-secret-with-more-than-32-bytes';
  const config: PrivateAccessConfig = {
    version: 1,
    active: true,
    origin: 'https://localhost:4173',
    bindAddress: '127.0.0.1',
    port: 4173,
    ...(await loadLocalIdentity(directory)),
    runtimeDirectory: directory,
    machineHash: await machineBinding(),
    certPath,
    keyPath,
    ...secretVerifier(secret),
  };
  const tls = {
    cert: await readFile(certPath),
    key: await readFile(keyPath),
    minVersion: 'TLSv1.2' as const,
  };
  return {
    directory,
    config,
    secret,
    tls,
    access: new PrivateAccess(config, tls, options),
    dispose: () => rm(directory, { recursive: true, force: true }),
  };
}
