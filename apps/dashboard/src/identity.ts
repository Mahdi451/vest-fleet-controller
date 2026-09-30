import { randomUUID } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import {
  ensurePrivateDirectory,
  canonicalRuntime,
  publishPrivateFileSync,
} from '../../../packages/host/src/storage.ts';
import { join } from 'node:path';
import { z } from 'zod';
import { machineBinding, protectedFile } from './private-access.ts';
import { bindLegacyRuntime, inspectLegacyRuntime } from './legacy-adoption.ts';
export const persistedIdentitySchema = z
  .object({
    ownerId: z.string().uuid(),
    instanceId: z.string().uuid(),
    machineHash: z.string().regex(/^[a-f0-9]{64}$/),
    runtimeDirectory: z.string(),
    state: z.enum(['ADOPTING', 'ACTIVE']).default('ACTIVE'),
    legacyDatabases: z.array(z.string()).optional(),
  })
  .strict();
type PersistedIdentity = z.infer<typeof persistedIdentitySchema>;
export interface ExecutionIdentity {
  ownerId: string;
  instanceId: string;
}
async function assertLock(directory: string): Promise<void> {
  const lock = z
    .object({ pid: z.number().int(), id: z.string() })
    .parse(
      JSON.parse(
        (await protectedFile(join(directory, 'controller.lock'))).toString(
          'utf8',
        ),
      ),
    );
  if (lock.pid !== process.pid)
    throw new Error(
      'Legacy adoption requires the current process exclusive runtime lock',
    );
}
async function publishIdentity(
  directory: string,
  identity: PersistedIdentity,
  replace = false,
): Promise<void> {
  publishPrivateFileSync(
    join(directory, 'identity.json'),
    `${JSON.stringify(identity)}\n`,
    replace,
  );
}
/** Caller holds SimulationStore's exclusive lock before legacy adoption/resumption and engine opening. */
export async function loadLocalIdentity(
  directory: string,
): Promise<ExecutionIdentity> {
  await ensurePrivateDirectory(directory);
  const runtimeDirectory = canonicalRuntime(directory);
  const machineHash = await machineBinding(),
    path = join(runtimeDirectory, 'identity.json');
  const readIdentity = async () => {
    const identity = persistedIdentitySchema.parse(
      JSON.parse((await protectedFile(path)).toString('utf8')),
    );
    if (
      identity.machineHash !== machineHash ||
      identity.runtimeDirectory !== runtimeDirectory
    )
      throw new Error(
        'Execution identity is bound to a different host or runtime directory',
      );
    return identity;
  };
  let identity: PersistedIdentity | undefined;
  try {
    identity = await readIdentity();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  if (!identity) {
    const entries = await readdir(runtimeDirectory);
    const durable = entries.some(
      (name) =>
        name === 'active-session.json' ||
        /\.(sqlite|db)([-.].*)?$/.test(name) ||
        name === 'private-access.json',
    );
    if (durable) {
      await assertLock(runtimeDirectory).catch(() => {
        throw new Error(
          'Legacy runtime requires operator recovery under an exclusive lock',
        );
      });
      const legacyDatabases = await inspectLegacyRuntime(runtimeDirectory);
      identity = {
        ownerId: randomUUID(),
        instanceId: randomUUID(),
        machineHash,
        runtimeDirectory,
        state: 'ADOPTING',
        legacyDatabases,
      };
    } else
      identity = {
        ownerId: randomUUID(),
        instanceId: randomUUID(),
        machineHash,
        runtimeDirectory,
        state: 'ACTIVE',
      };
    await publishIdentity(runtimeDirectory, identity);
    identity = await readIdentity();
  }
  if (identity.state === 'ADOPTING') {
    await assertLock(runtimeDirectory);
    if (!identity.legacyDatabases?.length)
      throw new Error(
        'Malformed legacy adoption plan requires operator recovery',
      );
    const names = await inspectLegacyRuntime(runtimeDirectory, identity);
    if (JSON.stringify(names) !== JSON.stringify(identity.legacyDatabases))
      throw new Error(
        'Legacy adoption database inventory changed; operator recovery required',
      );
    bindLegacyRuntime(runtimeDirectory, names, {
      ownerId: identity.ownerId,
      instanceId: identity.instanceId,
    });
    identity = { ...identity, state: 'ACTIVE' };
    await publishIdentity(runtimeDirectory, identity, true);
  }
  return { ownerId: identity.ownerId, instanceId: identity.instanceId };
}
