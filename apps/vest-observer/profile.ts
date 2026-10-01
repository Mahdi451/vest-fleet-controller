import { randomUUID } from 'node:crypto';
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { z } from 'zod';
import { diagnoseHost } from '../dashboard/src/host-diagnostics.ts';
import {
  canonicalRuntime,
  ensurePrivateDirectorySync,
  machineBindingSync,
  protectedFileSync,
  publishPrivateFileSync,
  removeOwnedPrivateFileSync,
  writeExclusivePrivateFileSync,
} from '../../packages/host/src/storage.ts';

const bindingSchema = z
  .object({
    ownerId: z.string().uuid(),
    instanceId: z.string().uuid(),
    machineHash: z.string().regex(/^[a-f0-9]{64}$/),
    runtimeDirectory: z.string(),
    profileDirectory: z.string(),
  })
  .strict();
export function defaultObserverProfile() {
  if (process.platform === 'win32') {
    if (!process.env.LOCALAPPDATA)
      throw new Error('LOCAL_PRIVATE_PROFILE_LOCATION_REQUIRED');
    return join(
      process.env.LOCALAPPDATA,
      'VestFleetController',
      'manual-observer',
    );
  }
  if (process.platform === 'darwin')
    return join(
      homedir(),
      'Library',
      'Application Support',
      'VestFleetController',
      'manual-observer',
    );
  return join(
    homedir(),
    '.local',
    'share',
    'vest-fleet-controller',
    'manual-observer',
  );
}
function assertOutsideGit(directory: string) {
  let cursor = resolve(directory);
  for (;;) {
    if (existsSync(join(cursor, '.git')))
      throw new Error('OBSERVER_PROFILE_MUST_BE_OUTSIDE_GIT');
    const parent = dirname(cursor);
    if (parent === cursor) return;
    cursor = parent;
  }
}
/** Reuses native protected storage. Never takes the simulator's execution lock. */
export async function acquireObserverProfile(runtime: string, profile: string) {
  const host = await diagnoseHost({ runtimeDirectory: runtime });
  if (
    !host.preflightPassed ||
    !host.identity ||
    host.identity.state !== 'ACTIVE'
  )
    throw new Error('INITIALIZED_VERIFIED_HOST_REQUIRED');
  assertOutsideGit(profile);
  const lock = JSON.stringify({ pid: process.pid, id: randomUUID() });
  const instanceLock = join(host.runtimeDirectory, 'vest-observer.lock');
  if (!writeExclusivePrivateFileSync(instanceLock, lock))
    throw new Error('OBSERVER_INSTANCE_LOCKED_REVIEW_REQUIRED');
  let lockPath: string | null = null;
  let released = false;
  const release = () => {
    if (released) return;
    if (lockPath && !removeOwnedPrivateFileSync(lockPath, lock))
      throw new Error('OBSERVER_LOCK_OWNERSHIP_LOST');
    if (!removeOwnedPrivateFileSync(instanceLock, lock))
      throw new Error('OBSERVER_LOCK_OWNERSHIP_LOST');
    released = true;
  };
  try {
    ensurePrivateDirectorySync(profile);
    const directory = canonicalRuntime(profile);
    assertOutsideGit(directory);
    const candidate = join(directory, 'observer.lock');
    if (!writeExclusivePrivateFileSync(candidate, lock))
      throw new Error('OBSERVER_PROFILE_LOCKED_REVIEW_REQUIRED');
    lockPath = candidate;
    const binding = {
      ownerId: host.identity.ownerId,
      instanceId: host.identity.instanceId,
      machineHash: machineBindingSync(),
      runtimeDirectory: host.runtimeDirectory,
      profileDirectory: directory,
    };
    const path = join(directory, 'binding.json');
    if (!existsSync(path)) {
      if (readdirSync(directory).some((name) => name !== 'observer.lock'))
        throw new Error('UNBOUND_BROWSER_PROFILE_REJECTED');
      if (!publishPrivateFileSync(path, JSON.stringify(binding)))
        throw new Error('OBSERVER_BINDING_COLLISION');
    }
    const saved = bindingSchema.parse(
      JSON.parse(protectedFileSync(path).toString('utf8')),
    );
    if (
      Object.entries(binding).some(
        ([key, value]) => saved[key as keyof typeof saved] !== value,
      )
    )
      throw new Error('OBSERVER_HOST_OWNER_INSTANCE_MISMATCH');
    const chromiumDirectory = join(directory, 'chromium');
    ensurePrivateDirectorySync(chromiumDirectory);
    return {
      binding: Object.freeze(binding),
      directory,
      chromiumDirectory,
      release,
    };
  } catch (error) {
    release();
    throw error;
  }
}
