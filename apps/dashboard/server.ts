import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { realpath } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { parse } from 'yaml';
import { z } from 'zod';
import {
  intentSchema,
  positive,
  riskConfigSchema,
  type RiskConfig,
} from '../../packages/core/src/index.ts';
import { MockVestAdapter } from '../../packages/simulator/src/index.ts';
import { FleetController } from '../../packages/execution/src/controller.ts';
import { SimulationStore } from '../../packages/simulator/src/storage.ts';
import type { Journal } from '../../packages/execution/src/journal.ts';
import {
  LIVE_VEST_SEND,
  observeVestTicket,
  planSequentialCopy,
} from '../../packages/browser-execution/src/live-command.ts';
import { unprovenCopierStatus } from '../../packages/browser-execution/src/copier-status.ts';
import { envelope, hash } from './src/commands.ts';
import { loadLocalIdentity } from './src/identity.ts';
import { loadPrivateAccess, type PrivateAccess } from './src/private-access.ts';
import { createCopierSimulation } from './src/copier-simulation.ts';

const previewSchema = z
  .object({
    intent: intentSchema,
    selected: z.array(z.string()).min(1).max(10),
  })
  .strict();
const legacyExecuteSchema = z
  .object({
    masterTradeId: z.string().uuid(),
    previewId: z.string().length(64),
    sessionId: z.string().uuid(),
  })
  .strict();
