import {
  afterAll,
  beforeAll,
  beforeEach,
  afterEach,
  expect,
  it,
  vi,
} from 'vitest';
import { request } from 'node:https';
import { createServer } from 'node:net';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { createDashboard } from '../apps/dashboard/server.ts';
import { PrivateAccess } from '../apps/dashboard/src/private-access.ts';
import { privateHost } from './fixtures/private-host.ts';
import { Journal } from '../packages/execution/src/journal.ts';
import { MockVestAdapter } from '../packages/simulator/src/index.ts';
import { config, intent } from './helpers.ts';
let fixture: Awaited<ReturnType<typeof privateHost>>;
let app: Awaited<ReturnType<typeof createDashboard>>, access: PrivateAccess;
let port: number, origin: string, cookie: string, csrf: string, now: number;
async function freePort() {
  const server = createServer();
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('NO_ADDRESS');
  await new Promise<void>((r) => server.close(() => r()));
  return address.port;
}
async function api(
  path: string,
  data?: unknown,
  headers: Record<string, string> = {},
) {
  return new Promise<{
    status: number;
    body: ReturnType<typeof JSON.parse>;
    cookie: string;
  }>((resolve, reject) => {
    const req = request(
      {
        hostname: '127.0.0.1',
        port,
        path: `/api/${path}`,
        rejectUnauthorized: false,
        method: data === undefined ? 'GET' : 'POST',
        headers: {
          Host: `localhost:${port}`,
          ...(cookie ? { Cookie: cookie } : {}),
          ...(data === undefined
            ? {}
            : {
                Origin: origin,
                'Content-Type': 'application/json',
                'X-Session-Token': csrf,
              }),
          ...headers,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(Buffer.from(c)));
        res.on('end', () =>
          resolve({
            status: res.statusCode!,
            body: JSON.parse(Buffer.concat(chunks).toString()),
            cookie: (res.headers['set-cookie']?.[0] ?? '').split(';')[0]!,
          }),
        );
      },
    );
    req.on('error', reject);
    if (data !== undefined) req.write(JSON.stringify(data));
    req.end();
  });
}
async function login() {
  const r = await api('login', { secret: fixture.secret });
  expect(r.status).toBe(200);
  cookie = r.cookie;
  csrf = (await api('state')).body.token;
}
async function preview() {
  return (await api('preview', { intent, selected: ['01'] })).body.command;
}
async function start() {
  access = new PrivateAccess({ ...fixture.config, origin, port }, fixture.tls, {
    now: () => now,
    sessionDurationMs: 60_000,
  });
  app = await createDashboard(config, fixture.directory, false, access);
  await new Promise<void>((r) => app.server.listen(port, '127.0.0.1', r));
}
beforeAll(async () => {
  port = await freePort();
  origin = `https://localhost:${port}`;
});
afterAll(() => {});
beforeEach(async () => {
  fixture = await privateHost();
  now = Date.now();
  cookie = '';
  csrf = '';
  await start();
});
afterEach(async () => {
  vi.restoreAllMocks();
  await app.close();
  await fixture.dispose();
});
it('keeps private account, health and command data inaccessible without authentication', async () => {
  for (const path of ['state', 'health', `commands/${'0'.repeat(64)}`])
    expect((await api(path)).status).toBe(401);
  expect((await api('flatten', {})).status).toBe(401);
  expect(
    (
      await api('state', undefined, {
        'X-Forwarded-User': fixture.config.ownerId,
      })
    ).status,
  ).toBe(401);
});
it('requires exact origin, Host, authenticated session and CSRF on mutation', async () => {
  expect(
    (
      await api(
        'login',
        { secret: fixture.secret },
        { Origin: 'https://evil.example' },
      )
    ).status,
  ).toBe(403);
  expect(
    (await api('login', { secret: fixture.secret }, { Origin: '' })).status,
  ).toBe(403);
  await login();
  expect((await api('flatten', {}, { 'X-Session-Token': '' })).status).toBe(
    403,
  );
  expect(
    (await api('flatten', {}, { Origin: 'https://evil.example' })).status,
  ).toBe(403);
  expect(
    (
      await api('state', undefined, {
        Host: 'evil.example',
        'X-Forwarded-Host': `localhost:${port}`,
      })
    ).status,
  ).toBe(403);
});
it('rejects forged inventory, owner, instance and command payload fields', async () => {
  await login();
  expect(
    (await api('preview', { intent, selected: ['foreign-account'] })).status,
  ).toBe(400);
  expect(
    (await api('preview', { intent, selected: ['01'], ownerId: randomUUID() }))
      .status,
  ).toBe(400);
  expect(
    (
      await api('preview', {
        intent,
        selected: ['01'],
        instanceId: randomUUID(),
      })
    ).status,
  ).toBe(400);
  expect((await api(`commands/${'f'.repeat(64)}`)).status).toBe(400);
  expect(
    (
      await api('execute', {
        commandId: 'f'.repeat(64),
        payloadHash: 'f'.repeat(64),
      })
    ).status,
  ).toBe(400);
});
it('server resolves durable command ownership and never exposes foreign commands', async () => {
  await login();
  const command = await preview();
  const journal = new Journal(
    join(fixture.directory, `${command.sessionId}.sqlite`),
  );
  journal.saveCommand({
    ...command,
    id: 'a'.repeat(64),
    ownerId: randomUUID(),
  });
  journal.saveCommand({
    ...command,
    id: 'b'.repeat(64),
    instanceId: randomUUID(),
  });
  journal.close();
  for (const id of ['a'.repeat(64), 'b'.repeat(64)]) {
    expect((await api(`commands/${id}`)).body.error).toBe('COMMAND_NOT_FOUND');
    expect(
      (
        await api('execute', {
          commandId: id,
          payloadHash: command.payloadHash,
        })
      ).body.error,
    ).toBe('COMMAND_NOT_FOUND');
  }
  expect((await api('state')).body.commands).toHaveLength(1);
});
it('same-ID replay returns the protected result without another entry and hash conflicts reject', async () => {
  await login();
  const command = await preview();
  const data = { commandId: command.id, payloadHash: command.payloadHash };
  const first = await api('execute', data);
  expect(first.body.command.results[0].state).toBe('PROTECTED');
  expect((await api('execute', data)).body.command.results).toEqual(
    first.body.command.results,
  );
  expect(
    (await api('execute', { ...data, payloadHash: '0'.repeat(64) })).body.error,
  ).toBe('IDEMPOTENCY_CONFLICT');
  expect((await api('state')).body.health.metrics.entries).toBe(1);
});
it('expired session and revoked sessions cannot read state or mutate', async () => {
  await login();
  now += 60_000;
  expect((await api('state')).status).toBe(401);
  expect((await api('flatten', {})).status).toBe(401);
  await login();
  expect((await api('revoke-sessions', {})).status).toBe(200);
  expect((await api('state')).status).toBe(401);
});
it('logout immediately revokes the cookie', async () => {
  await login();
  expect((await api('logout', {})).status).toBe(200);
  expect((await api('state')).status).toBe(401);
});
it('offline/delayed expired commands are not accepted after reconnect', async () => {
  await login();
  const command = await preview();
  const real = Date.now();
  vi.spyOn(Date, 'now').mockReturnValue(real + config.maxPreviewAgeMs + 1);
  expect(
    (
      await api('execute', {
        commandId: command.id,
        payloadHash: command.payloadHash,
      })
    ).body.error,
  ).toBe('COMMAND_EXPIRED');
  expect((await api('state')).body.health.metrics.entries).toBe(0);
});
it('fresh heartbeat cannot authorize entry against stale account evidence', async () => {
  await login();
  const command = await preview();
  const original = MockVestAdapter.prototype.listAccounts;
  vi.spyOn(MockVestAdapter.prototype, 'listAccounts').mockImplementation(
    async function (this: MockVestAdapter) {
      return (await original.call(this)).map((a) => ({
        ...a,
        lastSyncTimestamp: Date.now() - config.maxDataAgeMs - 1,
      }));
    },
  );
  expect(
    (
      await api('execute', {
        commandId: command.id,
        payloadHash: command.payloadHash,
      })
    ).body.error,
  ).toBe('EVIDENCE_STALE');
  expect((await api('state')).body.freshness.fresh).toBe(false);
});
it('restart revokes authentication, preserves protected books and stays halted', async () => {
  await login();
  const command = await preview();
  await api('execute', {
    commandId: command.id,
    payloadHash: command.payloadHash,
  });
  await app.close();
  await start();
  expect((await api('state')).status).toBe(401);
  await login();
  const state = (await api('state')).body;
  expect(state.halted).toBe(true);
  expect(state.accounts[0].positions).toHaveLength(1);
  expect((await api(`commands/${command.id}`)).body.command.status).toBe(
    'COMPLETE',
  );
  expect((await api('reconcile', {})).body.state.halted).toBe(true);
});
it('interrupted accepted commands become UNKNOWN and block reset after restart', async () => {
  await login();
  const command = await preview();
  await app.close();
  const journal = new Journal(
    join(fixture.directory, `${command.sessionId}.sqlite`),
  );
  journal.saveCommand({ ...command, status: 'PENDING' });
  journal.close();
  await start();
  await login();
  expect((await api(`commands/${command.id}`)).body.command.status).toBe(
    'UNKNOWN',
  );
  expect((await api('reset', { confirm: 'RESET_SIMULATION' })).body.error).toBe(
    'UNRESOLVED_COMMANDS_PRESERVED',
  );
});
it('conflicting active execution owners and wrong bound instances cannot start', async () => {
  await expect(
    createDashboard(config, fixture.directory, false, access),
  ).rejects.toThrow('SIMULATION_STORE_LOCKED');
  await app.close();
  const wrong = new PrivateAccess(
    { ...fixture.config, origin, port, instanceId: randomUUID() },
    fixture.tls,
  );
  await expect(
    createDashboard(config, fixture.directory, false, wrong),
  ).rejects.toThrow('EXECUTION_INSTANCE_MISMATCH');
  await start();
});
it('shutdown retains exclusive execution ownership until accepted work settles', async () => {
  await login();
  const command = await preview();
  let release!: () => void, reached!: () => void;
  const entered = new Promise<void>((r) => {
    reached = r;
  });
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const original = MockVestAdapter.prototype.placeOrder;
  vi.spyOn(MockVestAdapter.prototype, 'placeOrder').mockImplementation(
    async function (
      this: MockVestAdapter,
      ...args: Parameters<MockVestAdapter['placeOrder']>
    ) {
      reached();
      await gate;
      return original.apply(this, args);
    },
  );
  const submitting = api('execute', {
    commandId: command.id,
    payloadHash: command.payloadHash,
  });
  await entered;
  const closing = app.close();
  await expect(
    createDashboard(config, fixture.directory, false, access),
  ).rejects.toThrow('SIMULATION_STORE_LOCKED');
  release();
  await submitting.catch(() => {});
  await closing;
  await start();
  await login();
  expect((await api(`commands/${command.id}`)).body.command.status).toBe(
    'COMPLETE',
  );
});
it('shutdown drains a queued flatten as well as the accepted entry before releasing ownership', async () => {
  await login();
  const command = await preview();
  let releaseEntry!: () => void,
    entered!: () => void,
    releaseFlatten!: () => void,
    flattening!: () => void;
  const entryReached = new Promise<void>((r) => {
    entered = r;
  });
  const entryGate = new Promise<void>((r) => {
    releaseEntry = r;
  });
  const flattenReached = new Promise<void>((r) => {
    flattening = r;
  });
  const flattenGate = new Promise<void>((r) => {
    releaseFlatten = r;
  });
  const place = MockVestAdapter.prototype.placeOrder;
  vi.spyOn(MockVestAdapter.prototype, 'placeOrder').mockImplementation(
    async function (
      this: MockVestAdapter,
      ...args: Parameters<MockVestAdapter['placeOrder']>
    ) {
      entered();
      await entryGate;
      return place.apply(this, args);
    },
  );
  const flatten = MockVestAdapter.prototype.flattenAccount;
  vi.spyOn(MockVestAdapter.prototype, 'flattenAccount').mockImplementation(
    async function (
      this: MockVestAdapter,
      ...args: Parameters<MockVestAdapter['flattenAccount']>
    ) {
      flattening();
      await flattenGate;
      return flatten.apply(this, args);
    },
  );
  let haltReached!: () => void;
  const halted = new Promise<void>((r) => {
    haltReached = r;
  });
  const halt = Journal.prototype.halt;
  vi.spyOn(Journal.prototype, 'halt').mockImplementation(function (
    this: Journal,
  ) {
    haltReached();
    return halt.call(this);
  });
  const submitting = api('execute', {
    commandId: command.id,
    payloadHash: command.payloadHash,
  });
  await entryReached;
  const cleaning = api('flatten', {});
  await halted; // The flatten request was accepted and is waiting behind the entry.
  const closing = app.close();
  releaseEntry();
  await flattenReached;
  await expect(
    createDashboard(config, fixture.directory, false, access),
  ).rejects.toThrow('SIMULATION_STORE_LOCKED');
  releaseFlatten();
  await Promise.allSettled([submitting, cleaning]);
  await closing;
  vi.restoreAllMocks();
  await start();
  await login();
  const recovered = (await api('state')).body;
  expect(
    recovered.accounts.every(
      (a: { positions: unknown[] }) => !a.positions.length,
    ),
  ).toBe(true);
  expect(recovered.halted).toBe(true);
});
