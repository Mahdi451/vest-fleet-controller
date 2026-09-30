import { randomUUID } from 'node:crypto';
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  Journal,
  type CommandEnvelope,
} from '../packages/execution/src/journal.ts';
import { MockVestAdapter } from '../packages/simulator/src/index.ts';
import { SimulationStore } from '../packages/simulator/src/storage.ts';
import { loadLocalIdentity } from '../apps/dashboard/src/identity.ts';
import { machineBinding } from '../apps/dashboard/src/private-access.ts';
import {
  bindLegacyRuntime,
  inspectLegacyRuntime,
  LEGACY_BINDING_KEY,
} from '../apps/dashboard/src/legacy-adoption.ts';
import { config, NOW } from './helpers.ts';
import { privateRuntimeAsync, writeFixtureFile } from './fixtures/runtime.ts';
import { protectFile } from '../packages/host/src/storage.ts';
let directory: string;
let store: SimulationStore | undefined;
beforeEach(async () => {
  directory = await privateRuntimeAsync('vfc-adoption-');
});
afterEach(async () => {
  store?.close();
  store = undefined;
  await rm(directory, { recursive: true, force: true });
});
async function legacySession(
  statuses: CommandEnvelope['status'][] = [],
  active = true,
) {
  const sessionId = randomUUID(),
    path = join(directory, `${sessionId}.sqlite`),
    journal = new Journal(path);
  journal.saveSimulator(
    new MockVestAdapter(config, () => NOW).exportSnapshot(),
  );
  const commands = statuses.map((status, index): CommandEnvelope => ({
    id: String(index + 1).repeat(64),
    payloadHash: 'f'.repeat(64),
    ownerId: 'local-owner',
    instanceId: 'local-instance',
    sessionId,
    previewId: 'a'.repeat(64),
    selected: ['01'],
    createdAt: NOW,
    expiresAt: NOW + 10_000,
    status,
    ...(status === 'COMPLETE' ? { results: [] } : {}),
  }));
  for (const command of commands) {
    journal.saveCommand(command);
    journal.bindCommandAlias(randomUUID(), 'old-fingerprint', command.id);
  }
  journal.close();
  await protectFile(path);
  if (active)
    await writeFixtureFile(
      join(directory, 'active-session.json'),
      JSON.stringify({ sessionId }),
      { mode: 0o600 },
    );
  return { sessionId, path, commands };
}
function readDatabase(path: string) {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return {
      settings: db.prepare('SELECT key,value FROM settings ORDER BY key').all(),
      commands: db
        .prepare('SELECT id,envelope FROM dashboard_commands ORDER BY id')
        .all(),
      aliases: db.prepare('SELECT * FROM command_aliases ORDER BY id').all(),
    };
  } finally {
    db.close();
  }
}
function lock() {
  store = new SimulationStore(directory);
}
describe('in-place legacy ownership adoption', () => {
  it('adopts the original baseline without creating new command tables or changing simulator state', async () => {
    const old = await legacySession();
    const db = new DatabaseSync(old.path);
    db.exec('DROP TABLE dashboard_commands; DROP TABLE command_aliases');
    const snapshot = db
      .prepare("SELECT value FROM settings WHERE key='simulator'")
      .get()?.value;
    db.close();
    lock();
    const identity = await loadLocalIdentity(directory);
    const opened = new DatabaseSync(old.path, { readOnly: true });
    try {
      expect(
        opened.prepare("SELECT value FROM settings WHERE key='simulator'").get()
          ?.value,
      ).toBe(snapshot);
      expect(
        opened.prepare("SELECT value FROM settings WHERE key='halted'").get()
          ?.value,
      ).toBe('true');
      expect(
        JSON.parse(
          String(
            opened
              .prepare('SELECT value FROM settings WHERE key=?')
              .get(LEGACY_BINDING_KEY)?.value,
          ),
        ),
      ).toMatchObject(identity);
      expect(
        opened
          .prepare(
            "SELECT 1 FROM sqlite_master WHERE name='dashboard_commands'",
          )
          .get(),
      ).toBeUndefined();
    } finally {
      opened.close();
    }
    expect(
      JSON.parse(await readFile(join(directory, 'identity.json'), 'utf8'))
        .state,
    ).toBe('ACTIVE');
  });
  it('preserves every command ID/hash/envelope and alias except PENDING becomes UNKNOWN', async () => {
    const old = await legacySession([
      'COMPLETE',
      'PENDING',
      'UNKNOWN',
      'PREVIEWED',
    ]);
    const before = readDatabase(old.path);
    lock();
    const identity = await loadLocalIdentity(directory);
    const after = readDatabase(old.path);
    expect(after.aliases).toEqual(before.aliases);
    expect(
      after.commands.map((row) => JSON.parse(String(row.envelope))),
    ).toEqual(
      old.commands.map((command) => ({
        ...command,
        status: command.status === 'PENDING' ? 'UNKNOWN' : command.status,
      })),
    );
    const journal = new Journal(old.path);
    try {
      expect(journal.halted()).toBe(true);
    } finally {
      journal.close();
    }
    expect(await loadLocalIdentity(directory)).toEqual(identity);
    expect(readDatabase(old.path)).toEqual(after);
  });
  it('resumes ADOPTING after a partial database commit with the same generated IDs', async () => {
    const first = await legacySession(['PENDING']),
      second = await legacySession(['UNKNOWN']);
    lock();
    const names = await inspectLegacyRuntime(directory);
    const identity = { ownerId: randomUUID(), instanceId: randomUUID() };
    await writeFixtureFile(
      join(directory, 'identity.json'),
      JSON.stringify({
        ...identity,
        machineHash: await machineBinding(),
        runtimeDirectory: directory,
        state: 'ADOPTING',
        legacyDatabases: names,
      }),
      { mode: 0o600 },
    );
    bindLegacyRuntime(directory, [names[0]!], identity);
    expect(await loadLocalIdentity(directory)).toEqual(identity);
    for (const old of [first, second]) {
      const after = readDatabase(old.path);
      expect(JSON.parse(String(after.commands[0]!.envelope)).status).toBe(
        'UNKNOWN',
      );
      expect(
        JSON.parse(
          String(
            after.settings.find((row) => row.key === LEGACY_BINDING_KEY)?.value,
          ),
        ),
      ).toMatchObject(identity);
    }
    expect(
      JSON.parse(await readFile(join(directory, 'identity.json'), 'utf8'))
        .state,
    ).toBe('ACTIVE');
  });
  it('refuses adoption without the exclusive worker lock', async () => {
    const old = await legacySession();
    await expect(loadLocalIdentity(directory)).rejects.toThrow(
      'exclusive lock',
    );
    expect(
      readDatabase(old.path).settings.some(
        (row) => row.key === LEGACY_BINDING_KEY,
      ),
    ).toBe(false);
  });
  it('rejects foreign or mixed ownership before publishing identity or modifying databases', async () => {
    const old = await legacySession(['COMPLETE', 'PENDING']);
    const db = new DatabaseSync(old.path);
    db.prepare('UPDATE dashboard_commands SET envelope=? WHERE id=?').run(
      JSON.stringify({ ...old.commands[1]!, ownerId: randomUUID() }),
      old.commands[1]!.id,
    );
    db.close();
    const before = readDatabase(old.path);
    lock();
    await expect(loadLocalIdentity(directory)).rejects.toThrow(
      'operator recovery',
    );
    expect(readDatabase(old.path)).toEqual(before);
    await expect(readFile(join(directory, 'identity.json'))).rejects.toThrow();
  });
  it('rejects missing journal/manifest and private configuration without identity', async () => {
    await legacySession();
    await rm(join(directory, 'active-session.json'));
    lock();
    await expect(loadLocalIdentity(directory)).rejects.toThrow(
      'operator recovery',
    );
    await writeFixtureFile(
      join(directory, 'active-session.json'),
      JSON.stringify({ sessionId: randomUUID() }),
    );
    await expect(loadLocalIdentity(directory)).rejects.toThrow(
      'operator recovery',
    );
    const old = await legacySession();
    await writeFixtureFile(join(directory, 'private-access.json'), '{}', {
      mode: 0o600,
    });
    await expect(loadLocalIdentity(directory)).rejects.toThrow(
      'operator recovery',
    );
    expect(
      readDatabase(old.path).settings.some(
        (row) => row.key === LEGACY_BINDING_KEY,
      ),
    ).toBe(false);
  });
  it('rejects deleting an adopted identity and copying identity to another runtime', async () => {
    const old = await legacySession();
    lock();
    await loadLocalIdentity(directory);
    const saved = await readFile(join(directory, 'identity.json'));
    await rm(join(directory, 'identity.json'));
    await expect(loadLocalIdentity(directory)).rejects.toThrow(
      'operator recovery',
    );
    expect(
      readDatabase(old.path).settings.some(
        (row) => row.key === LEGACY_BINDING_KEY,
      ),
    ).toBe(true);
    const copied = await privateRuntimeAsync('vfc-copied-');
    try {
      await writeFixtureFile(join(copied, 'identity.json'), saved, {
        mode: 0o600,
      });
      await expect(loadLocalIdentity(copied)).rejects.toThrow(
        'different host or runtime',
      );
    } finally {
      await rm(copied, { recursive: true, force: true });
    }
  });
  it('does not resume ADOPTING against a changed database inventory', async () => {
    await legacySession();
    lock();
    const names = await inspectLegacyRuntime(directory);
    await writeFixtureFile(
      join(directory, 'identity.json'),
      JSON.stringify({
        ownerId: randomUUID(),
        instanceId: randomUUID(),
        machineHash: await machineBinding(),
        runtimeDirectory: directory,
        state: 'ADOPTING',
        legacyDatabases: names,
      }),
      { mode: 0o600 },
    );
    await legacySession([], false);
    await expect(loadLocalIdentity(directory)).rejects.toThrow(
      'inventory changed',
    );
  });
});
