import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { createSocket } from 'node:dgram';
import { createConnection } from 'node:net';
import {
  readlinkSync,
  readdirSync,
  existsSync,
  mkdtempSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { describe, expect, it, vi } from 'vitest';
import { createContainedFixture } from '../packages/host/src/offline-browser-containment.ts';
import { config, intent, NOW } from './helpers.ts';
import { Journal } from '../packages/execution/src/journal.ts';
import { OfflineFanoutController } from '../packages/execution/src/fanout-controller.ts';
import { leaderEventSchema } from '../packages/execution/src/copier-events.ts';
import { randomUUID } from 'node:crypto';
const launchControl = vi.hoisted(() => ({ refuse: false }));
vi.mock('node:child_process', async (original) => {
  const actual = await original<typeof import('node:child_process')>();
  return {
    ...actual,
    spawn: vi.fn((command, args, options) =>
      actual.spawn(
        launchControl.refuse ? '/usr/bin/false' : command,
        launchControl.refuse ? [] : args,
        options,
      ),
    ),
  };
});
async function canaries() {
  let tcpPackets = 0,
    udpPackets = 0;
  const tcp = createServer((_request, response) => {
    tcpPackets++;
    response.setHeader('Content-Type', 'text/html');
    response.end('<html>synthetic host-owned canary</html>');
  });
  const udp = createSocket('udp4');
  udp.on('message', () => {
    udpPackets++;
  });
  await new Promise<void>((resolve) => tcp.listen(0, '127.0.0.1', resolve));
  await new Promise<void>((resolve) => udp.bind(0, '127.0.0.1', resolve));
  const tcpAddress = tcp.address(),
    udpAddress = udp.address();
  if (!tcpAddress || typeof tcpAddress === 'string')
    throw new Error('NO_ADDRESS');
  return {
    tcpPort: tcpAddress.port,
    udpPort: udpAddress.port,
    packets: () => ({ tcpPackets, udpPackets }),
    reset: () => {
      tcpPackets = 0;
      udpPackets = 0;
    },
    close: async () => {
      await new Promise<void>((resolve) => tcp.close(() => resolve()));
      await new Promise<void>((resolve) => udp.close(() => resolve()));
    },
  };
}
describe('Linux whole-tree offline fixture network containment', () => {
  it('proves real host browser TCP/UDP canaries, then independently blocks a contained browser and descendant', async () => {
    const host = await canaries();
    const profileRoot = mkdtempSync(
      join(tmpdir(), 'contained-network-owned-profile-'),
    );
    let contained:
      Awaited<ReturnType<typeof createContainedFixture>> | undefined;
    try {
      // Positive controls are isolated headless tests targeting only our own loopback servers.
      const browser = await chromium.launch({ headless: true });
      try {
        const page = await browser.newPage();
        await page.goto(`http://127.0.0.1:${host.tcpPort}/kernel-canary`);
        await page.evaluate(async (port) => {
          const peer = new RTCPeerConnection({
            iceServers: [{ urls: `stun:127.0.0.1:${port}` }],
          });
          try {
            peer.createDataChannel('synthetic-canary');
            await peer.setLocalDescription(await peer.createOffer());
            await new Promise((resolve) => setTimeout(resolve, 900));
          } finally {
            peer.close();
          }
        }, host.udpPort);
        await vi.waitFor(() =>
          expect(host.packets().tcpPackets).toBeGreaterThan(0),
        );
        await vi.waitFor(() =>
          expect(host.packets().udpPackets).toBeGreaterThan(0),
        );
      } finally {
        await browser.close();
      }
      await new Promise<void>((resolve, reject) => {
        const socket = createConnection({
          host: '127.0.0.1',
          port: host.tcpPort,
        });
        socket.once('connect', () => {
          socket.destroy();
          resolve();
        });
        socket.once('error', reject);
      });
      const socket = createSocket('udp4');
      await new Promise<void>((resolve, reject) =>
        socket.send(
          Buffer.from('SYNTHETIC_DESCENDANT_CONTROL'),
          host.udpPort,
          '127.0.0.1',
          (error) => (error ? reject(error) : resolve()),
        ),
      );
      socket.close();
      await new Promise((resolve) => setTimeout(resolve, 100));
      host.reset();
      contained = await createContainedFixture({
        config,
        fixtureTime: NOW,
        ownedProfile: {
          directory: join(profileRoot, 'owned'),
          ownerId: randomUUID(),
        },
      });
      expect(contained.inspect()).toMatchObject({
        state: 'READY',
        liveState: 'LOCKED',
        proof: { onlyLoopback: true, descendantNamespacesMatch: true },
      });
      expect(contained.inspect().proof.namespace).not.toBe(
        readlinkSync('/proc/self/ns/net'),
      );
      expect(contained.inspect().proof.chromiumProcesses).toBeGreaterThan(0);
      expect(await contained.adapter.listAccounts()).toHaveLength(10);
      const launch = vi
        .mocked(spawn)
        .mock.calls.findLast(([program]) => program === '/usr/bin/bwrap');
      expect(launch).toBeDefined();
      const args = launch![1] as string[];
      expect(args).toEqual(
        expect.arrayContaining([
          '--unshare-net',
          '--unshare-pid',
          '--clearenv',
          '--cap-drop',
          'ALL',
          '--disable-userns',
          '--die-with-parent',
        ]),
      );
      expect(launch![2]).toMatchObject({
        env: {},
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      const bindings = args.flatMap((item, index) =>
        item === '--ro-bind' ? [args[index + 1]] : [],
      );
      expect(bindings).not.toContain(process.cwd());
      expect(bindings).not.toContain('/run');
      expect(
        bindings.some((path) =>
          /(?:\.runtime|\.env|\.git)(?:\/|$)/.test(path!),
        ),
      ).toBe(false);

      const probes = await contained.probeHostCanaries({
        tcpPort: host.tcpPort,
        udpPort: host.udpPort,
      });
      expect(probes).toMatchObject({
        browserTcpBlocked: true,
        descendantTcpBlocked: true,
        descendantUdpAttempted: true,
        browserStunConfigured: true,
      });
      expect(probes.proof.namespace).toBe(contained.inspect().proof.namespace);
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(host.packets()).toEqual({ tcpPackets: 0, udpPackets: 0 });
      // There is no generic network/launch/profile/page handle in the public API.
      expect(
        [
          'page',
          'browser',
          'origin',
          'profile',
          'evaluate',
          'launch',
          'request',
        ].some((key) => key in contained!),
      ).toBe(false);
    } finally {
      await contained?.close();
      await host.close();
      rmSync(profileRoot, { recursive: true, force: true });
    }
  }, 30000);
  it('keeps the host controller drives private-pipe fixture/browser exchange inside the isolated namespace', async () => {
    const contained = await createContainedFixture({
        config,
        fixtureTime: NOW,
      }),
      journal = new Journal();
    try {
      const copier = new OfflineFanoutController(
        contained.adapter,
        config,
        journal,
        () => NOW,
        2000,
      );
      contained.subscribeLifecycle((event) => {
        if (event.scope === 'GLOBAL') copier.halt('CHANNEL_INTEGRITY_LOST');
        else if (event.accountId) copier.invalidateContext(event.accountId);
      });
      expect(copier.status()).toBe('LOCKED');
      await contained.armFixture();
      await copier.arm({
        environment: 'OFFLINE_FIXTURE',
        evidence: 'SYNTHETIC',
        leaderAccountId: '01',
        followerAccountIds: ['02', '03'],
        symbol: 'NDX',
        maxLeverage: '50',
        maxNotionalPerAccount: '100000',
        maxPlannedLossPerAccount: '10',
        expiresAt: NOW + 10000,
      });
      journal.copier.registerLeaderStream({
        environment: 'OFFLINE_FIXTURE',
        evidence: 'SYNTHETIC',
        leaderAccountId: '01',
        sourceId: 'contained-fixture',
        symbol: 'NDX',
        baselineSequence: 0,
      });
      const { eventId } = journal.copier.recordLeaderEvent(
        leaderEventSchema.parse({
          environment: 'OFFLINE_FIXTURE',
          evidence: 'SYNTHETIC',
          origin: 'ACCEPTED_EVENT',
          leaderAccountId: '01',
          sourceId: 'contained-fixture',
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
      const result = await copier.copyEntry(eventId, intent);
      expect(
        result.every(
          (row) =>
            row.attempt?.outcome.stop === 'VERIFIED' &&
            row.attempt.outcome.target === 'VERIFIED',
        ),
      ).toBe(true);
      await contained.lock();
      copier.lock();
      const count = (await contained.adapter.listAccounts()).filter(
        (account) => account.positions.length,
      ).length;
      expect(count).toBe(2);
      await contained.close();
      await expect(contained.adapter.listAccounts()).rejects.toThrow(
        'CONTAINED_CHANNEL_UNCONFIRMED',
      );
    } finally {
      await contained.close();
      journal.close();
    }
  }, 30000);
  it.each(['LAUNCHER_LOSS', 'GLOBAL_LIFECYCLE'] as const)(
    'revokes authority and removes the owned tree after %s',
    async (fault) => {
      const contained = await createContainedFixture({
        config,
        fixtureTime: NOW,
      });
      const namespace = contained.inspect().proof.namespace;
      const members = readdirSync('/proc')
        .filter((name) => /^\d+$/.test(name))
        .filter((name) => {
          try {
            return readlinkSync(`/proc/${name}/ns/net`) === namespace;
          } catch {
            return false;
          }
        });
      expect(members.length).toBeGreaterThan(3);
      const events: unknown[] = [];
      const listenerStates: string[] = [];
      const refusedCommands: Promise<unknown>[] = [];
      contained.subscribeLifecycle((event) => {
        events.push(event);
        if (event.scope === 'GLOBAL') {
          listenerStates.push(contained.inspect().state);
          refusedCommands.push(
            contained.adapter.listAccounts().catch((error) => error.message),
          );
          refusedCommands.push(
            contained.armFixture().catch((error) => error.message),
          );
        }
      });
      const index = vi
        .mocked(spawn)
        .mock.calls.findLastIndex(([program]) => program === '/usr/bin/bwrap');
      const child = vi.mocked(spawn).mock.results[index]!
        .value as import('node:child_process').ChildProcess;
      const write = vi.spyOn(child.stdin!, 'write');
      write.mockClear();
      if (fault === 'LAUNCHER_LOSS') child.kill('SIGKILL');
      else
        child.stdout!.emit(
          'data',
          Buffer.from(
            JSON.stringify({
              kind: 'LIFECYCLE',
              event: {
                environment: 'OFFLINE_FIXTURE',
                evidence: 'SYNTHETIC',
                scope: 'GLOBAL',
                reason: 'CHANNEL_INTEGRITY_LOST',
                accountId: null,
              },
            }) + '\n',
          ),
        );
      try {
        await vi.waitFor(() =>
          expect(contained.inspect().state).toBe('HALTED'),
        );
        expect(listenerStates.length).toBeGreaterThan(0);
        expect(listenerStates.every((state) => state === 'HALTED')).toBe(true);
        expect(await Promise.all(refusedCommands)).toEqual(
          refusedCommands.map(() => 'CONTAINED_CHANNEL_UNCONFIRMED'),
        );
        expect(write).not.toHaveBeenCalled();
        expect(events).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              scope: 'GLOBAL',
              reason: 'CHANNEL_INTEGRITY_LOST',
            }),
          ]),
        );
        await expect(contained.adapter.listAccounts()).rejects.toThrow(
          'CONTAINED_CHANNEL_UNCONFIRMED',
        );
        await vi.waitFor(() => {
          // Namespace PID 1 teardown kills all members; zombies need not be host-reaped yet.
          expect(
            members.some((name) => {
              if (!existsSync(`/proc/${name}/ns/net`)) return false;
              try {
                return readlinkSync(`/proc/${name}/ns/net`) === namespace;
              } catch {
                return false;
              }
            }),
          ).toBe(false);
        });
      } finally {
        await contained.close();
      }
    },
    15000,
  );
  it('refuses unavailable isolation without ever falling back to an uncontained browser', async () => {
    launchControl.refuse = true;
    try {
      await expect(
        createContainedFixture({ config, fixtureTime: NOW }),
      ).rejects.toThrow('CONTAINMENT_STARTUP_REFUSED');
    } finally {
      launchControl.refuse = false;
    }
  });
  it('refuses a browser path that would broaden the cache mount', async () => {
    const executable = vi
      .spyOn(chromium, 'executablePath')
      .mockReturnValue('/usr/bin/true');
    const before = vi.mocked(spawn).mock.calls.length;
    try {
      await expect(createContainedFixture({ config })).rejects.toThrow(
        'CONTAINMENT_PREREQUISITE_UNAVAILABLE',
      );
      expect(vi.mocked(spawn).mock.calls).toHaveLength(before);
    } finally {
      executable.mockRestore();
    }
  });
  it('rejects arbitrary launcher options and malformed canary targets', async () => {
    await expect(
      createContainedFixture({ config, arbitraryCommand: 'ignored' } as {
        config: typeof config;
      }),
    ).rejects.toThrow('CONTAINMENT_REQUEST_REFUSED');
    const contained = await createContainedFixture({
      config,
      fixtureTime: NOW,
    });
    try {
      await expect(
        contained.probeHostCanaries({ tcpPort: 0, udpPort: 1 }),
      ).rejects.toThrow('CONTAINED_OPERATION_UNCONFIRMED');
    } finally {
      await contained.close();
    }
  }, 15000);
});