const executeSchema = z
  .object({
    commandId: z.string().regex(/^[a-f0-9]{64}$/),
    payloadHash: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
const enabledSchema = z
  .object({
    accountId: z.string().regex(/^0[1-9]$|^10$/),
    enabled: z.boolean(),
  })
  .strict();
async function body(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += Buffer.byteLength(chunk);
    if (size > 16384) throw new Error('BODY_TOO_LARGE');
    chunks.push(Buffer.from(chunk));
  }
  return JSON.parse(Buffer.concat(chunks).toString());
}

export async function createDashboard(
  config: RiskConfig,
  journalDirectory?: string,
  startNew = false,
  access?: PrivateAccess,
  options: { now?: () => number } = {},
) {
  // Simulation evidence and commands share one domain clock; access expiry is separate.
  const now = options.now ?? (() => Date.now());
  const token = randomUUID();
  if (
    access &&
    (!journalDirectory ||
      (await realpath(journalDirectory)) !== access.config.runtimeDirectory)
  )
    throw new Error('EXECUTION_INSTANCE_MISMATCH');
  const store = new SimulationStore(journalDirectory);
  let identity: { ownerId: string; instanceId: string };
  try {
    identity = journalDirectory
      ? await loadLocalIdentity(journalDirectory)
      : { ownerId: randomUUID(), instanceId: randomUUID() };
    if (
      access &&
      (access.config.ownerId !== identity.ownerId ||
        access.config.instanceId !== identity.instanceId)
    )
      throw new Error('EXECUTION_INSTANCE_MISMATCH');
  } catch (error) {
    store.close();
    throw error;
  }
  let sessionId: string;
  let journal: Journal;
  let adapter: MockVestAdapter;
  let controller: FleetController;
  let busy = false;
  let vestTicketLeverage: ReturnType<typeof observeVestTicket> | null = null;
  let emergencyRequested = false;
  let pending: Promise<unknown> = Promise.resolve();
  let lastResults: unknown = null;
  async function initialize(reset = false) {
    const session = store.open(reset);
    sessionId = session.sessionId;
    journal = session.journal;
    journal.recoverCommands();
    adapter = new MockVestAdapter(
      config,
      now,
      undefined,
      '30400',
      (event) => journal.log(event),
      (saved) => {
        try {
          journal.saveSimulator(saved);
        } catch {
          emergencyRequested = true;
          try {
            journal.halt();
          } catch {
            /* The server entry veto remains set. */
          }
          throw new Error('SIMULATION_PERSISTENCE_FAILED');
        }
      },
      session.saved ?? undefined,
    );
    await adapter.connect();
    controller = new FleetController(adapter, config, journal, now);
    emergencyRequested = session.restored;
    lastResults = null;
    if (session.restored) controller.requestHalt();
    await controller.reconcile();
  }
  try {
    await initialize(startNew);
  } catch (error) {
    try {
      if (journal!) journal.close();
    } finally {
      store.close();
    }
    throw error;
  }
  let closing = false;
  let copierAuthRevision = 0;
  let copierSimulation:
    Awaited<ReturnType<typeof createCopierSimulation>> | undefined;
  let copierInitialization:
    Promise<Awaited<ReturnType<typeof createCopierSimulation>>> | undefined;
  const getCopier = () => {
    if (copierInitialization) return copierInitialization;
    const revision = copierAuthRevision;
    return (copierInitialization = createCopierSimulation(
      config,
      journalDirectory
        ? resolve(journalDirectory, 'copier-simulation.sqlite')
        : undefined,
      now,
    ).then((instance) => {
      copierSimulation = instance;
      if (closing || revision !== copierAuthRevision) instance.lock();
      return instance;
    }));
  };
  const reconciliationTimer = setInterval(() => {
    if (busy || closing) return;
    busy = true;
    pending = controller
      .reconcile()
      .catch(() => {
        emergencyRequested = true;
        try {
          controller.requestHalt();
        } catch {
          /* Existing halt remains latched. */
        }
      })
      .finally(() => {
        busy = false;
      });
  }, 1000);
  reconciliationTimer.unref();
  const evidence = async () => {
    const quote = await adapter.getQuote();
    const accounts = await adapter.listAccounts();
    const verifiedAt = controller.health().lastReconciledAt;
    const timestamps = [
      quote.timestamp,
      ...accounts.map((a) => a.lastSyncTimestamp),
      verifiedAt ?? 0,
    ];
    const ageMs = Math.max(...timestamps.map((t) => now() - t));
    return {
      fresh: timestamps.every(
        (t) => now() >= t && now() - t < config.maxDataAgeMs,
      ),
      verifiedAt,
      ageMs,
      maxAgeMs: config.maxDataAgeMs,
    };
  };
  const latchHalt = () => {
    emergencyRequested = true;
    try {
      controller.requestHalt();
    } catch {
      /* In-memory entry veto stays set. */
    }
  };
  const isOwned = (command: { ownerId: string; instanceId: string }) => {
    if (
      command.ownerId === identity.ownerId &&
      command.instanceId === identity.instanceId
    )
      return true;
    const legacy = journal.legacyIdentityBinding();
    return (
      command.ownerId === 'local-owner' &&
      command.instanceId === 'local-instance' &&
      legacy?.ownerId === identity.ownerId &&
      legacy.instanceId === identity.instanceId
    );
  };
  const ownedCommand = (id: string) => {
    const command = journal.command(id);
    if (!command || !isOwned(command) || command.sessionId !== sessionId)
      throw new Error('COMMAND_NOT_FOUND');
    return command;
  };
  const snapshot = async (csrf: string = token) => ({
    mode: 'SIMULATION_ONLY',
    liveSend: LIVE_VEST_SEND,
    vestTicketLeverage,
    copier: unprovenCopierStatus(),
    identity: {
      ...identity,
      authenticated: !!access,
      legacyCommandsBound:
        journal.legacyIdentityBinding()?.ownerId === identity.ownerId &&
        journal.legacyIdentityBinding()?.instanceId === identity.instanceId,
    },
    freshness: await evidence(),
    commands: journal
      .commands()
      .filter((c) => isOwned(c) && c.sessionId === sessionId)
      .filter(
        (c, index) =>
          index < 30 || c.status === 'PENDING' || c.status === 'UNKNOWN',
      ),
    token: csrf,
    sessionId,
    halted:
      emergencyRequested ||
      journal.halted() ||
      controller.health().state === 'HALTED',
    health: controller.health(),
    quote: await adapter.getQuote(),
    accounts: await adapter.listAccounts(),
    config,
    lastResults,
    events: journal.events(15),
  });
  const assets: Record<string, [string, string]> = {
    '/': ['index.html', 'text/html; charset=utf-8'],
    '/copier': ['copier.html', 'text/html; charset=utf-8'],
    '/copier.js': ['copier.js', 'text/javascript; charset=utf-8'],
    '/copier.css': ['copier.css', 'text/css; charset=utf-8'],
    '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
    '/style.css': ['style.css', 'text/css; charset=utf-8'],
    '/brand/mark.svg': ['brand/mark.svg', 'image/svg+xml'],
    '/brand/favicon.svg': ['brand/favicon.svg', 'image/svg+xml'],
    '/manifest.webmanifest': [
      'manifest.webmanifest',
      'application/manifest+json',
    ],
    '/brand/icon-192.png': ['brand/icon-192.png', 'image/png'],
    '/brand/icon-512.png': ['brand/icon-512.png', 'image/png'],
    '/brand/apple-touch-icon.png': ['brand/apple-touch-icon.png', 'image/png'],
  };
  const handler = async (req: IncomingMessage, res: ServerResponse) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    );
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    const origin = `http://127.0.0.1:${port}`;
    const reply = (status: number, data: unknown) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(data));
    };
    if (access) {
      res.setHeader('Strict-Transport-Security', 'max-age=31536000');
      try {
        access.validateOriginHost(req, req.method === 'POST');
      } catch {
        reply(403, { error: 'ORIGIN_REQUIRED' });
        return;
      }
    }
    // Loopback remains exact and cannot be configured as an unauthenticated remote route.
    if (
      !access &&
      (req.headers.host !== `127.0.0.1:${port}` ||
        (req.headers.origin && req.headers.origin !== origin))
    ) {
      reply(403, { error: 'LOCAL_ORIGIN_REQUIRED' });
      return;
    }
    const path = req.url ?? '/';
    if (req.method === 'GET' && assets[path]) {
      const asset = assets[path];
      res.writeHead(200, { 'Content-Type': asset[1] });
      res.end(readFileSync(new URL(`public/${asset[0]}`, import.meta.url)));
      return;
    }
    try {
      if (closing) {
        reply(503, { error: 'HOST_SHUTTING_DOWN' });
        return;
      }
      if (access && req.method === 'POST' && path === '/api/login') {
        if (req.headers['content-type'] !== 'application/json') {
          reply(400, { error: 'INVALID_REQUEST' });
          return;
        }
        const input = z
          .object({ secret: z.string().min(1).max(256) })
          .strict()
          .parse(await body(req));
        try {
          access.login(input.secret, res);
          reply(200, { authenticated: true });
        } catch {
          reply(401, { error: 'SIGN_IN_REJECTED' });
        }
        return;
      }
      const auth = access?.authenticate(req);
      if (access && !auth) {
        reply(401, { error: 'AUTHENTICATION_REQUIRED' });
        return;
      }
      const csrf = auth?.csrf ?? token;
      const requestCopierRevision = copierAuthRevision;
      if (access && req.method === 'POST') {
        try {
          access.validateMutation(req, auth!);
        } catch {
          reply(403, { error: 'MUTATION_AUTHORIZATION_REQUIRED' });
          return;
        }
      }
      if (
        access &&
        req.method === 'POST' &&
        ['/api/logout', '/api/revoke-sessions'].includes(path)
      ) {
        z.object({})
          .strict()
          .parse(await body(req));
        if (path === '/api/logout') access.logout(req, res);
        else access.revokeAll(res);
        copierAuthRevision++;
        copierSimulation?.lock();
        reply(200, { authenticated: false });
        return;
      }

      if (
        req.method === 'GET' &&
        /^\/api\/commands\/[a-f0-9]{64}$/.test(path)
      ) {
        reply(200, { command: ownedCommand(path.split('/').at(-1)!) });
        return;
      }
      if (req.method === 'GET' && path === '/api/health') {
        reply(200, controller.health());
        return;
      }
      if (req.method === 'GET' && path === '/api/state') {
        reply(200, await snapshot(csrf));
        return;
      }
      if (req.method === 'GET' && path === '/api/copier/state') {
        reply(200, { ...(await (await getCopier()).state()), token: csrf });
        return;
      }
      if (
        req.method !== 'POST' ||
        ![
          '/api/preview',
          '/api/execute',
          '/api/flatten',
          '/api/price',
          '/api/enabled',
          '/api/reset',
          '/api/reconcile',
          '/api/vest-copy-plan',
          '/api/vest-ticket',
          '/api/copier/arm',
          '/api/copier/lock',
          '/api/copier/entry',
          '/api/copier/repair',
          '/api/copier/scenario',
          '/api/copier/change',
          '/api/copier/change-reconcile',
        ].includes(path)
      ) {
        reply(404, { error: 'NOT_FOUND' });
        return;
      }
      if (
        req.headers['x-session-token'] !== csrf ||
        req.headers['content-type'] !== 'application/json'
      ) {
        reply(403, { error: 'SESSION_TOKEN_REQUIRED' });
        return;
      }
      const input = await body(req);
      if (closing) {
        reply(503, { error: 'HOST_SHUTTING_DOWN' });
        return;
      }
      if (access) {
        try {
          access.validateMutation(req, auth!);
        } catch {
          reply(403, { error: 'MUTATION_AUTHORIZATION_REQUIRED' });
          return;
        }
      }
      if (path === '/api/vest-ticket') {
        vestTicketLeverage = observeVestTicket(input);
        reply(200, { vestTicketLeverage });
        return;
      }
      if (path.startsWith('/api/copier/')) {
        const copier = await getCopier();
        if (
          closing ||
          requestCopierRevision !== copierAuthRevision ||
          (access && !access.authenticate(req))
        ) {
          reply(403, { error: 'MUTATION_AUTHORIZATION_REQUIRED' });
          return;
        }
        reply(200, { result: await copier.command(path, input) });
        return;
      }
      if (path === '/api/vest-copy-plan') {
        reply(200, planSequentialCopy(input));
        return;
      }
      if (path === '/api/execute') {
        const modern = executeSchema.safeParse(input);
        let command;
        if (modern.success) {
          command = ownedCommand(modern.data.commandId);
          if (command.payloadHash !== modern.data.payloadHash)
            throw new Error('IDEMPOTENCY_CONFLICT');
        } else {
          const legacy = legacyExecuteSchema.parse(input);
          if (legacy.sessionId !== sessionId)
            throw new Error('SIMULATION_SESSION_CHANGED');
          if (emergencyRequested) throw new Error('ENTRIES_HALTED');
          command = journal
            .commands()
            .find(
              (c) =>
                c.previewId === legacy.previewId && c.sessionId === sessionId,
            );
          if (!command || !isOwned(command))
            throw new Error('COMMAND_NOT_FOUND');
          journal.bindCommandAlias(
            legacy.masterTradeId,
            hash(legacy),
            command.id,
          );
        }
        if (command.status !== 'PREVIEWED') {
          reply(200, {
            command,
            results: command.results,
            state: await snapshot(csrf),
          });
          return;
        }
        if (command.ownerId === 'local-owner')
          throw new Error('LEGACY_COMMAND_REQUIRES_NEW_PREVIEW');
        if (busy) {
          reply(409, { error: 'OPERATION_IN_PROGRESS' });
          return;
        }
        if (now() < command.createdAt || now() >= command.expiresAt)
          throw new Error('COMMAND_EXPIRED');
        if (emergencyRequested || journal.halted())
          throw new Error('ENTRIES_HALTED');
        if (!(await evidence()).fresh) throw new Error('EVIDENCE_STALE');
        if (
          journal
            .commands()
            .some((c) => c.status === 'PENDING' || c.status === 'UNKNOWN')
        )
          throw new Error('COMMAND_REQUIRES_RECONCILIATION');
        const current = ownedCommand(command.id);
        if (current.status !== 'PREVIEWED') {
          reply(200, {
            command: current,
            results: current.results,
            state: await snapshot(csrf),
          });
          return;
        }
        if (busy || closing) {
          reply(409, { error: 'OPERATION_IN_PROGRESS' });
          return;
        }
        if (emergencyRequested || journal.halted())
          throw new Error('ENTRIES_HALTED');
        if (now() < command.createdAt || now() >= command.expiresAt)
          throw new Error('COMMAND_EXPIRED');
        // Commit acceptance before any controller side effect. Every retry above is read-only.
        busy = true;
        command.status = 'PENDING';
        try {
          journal.saveCommand(command);
        } catch {
          busy = false;
          latchHalt();
          throw new Error('COMMAND_PERSISTENCE_FAILED');
        }
        pending = (async () => {
          try {
            lastResults = await controller.execute(
              command.id,
              command.previewId,
            );
            command.results = lastResults as NonNullable<
              typeof command.results
            >;
            command.status = command.results.some((r) => r.state === 'UNKNOWN')
              ? 'UNKNOWN'
              : 'COMPLETE';
            journal.saveCommand(command);
            if (command.status === 'UNKNOWN') latchHalt();
          } catch {
            latchHalt();
            command.status = 'UNKNOWN';
            try {
              journal.saveCommand(command);
            } catch {
              /* Halt latch is authoritative until restart/review. */
            }
          }
          return {
            command,
            results: command.results,
            state: await snapshot(csrf),
          };
        })();
        try {
          reply(200, await pending);
        } finally {
          busy = false;
        }
        return;
      }
      if (path === '/api/flatten') {
        z.object({}).strict().parse(input);
        emergencyRequested = true; // Block entries immediately, including while an operation completes.
        controller.requestHalt();
        await pending.catch(() => {});
        if (busy) {
          reply(409, { error: 'FLATTEN_IN_PROGRESS_RETRY' });
          return;
        }
      } else if (busy) {
        reply(409, { error: 'OPERATION_IN_PROGRESS' });
        return;
      }
      busy = true;
      pending = (async () => {
        if (path === '/api/preview') {
          const request = previewSchema.parse(input);
          // Synthetic quote refresh only; no external market feed exists.
          await adapter.updatePrice((await adapter.getQuote()).price);
          if (
            emergencyRequested ||
            journal
              .commands()
              .some((c) => c.status === 'PENDING' || c.status === 'UNKNOWN')
          )
            throw new Error('ENTRIES_HALTED');
          await controller.reconcile();
          const preview = await controller.preview(
            request.intent,
            request.selected,
          );
          const command = envelope(
            preview,
            sessionId,
            identity,
            config.maxPreviewAgeMs,
          );
          journal.saveCommand(command);
          return { preview, sessionId, command };
        }
        if (path === '/api/flatten') {
          lastResults = await controller.flattenAll();
          return { results: lastResults, state: await snapshot(csrf) };
        }
        if (path === '/api/reconcile') {
          z.object({}).strict().parse(input);
          await controller.reconcile();
        }
        if (path === '/api/price') {
          const request = z.object({ price: positive }).strict().parse(input);
          await adapter.updatePrice(request.price);
        }
        if (path === '/api/enabled') {
          const request = enabledSchema.parse(input);
          adapter.setEnabled(request.accountId, request.enabled);
        }
        if (path === '/api/reset') {
          if (journal.hasUnresolvedExecution())
            throw new Error('UNRESOLVED_COMMANDS_PRESERVED');
          z.object({ confirm: z.literal('RESET_SIMULATION') })
            .strict()
            .parse(input);
          await adapter.disconnect();
          journal.close();
          await initialize(true);
        }
        return { state: await snapshot(csrf) };
      })();
      try {
        reply(200, await pending);
      } finally {
        busy = false;
      }
    } catch (error) {
      const code =
        error instanceof z.ZodError || error instanceof SyntaxError
          ? 'INVALID_REQUEST'
          : error instanceof Error && /^[A-Z_]+$/.test(error.message)
            ? error.message
            : 'REQUEST_FAILED';
      reply(400, { error: code });
    }
  };
  // Track handler lifetimes, including cleanup waiting behind an accepted entry.
  // Register synchronously before another event can initiate shutdown.
  const inFlight = new Set<Promise<void>>();
  const trackedHandler = (req: IncomingMessage, res: ServerResponse) => {
    const job = handler(req, res).catch(() => {
      if (!res.headersSent)
        res.writeHead(500, { 'Content-Type': 'application/json' });
      if (!res.writableEnded)
        res.end(JSON.stringify({ error: 'REQUEST_FAILED' }));
    });
    inFlight.add(job);
    void job.finally(() => inFlight.delete(job));
  };
  const server = access
    ? createHttpsServer(access.tls, trackedHandler)
    : createServer(trackedHandler);
  server.requestTimeout = 30_000;
  server.headersTimeout = 10_000;
  let closePromise: Promise<void> | undefined;
  return {
    server,
    close: () =>
      (closePromise ??= (async () => {
        closing = true;
        copierAuthRevision++;
        copierSimulation?.lock();
        clearInterval(reconciliationTimer);
        access?.revokeAll();
        const disconnected = new Promise<void>((resolve) => {
          if (!server.listening) {
            resolve();
            return;
          }
          server.close(() => resolve());
        });
        await Promise.allSettled([...inFlight]);
        await pending.catch(() => {});
        server.closeAllConnections();
        await disconnected;
        try {
          await copierSimulation?.close();
          await adapter.disconnect();
        } finally {
          journal.close();
          store.close();
        }
      })()),
  };
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    const config = riskConfigSchema.parse(
      parse(
        readFileSync(
          new URL('../../config/example.yaml', import.meta.url),
          'utf8',
        ),
      ),
    );
    const { values } = parseArgs({
      options: {
        'new-simulation': { type: 'boolean', default: false },
        'private-config': { type: 'string' },
        runtime: { type: 'string' },
      },
    });
    const access = values['private-config']
      ? await loadPrivateAccess(values['private-config'])
      : undefined;
    if (
      access &&
      values.runtime &&
      resolve(values.runtime) !== access.config.runtimeDirectory
    )
      throw new Error('EXECUTION_INSTANCE_MISMATCH');
    const app = await createDashboard(
      config,
      access?.config.runtimeDirectory ?? values.runtime ?? '.runtime/dashboard',
      values['new-simulation'],
      access,
    );
    app.server.listen(
      access?.config.port ?? 4173,
      access?.config.bindAddress ?? '127.0.0.1',
      () =>
        console.log(
          `Simulation dashboard: ${access?.config.origin ?? 'http://127.0.0.1:4173'} | No live trading`,
        ),
    );
    app.server.on('error', () => {
      console.error(
        'DASHBOARD_START_FAILED: configured address/port may be unavailable; run host:doctor.',
      );
      process.exitCode = 1;
      void app.close();
    });
    for (const signal of ['SIGINT', 'SIGTERM'])
      process.once(signal, () => {
        void app.close();
      });
  } catch {
    console.error(
      'DASHBOARD_START_REJECTED: run host:doctor, preserve runtime records, and review identity/permissions/configuration.',
    );
    process.exitCode = 1;
  }
}
