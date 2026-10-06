import { randomUUID } from 'node:crypto';
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
  fsyncSync,
} from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { z } from 'zod';
import {
  machineBindingSync,
  protectedFileSync,
  publishPrivateFileSync,
  validateRuntimeDirectorySync,
} from './storage.ts';
const bindingSchema = z
  .object({
    version: z.literal(1),
    ownerId: z.string().uuid(),
    machineHash: z.string().regex(/^[a-f0-9]{64}$/),
    directory: z.string(),
    profile: z.literal('chromium'),
  })
  .strict();
const fail = (code: string): never => {
  throw new Error(code);
};
function ancestors(path: string) {
  let current = resolve(path);
  while (true) {
    if (existsSync(current) && lstatSync(current).isSymbolicLink())
      fail('PROFILE_SYMLINK_REFUSED');
    if (existsSync(join(current, '.git'))) fail('PROFILE_REPOSITORY_REFUSED');
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
}
function directory(path: string) {
  ancestors(path);
  validateRuntimeDirectorySync(path);
  if (realpathSync(path) !== path) fail('PROFILE_PATH_UNPROVEN');
}
function profileContents(path: string, depth = 0): void {
  if (depth > 64) fail('PROFILE_CONTENTS_UNPROVEN');
  for (const name of readdirSync(path)) {
    const target = join(path, name),
      info = lstatSync(target);
    if (info.isSymbolicLink()) fail('PROFILE_SYMLINK_REFUSED');
    if (info.isDirectory()) profileContents(target, depth + 1);
    else if (!info.isFile()) fail('PROFILE_CONTENTS_UNPROVEN');
  }
}
/** Linux-only app-owned profile lease. Existing unbound directories are never adopted. */
export function acquireManagedProfile(input: {
  directory: string;
  ownerId: string;
}) {
  if (process.platform !== 'linux') return fail('PROFILE_PLATFORM_UNPROVEN');
  const parsed = z
    .object({ directory: z.string().min(1), ownerId: z.string().uuid() })
    .strict()
    .safeParse(input);
  if (
    !parsed.success ||
    !isAbsolute(input.directory) ||
    resolve(input.directory) !== input.directory
  )
    return fail('PROFILE_REQUEST_REFUSED');
  const root = input.directory;
  ancestors(root);
  let created = false;
  try {
    mkdirSync(root, { mode: 0o700 });
    created = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST')
      return fail('PROFILE_DIRECTORY_REFUSED');
  }
  directory(root);
  const metadata = join(root, 'profile-owner.json'),
    profilePath = join(root, 'chromium');
  const binding = {
    version: 1 as const,
    ownerId: input.ownerId,
    machineHash: machineBindingSync(),
    directory: root,
    profile: 'chromium' as const,
  };
  if (created) {
    if (readdirSync(root).length) return fail('PROFILE_INITIALIZATION_REFUSED');
    mkdirSync(profilePath, { mode: 0o700 });
    if (!publishPrivateFileSync(metadata, `${JSON.stringify(binding)}\n`))
      return fail('PROFILE_INITIALIZATION_REFUSED');
  } else {
    let stored: z.infer<typeof bindingSchema>;
    try {
      stored = bindingSchema.parse(
        JSON.parse(protectedFileSync(metadata).toString('utf8')),
      );
    } catch {
      return fail('PROFILE_UNBOUND_REFUSED');
    }
    if (JSON.stringify(stored) !== JSON.stringify(binding))
      return fail('PROFILE_OWNER_REFUSED');
  }
  directory(profilePath);
  profileContents(profilePath);
  const generation = randomUUID(),
    leasePath = join(root, 'profile.lease');
  const record = `${JSON.stringify({ version: 1, ownerId: input.ownerId, leaseId: randomUUID(), generation, pid: process.pid })}\n`;
  let fd: number;
  try {
    fd = openSync(
      leasePath,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      0o600,
    );
  } catch {
    return fail('PROFILE_ALREADY_LEASED');
  }
  try {
    writeFileSync(fd, record);
    fsyncSync(fd);
  } catch {
    closeSync(fd);
    return fail('PROFILE_LEASE_UNPROVEN');
  }
  const inode = fstatSync(fd);
  let released = false;
  let fdClosed = false;
  return {
    profilePath,
    generation,
    session: 'LOCKED' as const,
    retainLease() {
      if (!fdClosed) {
        closeSync(fd);
        fdClosed = true;
      }
    },
    release() {
      if (released) return;
      try {
        directory(root);
        directory(profilePath);
        const named = lstatSync(leasePath);
        if (
          named.isSymbolicLink() ||
          named.dev !== inode.dev ||
          named.ino !== inode.ino ||
          protectedFileSync(leasePath).toString('utf8') !== record
        )
          return fail('PROFILE_LEASE_REPLACED');
        unlinkSync(leasePath);
        released = true;
      } catch (error) {
        if (
          error instanceof Error &&
          error.message === 'PROFILE_LEASE_REPLACED'
        )
          throw error;
        return fail('PROFILE_RELEASE_REFUSED');
      } finally {
        if (!fdClosed) {
          closeSync(fd);
          fdClosed = true;
        }
      }
    },
  };
}
