import { lstatSync } from 'node:fs';
import { arch, release } from 'node:os';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import {
  canonicalRuntime,
  machineBinding,
  protectedFile,
  supportedHost,
  validateRuntimeDirectorySync,
} from '../../../packages/host/src/storage.ts';
import { persistedIdentitySchema } from './identity.ts';
import { loadPrivateAccess } from './private-access.ts';

interface Check {
  name: string;
  status: 'PASS' | 'FAIL' | 'INFO';
  code: string;
}
function present(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}
/** Read-only preflight: never provisions an identity, opens an engine or changes a safety record. */
export async function diagnoseHost(options: {
  runtimeDirectory: string;
  privateConfigPath?: string;
}) {
  const checks: Check[] = [];
  let runtimeDirectory = resolve(options.runtimeDirectory);
  let identity:
    { ownerId: string; instanceId: string; state: string } | undefined;
  let lock: {
    present: boolean;
    pid?: number;
    processPresent?: boolean | 'UNKNOWN';
  } = { present: false };
  let access:
    | { origin: string; bindAddress: string; sessionLifetimeHours: number }
    | undefined;
  const check = (name: string, status: Check['status'], code: string) =>
    checks.push({ name, status, code });
  check(
    'runtime',
    Number(process.versions.node.split('.')[0]) === 24 ? 'PASS' : 'FAIL',
    Number(process.versions.node.split('.')[0]) === 24
      ? 'NODE_24'
      : 'NODE_24_REQUIRED',
  );
  let machineHash: string | undefined;
  try {
    supportedHost();
    machineHash = await machineBinding();
    check('host', 'PASS', 'NATIVE_HOST_IDENTITY_VERIFIED');
  } catch {
    check('host', 'FAIL', 'HOST_IDENTITY_UNAVAILABLE');
  }
  if (!present(runtimeDirectory)) {
    check('storage', 'INFO', 'NOT_INITIALIZED_START_LOCAL_DASHBOARD');
  } else {
    try {
      validateRuntimeDirectorySync(runtimeDirectory);
      runtimeDirectory = canonicalRuntime(runtimeDirectory);
      check('storage', 'PASS', 'OWNER_PRIVATE_STORAGE_VERIFIED');
      const path = join(runtimeDirectory, 'identity.json');
      if (present(path)) {
        const saved = persistedIdentitySchema.parse(
          JSON.parse((await protectedFile(path)).toString('utf8')),
        );
        if (
          !machineHash ||
          saved.machineHash !== machineHash ||
          saved.runtimeDirectory !== runtimeDirectory
        )
          throw new Error('IDENTITY_MISMATCH');
        identity = {
          ownerId: saved.ownerId,
          instanceId: saved.instanceId,
          state: saved.state,
        };
        check(
          'identity',
          saved.state === 'ACTIVE' ? 'PASS' : 'FAIL',
          saved.state === 'ACTIVE'
            ? 'OWNER_INSTANCE_BINDING_VERIFIED'
            : 'ADOPTION_RECOVERY_REQUIRED',
        );
      } else {
        check('identity', 'INFO', 'NO_IDENTITY_PRESERVE_EXISTING_RECORDS');
      }
      const lockPath = join(runtimeDirectory, 'controller.lock');
      if (present(lockPath)) {
        const owner = z
          .object({ pid: z.number().int().positive(), id: z.string().uuid() })
          .strict()
          .parse(JSON.parse((await protectedFile(lockPath)).toString('utf8')));
        let present: boolean | 'UNKNOWN' = 'UNKNOWN';
        try {
          process.kill(owner.pid, 0);
          present = true;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ESRCH')
            present = false;
        }
        lock = { present: true, pid: owner.pid, processPresent: present };
        check('execution owner', 'INFO', 'LOCK_PRESENT_NO_AUTOMATIC_TAKEOVER');
      } else {
        check(
          'execution owner',
          'INFO',
          'NO_ACTIVE_LOCK_NOT_PROOF_OF_PROTECTION',
        );
      }
    } catch {
      check(
        'storage or identity',
        'FAIL',
        'PRESERVE_RUNTIME_REVIEW_OWNERSHIP_AND_PERMISSIONS',
      );
    }
  }
  if (options.privateConfigPath) {
    try {
      const privateAccess = await loadPrivateAccess(
        resolve(options.privateConfigPath),
      );
      if (privateAccess.config.runtimeDirectory !== runtimeDirectory)
        throw new Error('RUNTIME_MISMATCH');
      access = {
        origin: privateAccess.config.origin,
        bindAddress: privateAccess.config.bindAddress,
        sessionLifetimeHours: 8,
      };
      check(
        'private HTTPS',
        'PASS',
        'CONFIGURATION_TLS_ORIGIN_BINDING_VERIFIED',
      );
    } catch {
      check(
        'private HTTPS',
        'FAIL',
        'REVIEW_PRIVATE_CONFIG_TLS_NETWORK_AND_IDENTITY',
      );
    }
  } else {
    check('private HTTPS', 'INFO', 'LOCALHOST_ONLY_PRIVATE_ACCESS_NOT_CHECKED');
  }
  return {
    simulationOnly: true,
    platform: process.platform,
    architecture: arch(),
    osRelease: release(),
    node: process.version,
    runtimeDirectory,
    identity,
    lock,
    access,
    checks,
    preflightPassed: !checks.some((entry) => entry.status === 'FAIL'),
    executionReadiness: 'NOT_ESTABLISHED_BY_PREFLIGHT',
    recovery:
      'Never delete safety records or automatically re-arm. Inspect protection in the authenticated dashboard.',
  };
}
