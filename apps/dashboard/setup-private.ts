import { randomBytes } from 'node:crypto';
import { lstat, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SimulationStore } from '../../packages/simulator/src/storage.ts';
import { loadLocalIdentity } from './src/identity.ts';
import {
  machineBinding,
  secretVerifier,
  validatePrivateConfiguration,
  type PrivateAccessConfig,
} from './src/private-access.ts';

export async function setupPrivateAccess(
  args: string[],
): Promise<{ configPath: string; secretPath: string }> {
  const parameters = new Map<string, string>();
  for (let i = 0; i < args.length; i += 2) {
    const name = args[i],
      value = args[i + 1];
    if (
      !name ||
      !['--origin', '--bind', '--cert', '--key', '--runtime'].includes(name) ||
      !value ||
      value.startsWith('--') ||
      parameters.has(name)
    )
      throw new Error(
        'Usage: --origin https://host.tailnet.ts.net:4173 --bind 100.x.x.x --cert /path/cert.pem --key /path/key.pem --runtime /path/.runtime',
      );
    parameters.set(name, value);
  }
  for (const required of ['--origin', '--bind', '--cert', '--key'])
    if (!parameters.has(required)) throw new Error(`Missing ${required}`);
  const directory = resolve(
    parameters.get('--runtime') ?? '.runtime/dashboard',
  );
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const runtimeDirectory = await realpath(directory);
  const store = new SimulationStore(runtimeDirectory);
  try {
    const configPath = join(runtimeDirectory, 'private-access.json');
    const secretPath = join(runtimeDirectory, 'access-secret.txt');
    for (const path of [configPath, secretPath]) {
      try {
        await lstat(path);
        throw new Error(
          'Private access is already provisioned; do not replace an existing instance',
        );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
    const identity = await loadLocalIdentity(runtimeDirectory);
    const secret = randomBytes(32).toString('base64url');
    const origin = parameters.get('--origin')!;
    const config: PrivateAccessConfig = {
      version: 1,
      active: true,
      origin,
      bindAddress: parameters.get('--bind')!,
      port: Number(new URL(origin).port || 443),
      ...identity,
      runtimeDirectory,
      machineHash: await machineBinding(),
      certPath: resolve(parameters.get('--cert')!),
      keyPath: resolve(parameters.get('--key')!),
      ...secretVerifier(secret),
    };
    await validatePrivateConfiguration(config);
    await writeFile(secretPath, `${secret}\n`, { flag: 'wx', mode: 0o600 });
    try {
      await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, {
        flag: 'wx',
        mode: 0o600,
      });
    } catch (error) {
      await rm(secretPath);
      throw error;
    }
    return { configPath, secretPath };
  } finally {
    store.close();
  }
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  setupPrivateAccess(process.argv.slice(2))
    .then(({ configPath, secretPath }) => {
      console.log(
        `Private simulation access provisioned. Configuration: ${configPath}`,
      );
      console.log(
        `Access secret saved in owner-only file: ${secretPath}. Read it privately; never commit or share it in logs.`,
      );
    })
    .catch(() => {
      console.error(
        'Private setup rejected. Verify arguments, Tailscale address, owner-only key, certificate, and unprovisioned runtime.',
      );
      process.exitCode = 1;
    });
}
