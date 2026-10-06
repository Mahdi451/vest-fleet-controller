import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  readlinkSync,
  realpathSync,
  readFileSync,
  readdirSync,
} from 'node:fs';
import { acquireManagedProfile } from './managed-profile.ts';
import { userInfo } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { z } from 'zod';
import {
  riskConfigSchema,
  type RiskConfig,
  type ProtectionRequest,
  type Account,
  type Quote,
  type ProtectionOrder,
} from '../../core/src/index.ts';
import type { OrderRequest, OrderResult } from '../../execution/src/adapter.ts';
import type {
  OwnedMutationRequest,
  OwnedMutationReceipt,
} from '../../execution/src/owned-mutation-contract.ts';
import type { ManagedFixtureLifecycle } from '../../browser-execution/src/managed-fixture.ts';
const MAX_FRAME = 1_000_000,
  MAX_PENDING = 32;
const proofSchema = z
  .object({
    environment: z.literal('OFFLINE_FIXTURE'),
    evidence: z.literal('SYNTHETIC'),
    namespace: z.string().regex(/^net:\[\d+\]$/),
    onlyLoopback: z.literal(true),
    chromiumProcesses: z.number().int().positive(),
    descendantNamespacesMatch: z.literal(true),
  })
  .strict();
export type BrowserContainmentProof = z.infer<typeof proofSchema>;
const lifecycleSchema = z
  .object({
    environment: z.literal('OFFLINE_FIXTURE'),
    evidence: z.literal('SYNTHETIC'),
    scope: z.enum(['ACCOUNT', 'GLOBAL']),
    reason: z.enum([
      'CONTEXT_LOST',
      'IDENTITY_UNCERTAIN',
      'CHANNEL_INTEGRITY_LOST',
    ]),
    accountId: z.string().nullable(),
  })
  .strict();
