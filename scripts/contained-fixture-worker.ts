import { spawn } from 'node:child_process';
import { createSocket } from 'node:dgram';
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
} from 'node:fs';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type BrowserContext } from 'playwright';
import { z } from 'zod';
import { createManagedFixture } from '../packages/browser-execution/src/managed-fixture.ts';
import { bridgePayloadSchemas } from '../packages/browser-execution/src/bridge/protocol.ts';
import {
  protectionRequestSchema,
  riskConfigSchema,
} from '../packages/core/src/index.ts';
import { ownedMutationRequestSchema } from '../packages/execution/src/owned-mutation-contract.ts';
let profileBrowser: BrowserContext | undefined,
  profileRevoked = false;
const PERSISTENT_ORIGIN = 'http://127.0.0.1:43127';
const MAX_FRAME = 1_000_000;
const empty = z.object({}).strict();
const portsSchema = z
  .object({
    tcpPort: z.number().int().min(1).max(65535),
    udpPort: z.number().int().min(1).max(65535),
  })
  .strict();
const requestSchema = z
  .object({
    id: z.number().int().positive(),
    operation: z.enum([
      'INIT',
      'ARM',
      'LOCK',
      'CONNECT',
      'LIST_ACCOUNTS',
      'ACCOUNT',
      'QUOTE',
      'ENTRY',
      'ORDER',
      'PROTECTION',
      'PROTECTION_ORDER',
      'OPEN_ORDERS',
      'CANCEL',
      'OWNED_FLATTEN',
      'OWNED_PROTECTION',
      'OWNED_ADD',
      'OWNED_REDUCE',
      'OWNED_CLOSE',
      'OWNED_CHANGE',
      'OWNED_RECEIPT',
      'PROBE_CANARIES',
      'PROFILE_CANARY',
      'CLOSE',
    ]),
    payload: z.unknown(),
  })
  .strict();
const namespaceSchema = z.string().regex(/^net:\[\d+\]$/);
let fixture: Awaited<ReturnType<typeof createManagedFixture>> | undefined,
  expectedNamespace: string | undefined,
  buffer = '',
  active = 0,
  closing = false,
  previousId = 0;
