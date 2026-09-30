import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDashboard } from '../apps/dashboard/server.ts';
import {
  Journal,
  type CommandEnvelope,
} from '../packages/execution/src/journal.ts';
import { MockVestAdapter } from '../packages/simulator/src/index.ts';
import { config, intent } from './helpers.ts';
let app: Awaited<ReturnType<typeof createDashboard>>;
let base: string, token: string, directory: string;
async function start() {
  app = await createDashboard(config, directory);
  await new Promise<void>((resolve) =>
    app.server.listen(0, '127.0.0.1', resolve),
  );
  const address = app.server.address();
  if (!address || typeof address === 'string') throw new Error('NO_ADDRESS');
  base = `http://127.0.0.1:${address.port}`;
  token = (await state()).token;
}
const state = async () => (await fetch(`${base}/api/state`)).json();
const post = (path: string, data: unknown) =>
  fetch(`${base}/api/${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Session-Token': token },
    body: JSON.stringify(data),
  });
const preview = async (): Promise<{ command: CommandEnvelope }> =>
  (await post('preview', { intent, selected: ['01', '02'] })).json();
const execute = (command: CommandEnvelope) =>
  post('execute', { commandId: command.id, payloadHash: command.payloadHash });
async function stop() {
  await new Promise<void>((resolve) => app.server.close(() => resolve()));
  await app.close();
}
beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), 'vfc-command-'));
  await start();
});
afterEach(async () => {
  vi.restoreAllMocks();
  await stop();
  rmSync(directory, { recursive: true, force: true });
});
it('deduplicates concurrent taps and lost-response retries using one durable canonical command', async () => {
  const { command } = await preview();
  const responses = await Promise.all([execute(command), execute(command)]);
  expect(responses.every((r) => r.status === 200)).toBe(true);
  const recovered = (
    await (await fetch(`${base}/api/commands/${command.id}`)).json()
  ).command;
  expect(recovered.status).toBe('COMPLETE');
  expect(recovered.results.map((r: { state: string }) => r.state)).toEqual([
    'PROTECTED',
    'PROTECTED',
  ]);
  await execute(command);
  const s = await state();
  expect(
    s.accounts.filter((a: { positions: unknown[] }) => a.positions.length),
  ).toHaveLength(2);
  expect(s.health.metrics.entries).toBe(2);
});
it('rejects hash conflicts, forged commands and legacy alias payload changes', async () => {
  const { command } = await preview();
  expect(
    (
      await post('execute', {
        commandId: command.id,
        payloadHash: 'f'.repeat(64),
      })
    ).status,
  ).toBe(400);
  expect((await fetch(`${base}/api/commands/${'0'.repeat(64)}`)).status).toBe(
    400,
  );
  const alias = randomUUID();
  await post('execute', {
    masterTradeId: alias,
    previewId: command.previewId,
    sessionId: command.sessionId,
  });
  const second = await preview();
  const response = await post('execute', {
    masterTradeId: alias,
    previewId: second.command.previewId,
    sessionId: command.sessionId,
  });
  expect((await response.json()).error).toBe('IDEMPOTENCY_CONFLICT');
});
it('multiple aliases for the same preview cannot dispatch another master trade', async () => {
  const { command } = await preview();
  for (let i = 0; i < 2; i++)
    await post('execute', {
      masterTradeId: randomUUID(),
      previewId: command.previewId,
      sessionId: command.sessionId,
    });
  expect((await state()).health.metrics.entries).toBe(2);
});
it('rejects delayed expired entry without a simulator side effect', async () => {
  const { command } = await preview();
  const now = Date.now();
  vi.spyOn(Date, 'now').mockReturnValue(now + config.maxPreviewAgeMs + 1);
  expect((await (await execute(command)).json()).error).toBe('COMMAND_EXPIRED');
  expect((await state()).health.metrics.entries).toBe(0);
});
it('returns completed command after restart but never re-arms or creates another entry', async () => {
  const { command } = await preview();
  await execute(command);
  await stop();
  await start();
  expect((await state()).halted).toBe(true);
  const response = await execute(command);
  expect((await response.json()).command.status).toBe('COMPLETE');
  expect(
    (await state()).accounts.filter(
      (a: { positions: unknown[] }) => a.positions.length,
    ),
  ).toHaveLength(2);
});
it('restores interrupted PENDING as UNKNOWN and blocks reset and new previews', async () => {
  const { command } = await preview();
  await stop();
  const journal = new Journal(join(directory, `${command.sessionId}.sqlite`));
  journal.saveCommand({ ...command, status: 'PENDING' });
  journal.close();
  await start();
  expect(
    (await (await fetch(`${base}/api/commands/${command.id}`)).json()).command
      .status,
  ).toBe('UNKNOWN');
  expect((await state()).halted).toBe(true);
  expect((await post('reset', { confirm: 'RESET_SIMULATION' })).status).toBe(
    400,
  );
  expect((await post('preview', { intent, selected: ['01'] })).status).toBe(
    400,
  );
  expect((await post('flatten', {})).status).toBe(200);
});
it('fails closed before dispatch when durable acceptance cannot be saved', async () => {
  const { command } = await preview();
  const save = vi
    .spyOn(Journal.prototype, 'saveCommand')
    .mockImplementation(() => {
      throw new Error('DISK_FULL');
    });
  const place = vi.spyOn(MockVestAdapter.prototype, 'placeOrder');
  expect((await (await execute(command)).json()).error).toBe(
    'COMMAND_PERSISTENCE_FAILED',
  );
  expect(place).not.toHaveBeenCalled();
  expect((await state()).halted).toBe(true);
  save.mockRestore();
});
it('does not report success or retry after a completion persistence failure', async () => {
  const { command } = await preview();
  const original = Journal.prototype.saveCommand;
  vi.spyOn(Journal.prototype, 'saveCommand').mockImplementation(function (
    this: Journal,
    c,
  ) {
    if (c.status === 'COMPLETE') throw new Error('DISK_FULL');
    original.call(this, c);
  });
  const result = await (await execute(command)).json();
  expect(result.command.status).toBe('UNKNOWN');
  expect(result.state.halted).toBe(true);
  await execute(command);
  expect((await state()).health.metrics.entries).toBe(2);
});
it('adopts placeholder command ownership in place, preserves UNKNOWN and rejects legacy previews', async () => {
  await stop();
  const legacyDirectory = join(directory, 'legacy-runtime');
  const { SimulationStore } =
    await import('../packages/simulator/src/storage.ts');
  const store = new SimulationStore(legacyDirectory);
  const legacy = store.open();
  const { envelope } = await import('../apps/dashboard/src/commands.ts');
  const { FleetController } =
    await import('../packages/execution/src/controller.ts');
  const adapter = new MockVestAdapter(
    config,
    Date.now,
    undefined,
    '30400',
    undefined,
    (saved) => legacy.journal.saveSimulator(saved),
  );
  await adapter.connect();
  const controller = new FleetController(adapter, config, legacy.journal);
  const p = await controller.preview(intent, ['01']);
  const command = envelope(
    p,
    legacy.sessionId,
    { ownerId: 'local-owner', instanceId: 'local-instance' },
    config.maxPreviewAgeMs,
  );
  legacy.journal.saveCommand({ ...command, status: 'PENDING' });
  const oldPreview = { ...command, id: 'b'.repeat(64) };
  legacy.journal.saveCommand(oldPreview);
  await adapter.disconnect();
  legacy.journal.close();
  store.close();
  app = await createDashboard(config, legacyDirectory);
  await new Promise<void>((resolve) =>
    app.server.listen(0, '127.0.0.1', resolve),
  );
  const address = app.server.address();
  if (!address || typeof address === 'string') throw new Error('NO_ADDRESS');
  base = `http://127.0.0.1:${address.port}`;
  token = (await state()).token;
  const recovered = (
    await (await fetch(`${base}/api/commands/${command.id}`)).json()
  ).command;
  expect(recovered).toMatchObject({
    id: command.id,
    payloadHash: command.payloadHash,
    ownerId: 'local-owner',
    status: 'UNKNOWN',
  });
  expect((await state()).commands).toContainEqual(recovered);
  expect((await state()).identity.legacyCommandsBound).toBe(true);
  expect((await (await execute(oldPreview)).json()).error).toBe(
    'LEGACY_COMMAND_REQUIRES_NEW_PREVIEW',
  );
  expect((await post('reset', { confirm: 'RESET_SIMULATION' })).status).toBe(
    400,
  );
});
it('preserves unfinished legacy controller claims across reset and startup reset flags', async () => {
  const { command } = await preview();
  await stop();
  const journal = new Journal(join(directory, `${command.sessionId}.sqlite`));
  journal.claim('unfinished-legacy-trade', 'legacy-preview');
  journal.close();
  await expect(createDashboard(config, directory, true)).rejects.toThrow(
    'UNRESOLVED_COMMANDS_PRESERVED',
  );
  await start();
  expect((await post('reset', { confirm: 'RESET_SIMULATION' })).status).toBe(
    400,
  );
  expect((await state()).halted).toBe(true);
});