const responseSchema = z.union([
  z
    .object({
      kind: z.literal('RESULT'),
      id: z.number().int().positive(),
      ok: z.literal(true),
      result: z.unknown(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('RESULT'),
      id: z.number().int().positive(),
      ok: z.literal(false),
      error: z.enum([
        'CONTAINED_REQUEST_REFUSED',
        'CONTAINED_OPERATION_UNCONFIRMED',
        'CONTAINED_PROBE_DESCENDANT_UNPROVEN',
        'CONTAINED_PROBE_BROWSER_UNPROVEN',
      ]),
    })
    .strict(),
  z.object({ kind: z.literal('LIFECYCLE'), event: lifecycleSchema }).strict(),
]);
const refuse = (code: string): never => {
  throw new Error(code);
};
function regular(path: string) {
  if (
    !existsSync(path) ||
    lstatSync(path).isSymbolicLink() ||
    !lstatSync(path).isFile()
  )
    refuse('CONTAINMENT_PREREQUISITE_UNAVAILABLE');
}
function processIdentity(pid: number) {
  const fields = readFileSync(`/proc/${pid}/stat`, 'utf8')
    .split(') ')
    .slice(1)
    .join(') ')
    .trim()
    .split(/\s+/);
  if (!fields[19] || !fields[0]) throw new Error('OWNED_TREE_UNPROVEN');
  return { started: fields[19], state: fields[0] };
}
function captureOwnedTree(root: number) {
  const members = new Map<number, string>(),
    queue = [root];
  while (queue.length) {
    const pid = queue.shift()!;
    if (members.has(pid)) continue;
    if (members.size >= 512) throw new Error('OWNED_TREE_UNPROVEN');
    try {
      members.set(pid, processIdentity(pid).started);
      const tasks = readdirSync(`/proc/${pid}/task`);
      if (tasks.length > 1024 || tasks.some((task) => !/^\d+$/.test(task)))
        throw new Error('OWNED_TREE_UNPROVEN');
      for (const task of tasks) {
        try {
          const children = readFileSync(
            `/proc/${pid}/task/${task}/children`,
            'utf8',
          ).trim();
          for (const child of children ? children.split(/\s+/) : []) {
            if (!/^\d+$/.test(child)) throw new Error('OWNED_TREE_UNPROVEN');
            if (!members.has(Number(child)) && !queue.includes(Number(child)))
              queue.push(Number(child));
          }
        } catch (error) {
          if (
            !['ENOENT', 'ESRCH'].includes(
              (error as NodeJS.ErrnoException).code ?? '',
            )
          )
            throw new Error('OWNED_TREE_UNPROVEN');
        }
      }
      if (processIdentity(pid).started !== members.get(pid))
        throw new Error('OWNED_TREE_UNPROVEN');
    } catch (error) {
      if (
        pid === root ||
        !['ENOENT', 'ESRCH'].includes(
          (error as NodeJS.ErrnoException).code ?? '',
        )
      )
        throw new Error('OWNED_TREE_UNPROVEN');
    }
  }
  return members;
}
function ownedTreeGone(members: Map<number, string>) {
  for (const [pid, started] of members) {
    try {
      const actual = processIdentity(pid);
      if (actual.started === started && actual.state !== 'Z') return false;
    } catch (error) {
      if (
        !['ENOENT', 'ESRCH'].includes(
          (error as NodeJS.ErrnoException).code ?? '',
        )
      )
        return false;
    }
  }
  return true;
}
/** Fixed Linux namespace launcher. No caller-controlled program, route or browser arguments. */
export async function createContainedFixture(input: {
  config: RiskConfig;
  fixtureTime?: number;
  ownedProfile?: { directory: string; ownerId: string };
}) {
  if (process.platform !== 'linux')
    return refuse('CONTAINMENT_PLATFORM_UNPROVEN');
  const parsed = z
    .object({
      config: riskConfigSchema,
      fixtureTime: z.number().int().nonnegative().optional(),
      ownedProfile: z
        .object({ directory: z.string().min(1), ownerId: z.string().uuid() })
        .strict()
        .optional(),
    })
    .strict()
    .safeParse(input);
  if (!parsed.success) return refuse('CONTAINMENT_REQUEST_REFUSED');
  const namespace = readlinkSync('/proc/self/ns/net');
  const root = realpathSync(
    fileURLToPath(new URL('../../../', import.meta.url)),
  );
  const worker = join(root, 'scripts/contained-fixture-worker.ts'),
    launcher = '/usr/bin/bwrap';
  regular(launcher);
  regular(worker);
  regular(process.execPath);
  const browserPath = chromium.executablePath();
  regular(browserPath);
  const browserCache = dirname(dirname(dirname(browserPath)));
  // Refuse environment-driven broad filesystem mounts; no custom cache fallback.
  if (
    browserCache !== join(userInfo().homedir, '.cache/ms-playwright') ||
    realpathSync(browserCache) !== browserCache
  )
    return refuse('CONTAINMENT_PREREQUISITE_UNAVAILABLE');
  const sourceMounts = [
    'package.json',
    'tsconfig.json',
    'node_modules',
    'packages/browser-execution/src',
    'packages/core/src',
    'packages/execution/src',
    'packages/risk-engine/src',
    'packages/simulator/src',
    'scripts/contained-fixture-worker.ts',
  ].flatMap((relative) => {
    const path = join(root, relative);
    if (lstatSync(path).isSymbolicLink() || realpathSync(path) !== path)
      return refuse('CONTAINMENT_PREREQUISITE_UNAVAILABLE');
    return ['--ro-bind', path, path];
  });
  const lease = parsed.data.ownedProfile
    ? acquireManagedProfile(parsed.data.ownedProfile)
    : undefined;
  const profileMount = lease
    ? [
        '--bind',
        lease.profilePath,
        '/tmp/owned-browser-profile',
        '--setenv',
        'VEST_FIXTURE_PERSISTENT_PROFILE',
        '1',
      ]
    : [];
  const args = [
    '--unshare-user',
    '--unshare-net',
    '--unshare-pid',
    '--unshare-ipc',
    '--disable-userns',
    '--assert-userns-disabled',
    '--die-with-parent',
    '--new-session',
    '--cap-drop',
    'ALL',
    '--clearenv',
    '--ro-bind',
    '/usr',
    '/usr',
    '--symlink',
    'usr/bin',
    '/bin',
    '--symlink',
    'usr/lib',
    '/lib',
    '--symlink',
    'usr/lib64',
    '/lib64',
    '--proc',
    '/proc',
    '--dev',
    '/dev',
    '--tmpfs',
    '/tmp',
    '--dir',
    '/tmp/fixture-home',
    '--dir',
    '/etc',
    '--ro-bind',
    '/etc/fonts',
    '/etc/fonts',
    '--ro-bind',
    '/etc/ld.so.cache',
    '/etc/ld.so.cache',
    '--ro-bind',
    realpathSync(process.execPath),
    realpathSync(process.execPath),
    ...sourceMounts,
    ...profileMount,
    '--ro-bind',
    browserCache,
    browserCache,
    '--setenv',
    'HOME',
    '/tmp/fixture-home',
    '--setenv',
    'PLAYWRIGHT_BROWSERS_PATH',
    browserCache,
    '--setenv',
    'PATH',
    '/usr/bin:/bin',
    '--chdir',
    root,
    process.execPath,
    '--import',
    'tsx',
    worker,
  ];
  let state: 'STARTING' | 'READY' | 'HALTED' | 'CLOSED' = 'STARTING',
    closing = false,
    next = 1,
    buffer = '';
  const listeners = new Set<(event: ManagedFixtureLifecycle) => void>();
  const pending = new Map<
    number,
    {
      resolve(value: unknown): void;
      reject(error: Error): void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  let child: ChildProcessWithoutNullStreams;
  try {
    child = spawn(launcher, args, {
      cwd: root,
      env: {},
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
  } catch {
    lease?.release();
    return refuse('CONTAINMENT_STARTUP_REFUSED');
  }
  let exitCode: number | null = null;
  let uncertain = false;
  const exited = new Promise<void>((resolveExit) => {
    child.once('exit', (code) => {
      exitCode = code;
      resolveExit();
    });
    child.once('error', () => resolveExit());
  });
  const failAll = () => {
    uncertain = true;
    if (state !== 'CLOSED') state = 'HALTED';
    for (const operation of pending.values()) {
      clearTimeout(operation.timer);
      operation.reject(new Error('CONTAINED_CHANNEL_UNCONFIRMED'));
    }
    pending.clear();
    const event: ManagedFixtureLifecycle = {
      environment: 'OFFLINE_FIXTURE',
      evidence: 'SYNTHETIC',
      scope: 'GLOBAL',
      reason: 'CHANNEL_INTEGRITY_LOST',
      accountId: null,
    };
    for (const listener of listeners) {
      try {
        listener(event);
      } catch {
        /* Observer cannot restore authority. */
      }
    }
    child.kill('SIGKILL');
  };
  child.once('error', failAll);
  child.once('exit', () => {
    if (!closing) failAll();
  });
  // Never forward worker diagnostics, payloads or provider errors to the dashboard/log.
  child.stderr.resume();
  child.stdout.on('data', (chunk: Buffer) => {
    buffer += chunk.toString('utf8');
    if (Buffer.byteLength(buffer) > MAX_FRAME) {
      failAll();
      return;
    }
    while (buffer.includes('\n')) {
      const at = buffer.indexOf('\n'),
        frame = buffer.slice(0, at);
      buffer = buffer.slice(at + 1);
      try {
        const response = responseSchema.parse(JSON.parse(frame));
        if (response.kind === 'LIFECYCLE') {
          if (response.event.scope === 'GLOBAL' && !closing) state = 'HALTED';
          for (const listener of listeners) {
            try {
              listener(structuredClone(response.event));
            } catch {
              /* Isolated observer. */
            }
          }
          if (response.event.scope === 'GLOBAL' && !closing) failAll();
          continue;
        }
        const operation = pending.get(response.id);
        if (!operation) throw new Error();
        pending.delete(response.id);
        clearTimeout(operation.timer);
        if (response.ok) operation.resolve(response.result);
        else operation.reject(new Error(response.error));
      } catch {
        failAll();
      }
    }
  });
  function call<T>(operation: string, payload: unknown): Promise<T> {
    if (
      closing ||
      state === 'HALTED' ||
      state === 'CLOSED' ||
      pending.size >= MAX_PENDING ||
      next > Number.MAX_SAFE_INTEGER
    )
      return Promise.reject(new Error('CONTAINED_CHANNEL_UNCONFIRMED'));
    const id = next++,
      frame = `${JSON.stringify({ id, operation, payload })}\n`;
    if (Buffer.byteLength(frame) > MAX_FRAME)
      return Promise.reject(new Error('CONTAINED_REQUEST_REFUSED'));
    return new Promise<T>((resolveCall, reject) => {
      const timer = setTimeout(failAll, 15000);
      pending.set(id, {
        resolve: (value) => resolveCall(value as T),
        reject,
        timer,
      });
      child.stdin.write(frame, (error) => {
        if (error) failAll();
      });
    });
  }
  let proof: BrowserContainmentProof;
  try {
    proof = proofSchema.parse(
      await call('INIT', {
        config: parsed.data.config,
        ...(parsed.data.fixtureTime === undefined
          ? {}
          : { fixtureTime: parsed.data.fixtureTime }),
        persistentProfile: !!lease,
        parentNamespace: namespace,
      }),
    );
    if (proof.namespace === namespace) throw new Error();
    state = 'READY';
  } catch {
    closing = true;
    child.kill('SIGKILL');
    await exited;
    lease?.retainLease();
    return refuse('CONTAINMENT_STARTUP_REFUSED');
  }
  const close = async () => {
    if (closing) {
      await exited;
      return;
    }
    let confirmed = false;
    let ownedMembers: Map<number, string> | undefined;
    if (lease) {
      try {
        if (!child.pid) throw new Error();
        ownedMembers = captureOwnedTree(child.pid);
      } catch {
        uncertain = true;
      }
    }
    try {
      const shutdown = call('CLOSE', {});
      closing = true;
      const receipt = z
        .object({ browserClosed: z.literal(true) })
        .strict()
        .parse(await shutdown);
      confirmed = receipt.browserClosed;
    } catch {
      uncertain = true;
      /* Termination still enforced below. */
    }
    closing = true;
    state = 'CLOSED';
    child.stdin.end();
    const deadline = setTimeout(() => {
      uncertain = true;
      child.kill('SIGKILL');
    }, 3000);
    await exited;
    clearTimeout(deadline);
    if (
      lease &&
      confirmed &&
      !uncertain &&
      exitCode === 0 &&
      ownedMembers &&
      ownedTreeGone(ownedMembers)
    )
      lease.release();
    else lease?.retainLease();
  };
  const adapter = {
    name: 'KernelContainedBrowser:OFFLINE_FIXTURE',
    mode: 'SIMULATION' as const,
    environment: 'OFFLINE_FIXTURE' as const,
    scheduling: 'ACCOUNT_LANES' as const,
    status: () =>
      state === 'READY'
        ? 'CONNECTED'
        : state === 'CLOSED'
          ? 'CLOSED'
          : 'QUARANTINED',
    connect: async () => {
      await call('CONNECT', {});
    },
    disconnect: close,
    listAccounts: () => call<Account[]>('LIST_ACCOUNTS', {}),
    getAccountState: (accountId: string) =>
      call<Account>('ACCOUNT', { accountId }),
    getQuote: () => call<Quote>('QUOTE', {}),
    placeOrder: (order: OrderRequest) => call<OrderResult>('ENTRY', order),
    getOrder: (requestId: string) =>
      call<OrderResult | null>('ORDER', { requestId }),
    placeProtectionOrder: (order: ProtectionRequest) =>
      call<ProtectionOrder>('PROTECTION', order),
    getProtectionOrder: (accountId: string, orderId: string) =>
      call<ProtectionOrder | null>('PROTECTION_ORDER', { accountId, orderId }),
    getOpenOrders: (accountId: string) =>
      call<ProtectionOrder[]>('OPEN_ORDERS', { accountId }),
    cancelOrder: async (accountId: string, orderId: string) => {
      await call('CANCEL', { accountId, orderId });
    },
    flattenAccount: async (accountId: string): Promise<void> => {
      if (!/^0[1-9]$|^10$/.test(accountId))
        throw new Error('CONTAINED_REQUEST_REFUSED');
      throw new Error('CONTAINED_OWNERSHIP_REQUIRED');
    },
    flattenOwnedPosition: async (scope: {
      accountId: string;
      entryRequestId: string;
      expectedRevision: number;
    }) => {
      await call('OWNED_FLATTEN', scope);
    },
    repairOwnedProtection: (
      order: ProtectionRequest,
      expectedRevision: number,
    ) => call<ProtectionOrder>('OWNED_PROTECTION', { order, expectedRevision }),
    addOwnedPosition: (request: OwnedMutationRequest & { operation: 'ADD' }) =>
      call<OwnedMutationReceipt>('OWNED_ADD', request),
    reduceOwnedPosition: (
      request: OwnedMutationRequest & { operation: 'REDUCE' },
    ) => call<OwnedMutationReceipt>('OWNED_REDUCE', request),
    closeOwnedPosition: (
      request: OwnedMutationRequest & { operation: 'CLOSE' },
    ) => call<OwnedMutationReceipt>('OWNED_CLOSE', request),
    changeOwnedProtection: (
      request: OwnedMutationRequest & {
        operation: 'STOP_CHANGED' | 'TARGET_CHANGED';
      },
    ) => call<OwnedMutationReceipt>('OWNED_CHANGE', request),
    readOwnedMutation: (requestId: string) =>
      call<OwnedMutationReceipt | null>('OWNED_RECEIPT', { requestId }),
  };
  return {
    adapter,
    async probeProfilePersistence(mode: 'SEED' | 'CHECK') {
      const result = z
        .object({
          cookiePreviouslyPresent: z.boolean(),
          storagePreviouslyPresent: z.boolean(),
          cookiePresent: z.boolean(),
          storagePresent: z.boolean(),
        })
        .strict()
        .safeParse(await call('PROFILE_CANARY', { mode }));
      if (!result.success) {
        failAll();
        throw new Error('CONTAINED_CHANNEL_UNCONFIRMED');
      }
      return result.data;
    },
    close,
    armFixture: async () => {
      await call('ARM', {});
    },
    lock: async () => {
      await call('LOCK', {});
    },
    inspect: () => ({
      environment: 'OFFLINE_FIXTURE' as const,
      evidence: 'SYNTHETIC' as const,
      state,
      proof: structuredClone(proof),
      liveState: 'LOCKED' as const,
    }),
    subscribeLifecycle(listener: (event: ManagedFixtureLifecycle) => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    probeHostCanaries: (ports: { tcpPort: number; udpPort: number }) =>
      call<{
        browserTcpBlocked: boolean;
        descendantTcpBlocked: boolean;
        descendantUdpAttempted: boolean;
        browserStunConfigured: boolean;
        proof: BrowserContainmentProof;
      }>('PROBE_CANARIES', ports),
  };
}
