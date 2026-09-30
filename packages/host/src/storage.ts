import { createHash, randomUUID } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import {
  closeSync,
  constants,
  existsSync,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const failure = (message = 'HOST_STORAGE_REJECTED') => new Error(message);
const digest = (value: string) =>
  createHash('sha256').update(value).digest('hex');
let binding: string | undefined;

export function supportedHost(): 'linux' | 'darwin' | 'win32' {
  if (!['linux', 'darwin', 'win32'].includes(process.platform))
    throw failure('HOST_PLATFORM_UNSUPPORTED');
  return process.platform as 'linux' | 'darwin' | 'win32';
}

/** Trusted OS helper. Secret bytes use stdin, never command arguments or diagnostics. */
function windows(request: Record<string, unknown>): unknown {
  const root = process.env.SystemRoot;
  if (!root || !isAbsolute(root))
    throw failure('WINDOWS_SYSTEM_ROOT_UNAVAILABLE');
  const directory = join(root, 'System32', 'WindowsPowerShell', 'v1.0');
  const result = spawnSync(
    join(directory, 'powershell.exe'),
    [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      fileURLToPath(new URL('windows.ps1', import.meta.url)),
    ],
    {
      input: JSON.stringify(request),
      encoding: 'utf8',
      timeout: 30_000,
      maxBuffer: 8 * 1024 * 1024,
      env: { ...process.env, PSModulePath: join(directory, 'Modules') },
      windowsHide: true,
    },
  );
  if (result.error || result.status !== 0) throw failure();
  try {
    const response = JSON.parse(result.stdout.replace(/^\uFEFF/, '')) as {
      ok?: unknown;
      value?: unknown;
    };
    if (response.ok !== true) throw failure();
    return response.value;
  } catch {
    throw failure();
  }
}

let mac: ReturnType<typeof macApi> | undefined;
function macApi() {
  const koffi = require('koffi') as typeof import('koffi').default;
  const library = koffi.load('/usr/lib/libSystem.B.dylib');
  return {
    koffi,
    get: library.func('void *acl_get_fd_np(int fd, int type)'),
    valid: library.func('int acl_valid(void *acl)'),
    entry: library.func(
      'int acl_get_entry(void *acl, int entry_id, _Out_ void **entry)',
    ),
    free: library.func('int acl_free(void *acl)'),
    init: library.func('void *acl_init(int count)'),
    set: library.func('int acl_set_fd_np(int fd, void *acl, int type)'),
    fcntl: library.func('int fcntl(int fd, int command, ...)'),
    rename: library.func(
      'int renamex_np(const char *from, const char *to, unsigned int flags)',
    ),
  };
}
function macNoAcl(fd: number): void {
  if (supportedHost() !== 'darwin') return;
  const api = (mac ??= macApi());
  api.koffi.errno(0);
  const acl = api.get(fd, 0x100); // ACL_TYPE_EXTENDED, Apple's sys/acl.h.
  const getErrno = api.koffi.errno();
  // Apple's acl_get_fd_np returns NULL/ENOENT for an absent FILESEC_ACL
  // property on this already validated descriptor. Other failures stay closed.
  if (acl === null && getErrno === 2) return;
  if (!acl) throw failure('HOST_ACL_UNVERIFIABLE');
  try {
    if (api.valid(acl) !== 0) throw failure('HOST_ACL_UNVERIFIABLE');
    const entry = [null];
    const result = api.entry(acl, 0, entry); // ACL_FIRST_ENTRY.
    const errno = api.koffi.errno();
    // Apple returns 0 for an entry and -1/EINVAL for an empty valid ACL.
    if (result !== -1 || errno !== 22)
      throw failure('HOST_EXTENDED_ACL_REJECTED');
  } finally {
    api.free(acl);
  }
}
function macClearAcl(fd: number): void {
  if (supportedHost() !== 'darwin') return;
  const api = (mac ??= macApi());
  const acl = api.init(0);
  if (!acl) throw failure('HOST_ACL_UNVERIFIABLE');
  try {
    if (api.set(fd, acl, 0x100) !== 0) throw failure('HOST_ACL_UNVERIFIABLE');
  } finally {
    api.free(acl);
  }
}
function flushFile(fd: number): void {
  fsyncSync(fd);
  if (supportedHost() === 'darwin') {
    const api = (mac ??= macApi());
    if (api.fcntl(fd, 51, 'int', 0) !== 0) throw failure('HOST_FLUSH_FAILED');
  }
}
function flushDirectory(directory: string): void {
  const fd = openSync(
    directory,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
let linuxRename: ReturnType<typeof linuxRenameApi> | undefined;
function linuxRenameApi() {
  const koffi = require('koffi') as typeof import('koffi').default;
  const library = koffi.load('libc.so.6');
  return {
    koffi,
    rename: library.func(
      'int renameat2(int oldfd, const char *from, int newfd, const char *to, unsigned int flags)',
    ),
  };
}
/** One native no-replace rename keeps the authoritative file single-linked even at a crash. */
function renameExclusive(from: string, to: string): boolean {
  if (from.includes('\0') || to.includes('\0')) throw failure();
  let result: number, errno: number;
  if (supportedHost() === 'darwin') {
    const api = (mac ??= macApi());
    result = api.rename(resolve(from), resolve(to), 4); // RENAME_EXCL.
    errno = api.koffi.errno();
  } else {
    const api = (linuxRename ??= linuxRenameApi());
    result = api.rename(-100, resolve(from), -100, resolve(to), 1); // AT_FDCWD, RENAME_NOREPLACE.
    errno = api.koffi.errno();
  }
  if (result === 0) return true;
  if (result === -1 && errno === 17) return false; // EEXIST; caller validates existing record.
  throw failure('HOST_EXCLUSIVE_PUBLICATION_REJECTED');
}
function posixHandle(
  path: string,
  directory = false,
  privateFile = true,
): number {
  const fd = openSync(
    path,
    constants.O_RDONLY |
      constants.O_NOFOLLOW |
      (directory ? constants.O_DIRECTORY : 0),
  );
  try {
    const info = fstatSync(fd),
      named = lstatSync(path);
    if (
      (directory ? !info.isDirectory() : !info.isFile()) ||
      info.uid !== process.getuid?.() ||
      (info.mode & (directory || privateFile ? 0o077 : 0o022)) !== 0 ||
      (!directory && info.nlink !== 1) ||
      named.isSymbolicLink() ||
      named.dev !== info.dev ||
      named.ino !== info.ino
    )
      throw failure(
        'Private storage requires an owner-only regular file or directory',
      );
    macNoAcl(fd);
    return fd;
  } catch (error) {
    closeSync(fd);
    throw error;
  }
}

export function machineBindingSync(): string {
  if (binding) return binding;
  const platform = supportedHost();
  if (platform === 'linux') {
    const value = readFileSync('/etc/machine-id', 'utf8').trim();
    if (!/^[a-f0-9]{32}$/i.test(value))
      throw failure('HOST_IDENTITY_UNAVAILABLE');
    binding = digest(value); // Preserve every existing Linux identity hash exactly.
  } else {
    let value: string;
    if (platform === 'darwin') {
      const report = execFileSync(
        '/usr/sbin/ioreg',
        ['-rd1', '-c', 'IOPlatformExpertDevice'],
        { encoding: 'utf8', timeout: 10_000, maxBuffer: 256 * 1024 },
      );
      value = /"IOPlatformUUID"\s*=\s*"([a-f0-9-]+)"/i.exec(report)?.[1] ?? '';
    } else {
      const result = windows({ operation: 'machine' }) as {
        machineId?: unknown;
      };
      value = typeof result.machineId === 'string' ? result.machineId : '';
    }
    if (
      !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(
        value,
      ) ||
      /^0{8}-0{4}-0{4}-0{4}-0{12}$/.test(value)
    )
      throw failure('HOST_IDENTITY_UNAVAILABLE');
    binding = digest(`${platform}:${value.toLowerCase()}`);
  }
  return binding;
}
export async function machineBinding(): Promise<string> {
  return machineBindingSync();
}

export function validateRuntimeDirectorySync(path: string): void {
  if (supportedHost() === 'win32') {
    if (
      windows({ operation: 'validateDirectory', path: resolve(path) }) !== true
    )
      throw failure();
  } else {
    const fd = posixHandle(path, true);
    closeSync(fd);
  }
}
export function ensurePrivateDirectorySync(path: string): void {
  if (supportedHost() === 'win32') {
    if (windows({ operation: 'ensureDirectory', path: resolve(path) }) !== true)
      throw failure();
  } else {
    const created = mkdirSync(path, { recursive: true, mode: 0o700 });
    if (created) protectDirectorySync(path); // Only a newly created target, never existing data.
    validateRuntimeDirectorySync(path);
  }
}
export async function ensurePrivateDirectory(path: string): Promise<void> {
  ensurePrivateDirectorySync(path);
}

/** Explicit hardening for a newly created directory; never automatic runtime recovery. */
export function protectDirectorySync(path: string): void {
  if (supportedHost() === 'win32') {
    if (
      windows({ operation: 'protectDirectory', path: resolve(path) }) !== true
    )
      throw failure();
  } else {
    const fd = openSync(
      path,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    try {
      if (fstatSync(fd).uid !== process.getuid?.()) throw failure();
      fchmodSync(fd, 0o700);
      macClearAcl(fd);
    } finally {
      closeSync(fd);
    }
    validateRuntimeDirectorySync(path);
  }
}
export async function protectDirectory(path: string): Promise<void> {
  protectDirectorySync(path);
}

/** Explicit key hardening. The caller must select a file; no record deletion or rebinding. */
export function protectFileSync(path: string): void {
  if (supportedHost() === 'win32') {
    if (windows({ operation: 'protectFile', path: resolve(path) }) !== true)
      throw failure();
  } else {
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const info = fstatSync(fd);
      if (!info.isFile() || info.uid !== process.getuid?.() || info.nlink !== 1)
        throw failure();
      fchmodSync(fd, 0o600);
      macClearAcl(fd);
      macNoAcl(fd);
    } finally {
      closeSync(fd);
    }
  }
}
export async function protectFile(path: string): Promise<void> {
  protectFileSync(path);
}

export function protectedFileSync(path: string): Buffer {
  if (supportedHost() === 'win32') {
    lstatSync(path); // Preserve ENOENT for new identity provisioning, never follow broken links.
    let value: unknown;
    try {
      value = windows({ operation: 'readPrivate', path: resolve(path) });
    } catch {
      throw failure('Private storage requires an owner-only regular file');
    }
    if (typeof value !== 'string' || !/^[a-zA-Z0-9+/]*={0,2}$/.test(value))
      throw failure();
    return Buffer.from(value, 'base64');
  }
  const fd = posixHandle(path);
  try {
    return readFileSync(fd);
  } finally {
    closeSync(fd);
  }
}
export async function protectedFile(path: string): Promise<Buffer> {
  return protectedFileSync(path);
}

export function validateRuntimeFileSync(path: string): void {
  if (supportedHost() === 'win32') {
    if (windows({ operation: 'validateFile', path: resolve(path) }) !== true)
      throw failure();
  } else {
    const fd = posixHandle(path, false, false);
    closeSync(fd);
  }
}

/** Durable same-directory publication; false means the existing record remains authoritative. */
export function publishPrivateFileSync(
  path: string,
  data: string | Buffer,
  replace = false,
): boolean {
  const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data);
  if (supportedHost() === 'win32') {
    const value = windows({
      operation: 'publish',
      path: resolve(path),
      data: bytes.toString('base64'),
      replace,
    }) as { created?: unknown };
    if (typeof value.created !== 'boolean') throw failure();
    return value.created;
  }
  validateRuntimeDirectorySync(dirname(path));
  const temporary = join(dirname(path), `.publish-${randomUUID()}.tmp`);
  const fd = openSync(temporary, 'wx', 0o600);
  try {
    try {
      writeFileSync(fd, bytes);
      macNoAcl(fd);
      flushFile(fd);
    } finally {
      closeSync(fd);
    }
    if (replace) {
      try {
        const existing = posixHandle(path);
        closeSync(existing);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      renameSync(temporary, path);
    } else {
      if (!renameExclusive(temporary, path)) {
        const existing = posixHandle(path);
        closeSync(existing);
        return false;
      }
    }
    if (existsSync(temporary)) unlinkSync(temporary);
    flushDirectory(dirname(path));
    if (!protectedFileSync(path).equals(bytes))
      throw failure('HOST_PUBLICATION_UNVERIFIED');
    return true;
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}

export function writeExclusivePrivateFileSync(
  path: string,
  data: string,
): boolean {
  if (supportedHost() === 'win32') {
    const value = windows({
      operation: 'writeExclusive',
      path: resolve(path),
      data: Buffer.from(data).toString('base64'),
    }) as { created?: unknown };
    if (typeof value.created !== 'boolean') throw failure();
    return value.created;
  }
  let fd: number;
  try {
    fd = openSync(path, 'wx', 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw error;
  }
  try {
    writeFileSync(fd, data);
    macNoAcl(fd);
    flushFile(fd);
  } finally {
    closeSync(fd);
  }
  flushDirectory(dirname(path));
  return true;
}

export function removeOwnedPrivateFileSync(
  path: string,
  data: string,
): boolean {
  if (supportedHost() === 'win32')
    return (
      windows({
        operation: 'removeOwned',
        path: resolve(path),
        data: Buffer.from(data).toString('base64'),
      }) === true
    );
  let fd: number;
  try {
    fd = posixHandle(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
  try {
    const info = fstatSync(fd),
      named = lstatSync(path);
    if (
      !readFileSync(fd).equals(Buffer.from(data)) ||
      named.dev !== info.dev ||
      named.ino !== info.ino
    )
      return false;
    unlinkSync(path);
    flushDirectory(dirname(path));
    return true;
  } finally {
    closeSync(fd);
  }
}

export function canonicalRuntime(path: string): string {
  return realpathSync(resolve(path));
}