const send = (value: unknown) => {
  const frame = `${JSON.stringify(value)}\n`;
  if (Buffer.byteLength(frame) > MAX_FRAME) process.exit(2);
  process.stdout.write(frame);
};
function verifyKernel() {
  const namespace = readlinkSync('/proc/self/ns/net');
  if (!expectedNamespace || namespace !== expectedNamespace)
    throw new Error('NAMESPACE_UNPROVEN');
  const interfaces = readFileSync('/proc/net/dev', 'utf8')
    .split('\n')
    .filter((line) => line.includes(':'))
    .map((line) => line.split(':')[0]!.trim());
  if (interfaces.length !== 1 || interfaces[0] !== 'lo')
    throw new Error('NAMESPACE_UNPROVEN');
  let chromiumProcesses = 0;
  for (const name of readdirSync('/proc').filter((name) =>
    /^\d+$/.test(name),
  )) {
    try {
      const processNamespace = readlinkSync(`/proc/${name}/ns/net`);
      if (processNamespace !== namespace) throw new Error('NAMESPACE_UNPROVEN');
      if (/^(chrome|chromium)/.test(readFileSync(`/proc/${name}/comm`, 'utf8')))
        chromiumProcesses++;
    } catch (error) {
      if (
        (error as NodeJS.ErrnoException).code !== 'ENOENT' &&
        (error as NodeJS.ErrnoException).code !== 'ESRCH'
      )
        throw error;
    }
  }
  return {
    environment: 'OFFLINE_FIXTURE' as const,
    evidence: 'SYNTHETIC' as const,
    namespace,
    onlyLoopback: true as const,
    chromiumProcesses,
    descendantNamespacesMatch: true as const,
  };
}
async function nodeCanaries(ports: z.infer<typeof portsSchema>) {
  const tcpBlocked = await new Promise<boolean>((resolve) => {
    const socket = createConnection({ host: '127.0.0.1', port: ports.tcpPort });
    socket.setTimeout(700);
    socket.once('connect', () => {
      socket.destroy();
      resolve(false);
    });
    socket.once('error', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('timeout', () => {
      socket.destroy();
      resolve(true);
    });
  });
  const udp = createSocket('udp4');
  await new Promise<void>((resolve, reject) => {
    udp.once('error', reject);
    udp.send(
      Buffer.from('SYNTHETIC_CONTAINMENT_CANARY'),
      ports.udpPort,
      '127.0.0.1',
      (error) => (error ? reject(error) : resolve()),
    );
  });
  udp.close();
  return {
    descendantTcpBlocked: tcpBlocked,
    descendantUdpAttempted: true,
    namespace: readlinkSync('/proc/self/ns/net'),
  };
}
async function descendant(ports: z.infer<typeof portsSchema>) {
  const child = spawn(
    process.execPath,
    ['--import', 'tsx', fileURLToPath(import.meta.url), '--canary-descendant'],
    { stdio: ['pipe', 'pipe', 'pipe'], env: process.env },
  );
  child.stderr.resume();
  let bytes = '';
  child.stdout.on('data', (data: Buffer) => {
    bytes += data.toString('utf8');
    if (bytes.length > MAX_FRAME) child.kill('SIGKILL');
  });
  const exited = new Promise<number | null>((resolve) =>
    child.once('exit', resolve),
  );
  child.stdin.end(JSON.stringify({ ...ports, namespace: expectedNamespace }));
  const timer = setTimeout(() => child.kill('SIGKILL'), 2000);
  const code = await exited;
  clearTimeout(timer);
  if (code !== 0) throw new Error('DESCENDANT_UNPROVEN');
  const proof = z
    .object({
      descendantTcpBlocked: z.boolean(),
      descendantUdpAttempted: z.literal(true),
      namespace: namespaceSchema,
    })
    .strict()
    .parse(JSON.parse(bytes));
  if (proof.namespace !== expectedNamespace)
    throw new Error('DESCENDANT_UNPROVEN');
  return proof;
}
async function browserCanaries(ports: z.infer<typeof portsSchema>) {
  const profile = mkdtempSync(join(tmpdir(), 'contained-kernel-probe-'));
  const browser = await chromium.launchPersistentContext(profile, {
    headless: true,
    serviceWorkers: 'block',
    args: [
      '--disable-background-networking',
      '--disable-component-update',
      '--disable-sync',
      '--disable-default-apps',
      '--no-default-browser-check',
    ],
  });
  try {
    const page = browser.pages()[0] ?? (await browser.newPage());
    let browserTcpBlocked = false;
    try {
      await page.goto(`http://127.0.0.1:${ports.tcpPort}/kernel-canary`, {
        timeout: 1000,
      });
    } catch {
      browserTcpBlocked = true;
    }
    await page.close();
    const udpPage = await browser.newPage();
    await udpPage.evaluate(async (udpPort) => {
      const peer = new RTCPeerConnection({
        iceServers: [{ urls: `stun:127.0.0.1:${udpPort}` }],
      });
      try {
        peer.createDataChannel('synthetic-canary');
        await peer.setLocalDescription(await peer.createOffer());
        await new Promise((resolve) => setTimeout(resolve, 900));
      } finally {
        peer.close();
      }
    }, ports.udpPort);
    return {
      browserTcpBlocked,
      browserStunConfigured: true,
      proof: verifyKernel(),
    };
  } finally {
    await browser.close();
    rmSync(profile, { recursive: true, force: true });
  }
}
async function profileCanary(mode: 'SEED' | 'CHECK') {
  if (
    !fixture ||
    !profileBrowser ||
    profileRevoked ||
    fixture.inspect().state !== 'READY'
  )
    throw new Error('PROFILE_CANARY_UNPROVEN');
  const expected = fixture
    .inspect()
    .contexts.find((value) => value.accountId === '01');
  if (!expected?.ready) throw new Error('PROFILE_CANARY_UNPROVEN');
  const expectedIdentity = {
    accountId: expected.accountId,
    contextId: expected.contextId,
    generation: expected.generation,
    environment: expected.environment,
    evidence: expected.evidence,
  };
  const pages = profileBrowser
    .pages()
    .filter(
      (value) =>
        value.url() === `${PERSISTENT_ORIGIN}/context/${expected.contextId}`,
    );
  if (pages.length !== 1) throw new Error('PROFILE_CANARY_UNPROVEN');
  const page = pages[0]!;
  const verify = async () => {
    if (
      profileRevoked ||
      fixture!.inspect().state !== 'READY' ||
      page.url() !== `${PERSISTENT_ORIGIN}/context/${expected.contextId}`
    )
      throw new Error('PROFILE_CANARY_UNPROVEN');
    const actual = await page.evaluate(
      () =>
        (globalThis as unknown as { fixture: { identity: unknown } }).fixture
          .identity,
    );
    if (JSON.stringify(actual) !== JSON.stringify(expectedIdentity))
      throw new Error('PROFILE_CANARY_UNPROVEN');
    await fixture!.adapter.getAccountState('01');
  };
  await verify();
  const prior = await page.evaluate(() => ({
    cookiePreviouslyPresent: document.cookie
      .split('; ')
      .includes('fixture_canary=SYNTHETIC_PROFILE_CANARY'),
    storagePreviouslyPresent:
      localStorage.getItem('fixture_canary') === 'SYNTHETIC_PROFILE_CANARY',
  }));
  if (mode === 'SEED') {
    await profileBrowser.addCookies([
      {
        name: 'fixture_canary',
        value: 'SYNTHETIC_PROFILE_CANARY',
        url: PERSISTENT_ORIGIN,
        expires: Date.now() / 1000 + 86400,
        sameSite: 'Strict',
      },
    ]);
    await page.evaluate(() => {
      localStorage.setItem('fixture_canary', 'SYNTHETIC_PROFILE_CANARY');
    });
  }
  await verify();
  const current = await page.evaluate(() => ({
    cookiePresent: document.cookie
      .split('; ')
      .includes('fixture_canary=SYNTHETIC_PROFILE_CANARY'),
    storagePresent:
      localStorage.getItem('fixture_canary') === 'SYNTHETIC_PROFILE_CANARY',
  }));
  return { ...prior, ...current };
}
async function execute(
  operation: z.infer<typeof requestSchema>['operation'],
  payload: unknown,
) {
  if (operation === 'INIT') {
    if (fixture || expectedNamespace) throw new Error();
    const input = z
      .object({
        config: riskConfigSchema,
        persistentProfile: z.boolean(),
        fixtureTime: z.number().int().nonnegative().optional(),
        parentNamespace: namespaceSchema,
      })
      .strict()
      .parse(payload);
    const current = readlinkSync('/proc/self/ns/net');
    if (current === input.parentNamespace) throw new Error();
    expectedNamespace = current;
    verifyKernel();
    const originalLaunch = chromium.launchPersistentContext;
    if (input.persistentProfile) {
      chromium.launchPersistentContext = async (path, options) => {
        if (
          path !== '/tmp/owned-browser-profile' ||
          options?.headless !== true ||
          profileBrowser
        )
          throw new Error('PROFILE_CAPTURE_UNPROVEN');
        const captured = await originalLaunch.call(chromium, path, options);
        if (profileBrowser) {
          await captured.close();
          throw new Error('PROFILE_CAPTURE_UNPROVEN');
        }
        profileBrowser = captured;
        return captured;
      };
    }
    try {
      fixture = await createManagedFixture(
        input.config,
        input.fixtureTime === undefined ? Date.now : () => input.fixtureTime!,
        input.persistentProfile,
      );
    } finally {
      chromium.launchPersistentContext = originalLaunch;
    }
    if (input.persistentProfile && !profileBrowser)
      throw new Error('PROFILE_CAPTURE_UNPROVEN');
    fixture.subscribeLifecycle((event) => {
      if (event.scope === 'GLOBAL') profileRevoked = true;
      send({ kind: 'LIFECYCLE', event });
    });
    const proof = verifyKernel();
    if (proof.chromiumProcesses < 1) throw new Error();
    return proof;
  }
  if (!fixture || closing) throw new Error();
  verifyKernel();
  const adapter = fixture.adapter;
  switch (operation) {
    case 'ARM':
      empty.parse(payload);
      await fixture.armFixture();
      return 'ARMED';
    case 'LOCK':
      empty.parse(payload);
      fixture.lock();
      return 'LOCKED';
    case 'CONNECT':
      empty.parse(payload);
      await adapter.connect();
      return null;
    case 'LIST_ACCOUNTS':
      empty.parse(payload);
      return adapter.listAccounts();
    case 'ACCOUNT':
      return adapter.getAccountState(
        bridgePayloadSchemas.ACCOUNT.parse(payload).accountId,
      );
    case 'QUOTE':
      empty.parse(payload);
      return adapter.getQuote();
    case 'ENTRY':
      return adapter.placeOrder(bridgePayloadSchemas.ENTRY.parse(payload));
    case 'ORDER':
      return adapter.getOrder(
        z
          .object({ requestId: z.string().min(1).max(100) })
          .strict()
          .parse(payload).requestId,
      );
    case 'PROTECTION':
      return adapter.placeProtectionOrder(
        protectionRequestSchema.parse(payload),
      );
    case 'PROTECTION_ORDER': {
      const ref = bridgePayloadSchemas.PROTECTION_ORDER.parse(payload);
      return adapter.getProtectionOrder(ref.accountId, ref.orderId);
    }
    case 'OPEN_ORDERS':
      return adapter.getOpenOrders(
        bridgePayloadSchemas.OPEN_ORDERS.parse(payload).accountId,
      );
    case 'CANCEL': {
      const ref = bridgePayloadSchemas.CANCEL.parse(payload);
      await adapter.cancelOrder(ref.accountId, ref.orderId);
      return null;
    }
    case 'OWNED_FLATTEN':
      await adapter.flattenOwnedPosition(
        z
          .object({
            accountId: z.string().regex(/^0[1-9]$|^10$/),
            entryRequestId: z.string().min(1).max(100),
            expectedRevision: z.number().int().nonnegative(),
          })
          .strict()
          .parse(payload),
      );
      return null;
    case 'OWNED_PROTECTION': {
      const ref = z
        .object({
          order: protectionRequestSchema,
          expectedRevision: z.number().int().nonnegative(),
        })
        .strict()
        .parse(payload);
      return adapter.repairOwnedProtection(ref.order, ref.expectedRevision);
    }
    case 'OWNED_ADD': {
      const ref = ownedMutationRequestSchema.parse(payload);
      if (ref.operation !== 'ADD') throw new Error();
      return adapter.addOwnedPosition(ref);
    }
    case 'OWNED_REDUCE': {
      const ref = ownedMutationRequestSchema.parse(payload);
      if (ref.operation !== 'REDUCE') throw new Error();
      return adapter.reduceOwnedPosition(ref);
    }
    case 'OWNED_CLOSE': {
      const ref = ownedMutationRequestSchema.parse(payload);
      if (ref.operation !== 'CLOSE') throw new Error();
      return adapter.closeOwnedPosition(ref);
    }
    case 'OWNED_CHANGE': {
      const ref = ownedMutationRequestSchema.parse(payload);
      if (!['STOP_CHANGED', 'TARGET_CHANGED'].includes(ref.operation))
        throw new Error();
      return adapter.changeOwnedProtection(
        ref as typeof ref & { operation: 'STOP_CHANGED' | 'TARGET_CHANGED' },
      );
    }
    case 'OWNED_RECEIPT':
      return adapter.readOwnedMutation(
        z
          .object({ requestId: z.string().regex(/^[a-f0-9]{64}$/) })
          .strict()
          .parse(payload).requestId,
      );
    case 'PROBE_CANARIES': {
      const ports = portsSchema.parse(payload);
      let child: Awaited<ReturnType<typeof descendant>>,
        browser: Awaited<ReturnType<typeof browserCanaries>>;
      try {
        child = await descendant(ports);
      } catch {
        throw new Error('CONTAINED_PROBE_DESCENDANT_UNPROVEN');
      }
      try {
        browser = await browserCanaries(ports);
      } catch {
        throw new Error('CONTAINED_PROBE_BROWSER_UNPROVEN');
      }
      return {
        ...browser,
        descendantTcpBlocked: child.descendantTcpBlocked,
        descendantUdpAttempted: child.descendantUdpAttempted,
      };
    }
    case 'PROFILE_CANARY':
      return profileCanary(
        z
          .object({ mode: z.enum(['SEED', 'CHECK']) })
          .strict()
          .parse(payload).mode,
      );
    case 'CLOSE':
      empty.parse(payload);
      closing = true;
      await fixture.close();
      return { browserClosed: true };
  }
}
if (process.argv[2] === '--canary-descendant') {
  let input = '';
  for await (const chunk of process.stdin) {
    input += String(chunk);
    if (input.length > MAX_FRAME) process.exit(2);
  }
  try {
    const parsed = portsSchema
      .extend({ namespace: namespaceSchema })
      .strict()
      .parse(JSON.parse(input));
    if (readlinkSync('/proc/self/ns/net') !== parsed.namespace)
      throw new Error();
    process.stdout.write(JSON.stringify(await nodeCanaries(parsed)));
    process.exit(0);
  } catch {
    process.exit(2);
  }
} else {
  process.stdin.on('data', (chunk: Buffer) => {
    buffer += chunk.toString('utf8');
    if (Buffer.byteLength(buffer) > MAX_FRAME) process.exit(2);
    while (buffer.includes('\n')) {
      const at = buffer.indexOf('\n'),
        frame = buffer.slice(0, at);
      buffer = buffer.slice(at + 1);
      let request: z.infer<typeof requestSchema>;
      try {
        request = requestSchema.parse(JSON.parse(frame));
        if (request.id <= previousId || active >= 32) throw new Error();
        previousId = request.id;
      } catch {
        process.exit(2);
      }
      active++;
      void execute(request.operation, request.payload)
        .then(
          (result) =>
            send({ kind: 'RESULT', id: request.id, ok: true, result }),
          (error: unknown) =>
            send({
              kind: 'RESULT',
              id: request.id,
              ok: false,
              error:
                error instanceof Error &&
                [
                  'CONTAINED_PROBE_DESCENDANT_UNPROVEN',
                  'CONTAINED_PROBE_BROWSER_UNPROVEN',
                ].includes(error.message)
                  ? error.message
                  : 'CONTAINED_OPERATION_UNCONFIRMED',
            }),
        )
        .finally(() => {
          active--;
          if (closing) process.exit(0);
        });
    }
  });
  const stop = async () => {
    closing = true;
    await fixture?.close().catch(() => {});
    process.exit(0);
  };
  process.stdin.once('end', () => {
    void stop();
  });
  process.once('SIGTERM', () => {
    void stop();
  });
}
