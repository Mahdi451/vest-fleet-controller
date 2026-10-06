import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createManagedFixture } from '../packages/browser-execution/src/managed-fixture.ts';
import { observeManagedLaunch } from './fixtures/managed-vest-page.ts';
import { createContainedFixture } from '../packages/host/src/offline-browser-containment.ts';
import { Journal } from '../packages/execution/src/journal.ts';
import { OfflineFanoutController } from '../packages/execution/src/fanout-controller.ts';
import { leaderEventSchema } from '../packages/execution/src/copier-events.ts';
import { config, intent, NOW } from './helpers.ts';
vi.mock('node:child_process', async (original) => {
  const actual = await original<typeof import('node:child_process')>();
  return { ...actual, spawn: vi.fn(actual.spawn) };
});
function controller(
  adapter: Awaited<ReturnType<typeof createContainedFixture>>['adapter'],
) {
  const journal = new Journal();
  const copier = new OfflineFanoutController(
    adapter,
    config,
    journal,
    () => NOW,
    2000,
  );
  journal.copier.registerLeaderStream({
    environment: 'OFFLINE_FIXTURE',
    evidence: 'SYNTHETIC',
    leaderAccountId: '01',
    sourceId: 'persistent-fixture',
    symbol: 'NDX',
    baselineSequence: 0,
  });
  const { eventId } = journal.copier.recordLeaderEvent(
    leaderEventSchema.parse({
      environment: 'OFFLINE_FIXTURE',
      evidence: 'SYNTHETIC',
      origin: 'ACCEPTED_EVENT',
      leaderAccountId: '01',
      sourceId: 'persistent-fixture',
      providerEventId: 'entry-1',
      entryRootId: 'entry-1',
      symbol: 'NDX',
      sequence: 1,
      occurredAt: NOW,
      kind: 'ENTRY',
      side: 'LONG',
      quantity: '1',
      leverage: intent.leverage,
    }),
    { generation: randomUUID(), detectedAt: NOW },
  );
  return { journal, copier, eventId };
}
async function arm(copier: OfflineFanoutController) {
  await copier.arm({
    environment: 'OFFLINE_FIXTURE',
    evidence: 'SYNTHETIC',
    leaderAccountId: '01',
    followerAccountIds: ['02', '03'],
    symbol: 'NDX',
    maxLeverage: intent.leverage,
    maxNotionalPerAccount: '1000000',
    maxPlannedLossPerAccount: '1000',
    expiresAt: NOW + 60000,
  });
}
describe('owned persistent profile inside the offline namespace', () => {
  it('persists only synthetic cookie/storage proof across clean launches and never restores execution authority', async () => {
    const root = mkdtempSync(join(tmpdir(), 'contained-profile-proof-'));
    const ownedProfile = {
      directory: join(root, 'owned'),
      ownerId: randomUUID(),
    };
    let first: Awaited<ReturnType<typeof createContainedFixture>> | undefined,
      second: typeof first;
    let c: ReturnType<typeof controller> | undefined;
    try {
      first = await createContainedFixture({
        config,
        fixtureTime: NOW,
        ownedProfile,
      });
      expect(await first.probeProfilePersistence('SEED')).toEqual({
        cookiePreviouslyPresent: false,
        storagePreviouslyPresent: false,
        cookiePresent: true,
        storagePresent: true,
      });
      const args = vi
        .mocked(spawn)
        .mock.calls.findLast(
          ([program]) => program === '/usr/bin/bwrap',
        )![1] as string[];
      expect(args).toEqual(
        expect.arrayContaining([
          '--bind',
          join(ownedProfile.directory, 'chromium'),
          '/tmp/owned-browser-profile',
        ]),
      );
      expect(args).not.toContain(ownedProfile.directory);
      expect(args).not.toContain(
        join(ownedProfile.directory, 'profile-owner.json'),
      );
      expect(args).not.toContain(join(ownedProfile.directory, 'profile.lease'));
      c = controller(first.adapter);
      await first.armFixture();
      await arm(c.copier);
      const copied = await c.copier.copyEntry(c.eventId, intent);
      expect(
        copied.every(
          (row) =>
            row.attempt?.outcome.stop === 'VERIFIED' &&
            row.attempt.outcome.target === 'VERIFIED',
        ),
      ).toBe(true);
      const oldLease = JSON.parse(
        readFileSync(join(ownedProfile.directory, 'profile.lease'), 'utf8'),
      ) as { generation: string };
      c.journal.close();
      c = undefined;
      await first.close();
      first = undefined;
      expect(existsSync(join(ownedProfile.directory, 'profile.lease'))).toBe(
        false,
      );
      second = await createContainedFixture({
        config,
        fixtureTime: NOW,
        ownedProfile,
      });
      expect(await second.probeProfilePersistence('CHECK')).toEqual({
        cookiePreviouslyPresent: true,
        storagePreviouslyPresent: true,
        cookiePresent: true,
        storagePresent: true,
      });
      const newLease = JSON.parse(
        readFileSync(join(ownedProfile.directory, 'profile.lease'), 'utf8'),
      ) as { generation: string };
      expect(newLease.generation).not.toBe(oldLease.generation);
      expect(second.inspect().liveState).toBe('LOCKED');
      expect(
        (await second.adapter.listAccounts()).every(
          (account) => account.positions.length === 0,
        ),
      ).toBe(true);
      c = controller(second.adapter);
      await expect(c.copier.copyEntry(c.eventId, intent)).rejects.toThrow();
      expect(
        (await second.adapter.listAccounts()).every(
          (account) => account.positions.length === 0,
        ),
      ).toBe(true);
      await second.close();
      second = undefined;
      expect(existsSync(join(ownedProfile.directory, 'profile.lease'))).toBe(
        false,
      );
    } finally {
      await first?.close();
      await second?.close();
      c?.journal.close();
      rmSync(root, { recursive: true, force: true });
    }
  }, 30000);
  it('sanitizes an actual browser close failure and preserves the unconfirmed profile', async () => {
    const observed = observeManagedLaunch();
    let managed: Awaited<ReturnType<typeof createManagedFixture>> | undefined;
    try {
      managed = await createManagedFixture(config, () => NOW);
      const failure = vi
        .spyOn(observed.context(), 'close')
        .mockRejectedValueOnce(new Error('SYNTHETIC_CLOSE_SECRET_CANARY'));
      await expect(managed.close()).rejects.toThrow(
        'MANAGED_FIXTURE_CLOSE_UNCONFIRMED',
      );
      expect(existsSync(observed.profile())).toBe(true);
      failure.mockRestore();
      await observed.context().close();
    } finally {
      observed.restore();
      if (managed) rmSync(observed.profile(), { recursive: true, force: true });
    }
  }, 15000);
  it('retains the lease when browser closure acknowledgement is unconfirmed', async () => {
    const root = mkdtempSync(join(tmpdir(), 'contained-profile-unconfirmed-'));
    const ownedProfile = {
      directory: join(root, 'owned'),
      ownerId: randomUUID(),
    };
    let managed: Awaited<ReturnType<typeof createContainedFixture>> | undefined;
    try {
      managed = await createContainedFixture({
        config,
        fixtureTime: NOW,
        ownedProfile,
      });
      const index = vi
        .mocked(spawn)
        .mock.calls.findLastIndex(([program]) => program === '/usr/bin/bwrap');
      const child = vi.mocked(spawn).mock.results[index]!
        .value as import('node:child_process').ChildProcessWithoutNullStreams;
      const write = vi
        .spyOn(child.stdin, 'write')
        .mockImplementationOnce((frame) => {
          const request = JSON.parse(String(frame)) as {
            id: number;
            operation: string;
          };
          expect(request.operation).toBe('CLOSE');
          child.stdout.emit(
            'data',
            Buffer.from(
              JSON.stringify({
                kind: 'RESULT',
                id: request.id,
                ok: false,
                error: 'CONTAINED_OPERATION_UNCONFIRMED',
              }) + '\n',
            ),
          );
          return true;
        });
      await managed.close();
      write.mockRestore();
      managed = undefined;
      expect(existsSync(join(ownedProfile.directory, 'profile.lease'))).toBe(
        true,
      );
      await expect(
        createContainedFixture({ config, ownedProfile }),
      ).rejects.toThrow('PROFILE_ALREADY_LEASED');
    } finally {
      await managed?.close();
      rmSync(root, { recursive: true, force: true });
    }
  }, 15000);
  it('refuses concurrent owners and retains a lease after killed worker without automatic recovery', async () => {
    const root = mkdtempSync(join(tmpdir(), 'contained-profile-loss-'));
    const ownedProfile = {
      directory: join(root, 'owned'),
      ownerId: randomUUID(),
    };
    let managed: Awaited<ReturnType<typeof createContainedFixture>> | undefined;
    try {
      managed = await createContainedFixture({
        config,
        fixtureTime: NOW,
        ownedProfile,
      });
      await expect(
        createContainedFixture({
          config,
          ownedProfile: { ...ownedProfile, ownerId: randomUUID() },
        }),
      ).rejects.toThrow('PROFILE_OWNER_REFUSED');
      await expect(
        createContainedFixture({ config, ownedProfile }),
      ).rejects.toThrow();
      const index = vi
        .mocked(spawn)
        .mock.calls.findLastIndex(([program]) => program === '/usr/bin/bwrap');
      (
        vi.mocked(spawn).mock.results[index]!
          .value as import('node:child_process').ChildProcess
      ).kill('SIGKILL');
      await vi.waitFor(() => expect(managed!.inspect().state).toBe('HALTED'));
      await managed.close();
      managed = undefined;
      expect(existsSync(join(ownedProfile.directory, 'profile.lease'))).toBe(
        true,
      );
      await expect(
        createContainedFixture({ config, ownedProfile }),
      ).rejects.toThrow();
    } finally {
      await managed?.close();
      rmSync(root, { recursive: true, force: true });
    }
  }, 15000);
});
