import { createServer, type IncomingMessage } from 'node:http';
import { readFileSync, mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
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
import { Journal } from '../../packages/execution/src/journal.ts';

const previewSchema = z
  .object({
    intent: intentSchema,
    selected: z.array(z.string()).min(1).max(10),
  })
  .strict();
const executeSchema = z
  .object({
    masterTradeId: z.string().uuid(),
    previewId: z.string().length(64),
    sessionId: z.string().uuid(),
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
) {
  const token = randomUUID();
  let sessionId: string;
  let journal: Journal;
  let adapter: MockVestAdapter;
  let controller: FleetController;
  let busy = false;
  let emergencyRequested = false;
  let pending: Promise<unknown> = Promise.resolve();
  let lastResults: unknown = null;
  async function initialize() {
    sessionId = randomUUID();
    journal = new Journal(
      journalDirectory ? `${journalDirectory}/${sessionId}.sqlite` : ':memory:',
    );
    adapter = new MockVestAdapter(
      config,
      Date.now,
      undefined,
      '30400',
      (event) => journal.log(event),
    );
    await adapter.connect();
    controller = new FleetController(adapter, config, journal);
    emergencyRequested = false;
    lastResults = null;
  }
  await initialize();
  const snapshot = async () => ({
    mode: 'SIMULATION_ONLY',
    token,
    sessionId,
    halted: emergencyRequested || journal.halted(),
    quote: await adapter.getQuote(),
    accounts: await adapter.listAccounts(),
    config,
    lastResults,
    events: journal.events().slice(-15),
  });
  const assets: Record<string, [string, string]> = {
    '/': ['index.html', 'text/html; charset=utf-8'],
    '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
    '/style.css': ['style.css', 'text/css; charset=utf-8'],
  };
  const server = createServer(async (req, res) => {
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
    // Loopback only, exact Host and Origin, no CORS, session token on every mutation.
    if (
      req.headers.host !== `127.0.0.1:${port}` ||
      (req.headers.origin && req.headers.origin !== origin)
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
      if (req.method === 'GET' && path === '/api/state') {
        reply(200, await snapshot());
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
        ].includes(path)
      ) {
        reply(404, { error: 'NOT_FOUND' });
        return;
      }
      if (
        req.headers['x-session-token'] !== token ||
        req.headers['content-type'] !== 'application/json'
      ) {
        reply(403, { error: 'SESSION_TOKEN_REQUIRED' });
        return;
      }
      const input = await body(req);
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
          return {
            preview: await controller.preview(request.intent, request.selected),
            sessionId,
          };
        }
        if (path === '/api/execute') {
          const request = executeSchema.parse(input);
          if (request.sessionId !== sessionId)
            throw new Error('SIMULATION_SESSION_CHANGED');
          if (emergencyRequested) throw new Error('ENTRIES_HALTED');
          lastResults = await controller.execute(
            request.masterTradeId,
            request.previewId,
          );
          return { results: lastResults, state: await snapshot() };
        }
        if (path === '/api/flatten') {
          lastResults = await controller.flattenAll();
          return { results: lastResults, state: await snapshot() };
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
          z.object({ confirm: z.literal('RESET_SIMULATION') })
            .strict()
            .parse(input);
          await adapter.disconnect();
          journal.close();
          await initialize();
        }
        return { state: await snapshot() };
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
  });
  return {
    server,
    close: async () => {
      await pending.catch(() => {});
      await adapter.disconnect();
      journal.close();
    },
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const config = riskConfigSchema.parse(
    parse(
      readFileSync(
        new URL('../../config/example.yaml', import.meta.url),
        'utf8',
      ),
    ),
  );
  mkdirSync('.runtime/dashboard', { recursive: true });
  const app = await createDashboard(config, '.runtime/dashboard');
  app.server.listen(4173, '127.0.0.1', () =>
    console.log(
      'Simulation dashboard: http://127.0.0.1:4173 | No live trading',
    ),
  );
  app.server.on('error', () => {
    console.error('DASHBOARD_START_FAILED: port 4173 may be in use');
    process.exitCode = 1;
    void app.close();
  });
  for (const signal of ['SIGINT', 'SIGTERM'])
    process.once(signal, () => {
      app.server.close(() => {
        void app.close();
      });
    });
}
