import { randomUUID } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { acquireManagedProfile } from '../packages/host/src/managed-profile.ts';
function fixture(run: (directory: string) => void) {
  const directory = mkdtempSync(join(tmpdir(), 'managed-profile-proof-'));
  try {
    run(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
describe('Linux app-owned persistent profile boundary', () => {
  it('creates private owner-bound data, preserves it after release and restarts LOCKED', () =>
    fixture((root) => {
      const directory = join(root, 'owned'),
        ownerId = randomUUID();
      const first = acquireManagedProfile({ directory, ownerId });
      expect(first.session).toBe('LOCKED');
      expect(statSync(directory).mode & 0o777).toBe(0o700);
      expect(statSync(first.profilePath).mode & 0o777).toBe(0o700);
      expect(statSync(join(directory, 'profile-owner.json')).mode & 0o777).toBe(
        0o600,
      );
      expect(statSync(join(directory, 'profile.lease')).mode & 0o777).toBe(
        0o600,
      );
      writeFileSync(
        join(first.profilePath, 'fixture-preferences'),
        'synthetic-preserved-data',
        { mode: 0o600 },
      );
      first.release();
      first.release();
      expect(existsSync(join(directory, 'profile.lease'))).toBe(false);
      const second = acquireManagedProfile({ directory, ownerId });
      expect(second.generation).not.toBe(first.generation);
      expect(second.session).toBe('LOCKED');
      expect(
        readFileSync(join(second.profilePath, 'fixture-preferences'), 'utf8'),
      ).toBe('synthetic-preserved-data');
      second.release();
    }));
  it('refuses concurrent and stale leases without adoption or deletion', () =>
    fixture((root) => {
      const request = { directory: join(root, 'owned'), ownerId: randomUUID() };
      const first = acquireManagedProfile(request);
      try {
        expect(() => acquireManagedProfile(request)).toThrow(
          'PROFILE_ALREADY_LEASED',
        );
      } finally {
        first.release();
      }
      writeFileSync(
        join(request.directory, 'profile.lease'),
        JSON.stringify({ pid: 999999, fixture: 'stale' }),
        { mode: 0o600 },
      );
      expect(() => acquireManagedProfile(request)).toThrow(
        'PROFILE_ALREADY_LEASED',
      );
      expect(existsSync(join(request.directory, 'profile.lease'))).toBe(true);
    }));
  it('rejects another owner and unbound existing user profiles', () =>
    fixture((root) => {
      const directory = join(root, 'owned'),
        first = acquireManagedProfile({ directory, ownerId: randomUUID() });
      first.release();
      expect(() =>
        acquireManagedProfile({ directory, ownerId: randomUUID() }),
      ).toThrow('PROFILE_OWNER_REFUSED');
      const userProfile = join(root, 'user-chrome');
      mkdirSync(userProfile, { mode: 0o700 });
      writeFileSync(join(userProfile, 'existing-preferences'), 'untouched');
      expect(() =>
        acquireManagedProfile({
          directory: userProfile,
          ownerId: randomUUID(),
        }),
      ).toThrow('PROFILE_UNBOUND_REFUSED');
      expect(
        readFileSync(join(userProfile, 'existing-preferences'), 'utf8'),
      ).toBe('untouched');
      expect(existsSync(join(userProfile, 'profile-owner.json'))).toBe(false);
    }));
  it('refuses Git directories, symlink paths and permission weakening', () =>
    fixture((root) => {
      mkdirSync(join(root, '.git'));
      expect(() =>
        acquireManagedProfile({
          directory: join(root, 'profile'),
          ownerId: randomUUID(),
        }),
      ).toThrow('PROFILE_REPOSITORY_REFUSED');
      rmSync(join(root, '.git'), { recursive: true });
      mkdirSync(join(root, 'real'), { mode: 0o700 });
      symlinkSync(join(root, 'real'), join(root, 'alias'));
      expect(() =>
        acquireManagedProfile({
          directory: join(root, 'alias', 'profile'),
          ownerId: randomUUID(),
        }),
      ).toThrow('PROFILE_SYMLINK_REFUSED');
      const request = { directory: join(root, 'owned'), ownerId: randomUUID() },
        owned = acquireManagedProfile(request);
      owned.release();
      chmodSync(request.directory, 0o755);
      expect(() => acquireManagedProfile(request)).toThrow();
    }));
  it('never deletes a replacement lease inode even with identical bytes', () =>
    fixture((root) => {
      const directory = join(root, 'owned'),
        owned = acquireManagedProfile({ directory, ownerId: randomUUID() });
      const path = join(directory, 'profile.lease'),
        bytes = readFileSync(path);
      renameSync(path, join(directory, 'old-lease'));
      writeFileSync(path, bytes, { mode: 0o600 });
      expect(() => owned.release()).toThrow('PROFILE_LEASE_REPLACED');
      expect(readFileSync(path)).toEqual(bytes);
    }));
  it('rejects nested profile symlinks and changed lease nonces', () =>
    fixture((root) => {
      const request = { directory: join(root, 'owned'), ownerId: randomUUID() };
      const first = acquireManagedProfile(request);
      mkdirSync(join(first.profilePath, 'nested'), { mode: 0o700 });
      symlinkSync(root, join(first.profilePath, 'nested', 'outside'));
      first.release();
      expect(() => acquireManagedProfile(request)).toThrow(
        'PROFILE_SYMLINK_REFUSED',
      );
      rmSync(join(first.profilePath, 'nested', 'outside'));
      const second = acquireManagedProfile(request);
      const lease = join(request.directory, 'profile.lease');
      writeFileSync(lease, 'replacement-nonce', { mode: 0o600 });
      expect(() => second.release()).toThrow('PROFILE_LEASE_REPLACED');
      expect(() => second.release()).toThrow('PROFILE_LEASE_REPLACED');
      expect(readFileSync(lease, 'utf8')).toBe('replacement-nonce');
    }));
  it('rejects replaced binding/profile symlinks and malformed input', () =>
    fixture((root) => {
      const directory = join(root, 'owned'),
        ownerId = randomUUID(),
        owned = acquireManagedProfile({ directory, ownerId });
      owned.release();
      renameSync(join(directory, 'chromium'), join(directory, 'original'));
      symlinkSync(join(directory, 'original'), join(directory, 'chromium'));
      expect(() => acquireManagedProfile({ directory, ownerId })).toThrow(
        'PROFILE_SYMLINK_REFUSED',
      );
      expect(() =>
        acquireManagedProfile({ directory: 'relative', ownerId }),
      ).toThrow('PROFILE_REQUEST_REFUSED');
      expect(() =>
        acquireManagedProfile({ directory, ownerId, arbitrary: 'ignored' } as {
          directory: string;
          ownerId: string;
        }),
      ).toThrow('PROFILE_REQUEST_REFUSED');
    }));
});
