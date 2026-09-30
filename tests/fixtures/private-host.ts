import { execFileSync } from 'node:child_process';
import { chmod, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  PrivateAccess,
  machineBinding,
  secretVerifier,
  type PrivateAccessConfig,
} from '../../apps/dashboard/src/private-access.ts';

import { loadLocalIdentity } from '../../apps/dashboard/src/identity.ts';

/** Isolated TLS fixture. Localhost is deliberately permitted only by direct test construction. */
export async function privateHost(
  options: { now?: () => number; sessionDurationMs?: number } = {},
) {
  const directory = await mkdtemp(join(tmpdir(), 'vfc-private-'));
  const certPath = join(directory, 'cert.pem'),
    keyPath = join(directory, 'key.pem');
  execFileSync(
    'openssl',
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
  await chmod(keyPath, 0o600);
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
