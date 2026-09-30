import { DatabaseSync } from 'node:sqlite';
import { lstat, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { commandSchema } from '../../../packages/execution/src/journal.ts';
import { childResultSchema } from '../../../packages/execution/src/adapter.ts';
import { riskConfigSchema } from '../../../packages/core/src/index.ts';
import { MockVestAdapter } from '../../../packages/simulator/src/index.ts';
import type { ExecutionIdentity } from './identity.ts';

export const LEGACY_BINDING_KEY = 'legacy_identity_binding_v1';
export const legacyBindingSchema = z
  .object({
    fromOwner: z.literal('local-owner'),
    fromInstance: z.literal('local-instance'),
    ownerId: z.string().uuid(),
    instanceId: z.string().uuid(),
  })
  .strict();
export type LegacyIdentityBinding = z.infer<typeof legacyBindingSchema>;
const recovery = () => new Error('Legacy runtime requires operator recovery');
const databaseName = z
  .string()
  .regex(/^[a-f0-9-]{36}\.sqlite$/)
  .refine((value) => z.string().uuid().safeParse(value.slice(0, -7)).success);
const columns: Record<string, string[]> = {
  trades: ['id', 'fingerprint', 'result'],
  children: ['id', 'master_id', 'result'],
  audit: ['id', 'event'],
  settings: ['key', 'value'],
  dashboard_commands: ['id', 'envelope'],
  command_aliases: ['id', 'fingerprint', 'command_id'],
  browser_actions: ['id', 'fingerprint', 'account_id', 'state'],
};
export function legacyBinding(
  identity: ExecutionIdentity,
): LegacyIdentityBinding {
  return {
    fromOwner: 'local-owner',
    fromInstance: 'local-instance',
    ownerId: identity.ownerId,
    instanceId: identity.instanceId,
  };
}
function checkDatabase(
  db: DatabaseSync,
  sessionId: string,
  expected?: ExecutionIdentity,
): void {
  if (String(db.prepare('PRAGMA quick_check').get()?.quick_check) !== 'ok')
    throw recovery();
  if (
    db
      .prepare(
        "SELECT 1 FROM sqlite_master WHERE type IN ('trigger','view') LIMIT 1",
      )
      .get()
  )
    throw recovery();
  const tables = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
    )
    .all()
    .map((row) => String(row.name));
  if (
    ['trades', 'children', 'audit', 'settings'].some(
      (name) => !tables.includes(name),
    ) ||
    tables.some((name) => !columns[name])
  )
    throw recovery();
  for (const table of tables) {
    const actual = db
      .prepare(`PRAGMA table_info(${table})`)
      .all()
      .map((row) => String(row.name));
    if (JSON.stringify(actual) !== JSON.stringify(columns[table]))
      throw recovery();
  }
  const rawBinding = db
    .prepare('SELECT value FROM settings WHERE key=?')
    .get(LEGACY_BINDING_KEY)?.value;
  if (rawBinding !== undefined) {
    const binding = legacyBindingSchema.parse(JSON.parse(String(rawBinding)));
    if (
      !expected ||
      JSON.stringify(binding) !== JSON.stringify(legacyBinding(expected))
    )
      throw recovery();
  }
  const snapshot = db
    .prepare("SELECT value FROM settings WHERE key='simulator'")
    .get()?.value;
  if (snapshot !== undefined) {
    const saved: unknown = JSON.parse(String(snapshot));
    const settings = z.object({ config: riskConfigSchema }).parse(saved);
    // Constructor validates the existing simulator snapshot without connecting or writing it.
    new MockVestAdapter(
      settings.config,
      Date.now,
      undefined,
      '30400',
      undefined,
      undefined,
      saved,
    );
  } else if (db.prepare('SELECT 1 FROM trades LIMIT 1').get()) throw recovery();
  for (const row of db
    .prepare('SELECT result FROM trades WHERE result IS NOT NULL')
    .all())
    z.array(childResultSchema).parse(JSON.parse(String(row.result)));
  for (const row of db.prepare('SELECT result FROM children').all())
    childResultSchema.parse(JSON.parse(String(row.result)));
  for (const row of db.prepare('SELECT event FROM audit').all())
    z.object({
      timestamp: z.number(),
      status: z.string(),
      adapter: z.string(),
    }).parse(JSON.parse(String(row.event)));
  if (tables.includes('dashboard_commands')) {
    for (const row of db
      .prepare('SELECT id,envelope FROM dashboard_commands')
      .all()) {
      const command = commandSchema.parse(JSON.parse(String(row.envelope)));
      if (
        command.id !== row.id ||
        command.sessionId !== sessionId ||
        command.ownerId !== 'local-owner' ||
        command.instanceId !== 'local-instance'
      )
        throw recovery();
    }
  }
  if (tables.includes('command_aliases')) {
    const aliases = db
      .prepare('SELECT id,fingerprint,command_id FROM command_aliases')
      .all();
    if (aliases.length && !tables.includes('dashboard_commands'))
      throw recovery();
    for (const row of aliases) {
      if (
        typeof row.id !== 'string' ||
        typeof row.fingerprint !== 'string' ||
        !db
          .prepare('SELECT 1 FROM dashboard_commands WHERE id=?')
          .get(String(row.command_id))
      )
        throw recovery();
    }
  }
}
/** Caller must hold the SimulationStore exclusive lock before adoption or resumption. */
export async function inspectLegacyRuntime(
  directory: string,
  expected?: ExecutionIdentity,
): Promise<string[]> {
  try {
    const entries = await readdir(directory);
    if (entries.includes('private-access.json') && !expected) throw recovery();
    const manifest = z
      .object({ sessionId: z.string().uuid() })
      .strict()
      .parse(
        JSON.parse(
          await readFile(join(directory, 'active-session.json'), 'utf8'),
        ),
      );
    const names = entries.filter((name) => /\.(sqlite|db)$/.test(name)).sort();
    if (!names.includes(`${manifest.sessionId}.sqlite`) || names.length === 0)
      throw recovery();
    for (const entry of entries.filter((name) =>
      /\.(sqlite|db)(-wal|-shm)$/.test(name),
    ))
      if (!names.includes(entry.replace(/-(wal|shm)$/, ''))) throw recovery();
    for (const name of names) {
      databaseName.parse(name);
      const path = join(directory, name),
        info = await lstat(path);
      if (
        !info.isFile() ||
        info.uid !== process.getuid?.() ||
        (info.mode & 0o022) !== 0
      )
        throw recovery();
      const db = new DatabaseSync(path, { readOnly: true });
      try {
        checkDatabase(db, name.slice(0, -7), expected);
      } finally {
        db.close();
      }
    }
    return names;
  } catch {
    throw recovery();
  }
}
/** Idempotent per-database adoption never rewrites command identity, fingerprints, aliases or snapshots. */
export function bindLegacyRuntime(
  directory: string,
  names: string[],
  identity: ExecutionIdentity,
): void {
  for (const name of names) {
    databaseName.parse(name);
    const db = new DatabaseSync(join(directory, name));
    try {
      db.exec('PRAGMA synchronous=FULL; BEGIN IMMEDIATE');
      checkDatabase(db, name.slice(0, -7), identity);
      const old = db
        .prepare('SELECT value FROM settings WHERE key=?')
        .get(LEGACY_BINDING_KEY);
      if (!old)
        db.prepare('INSERT INTO settings(key,value) VALUES(?,?)').run(
          LEGACY_BINDING_KEY,
          JSON.stringify(legacyBinding(identity)),
        );
      db.prepare(
        "INSERT OR REPLACE INTO settings(key,value) VALUES('halted','true')",
      ).run();
      const hasCommands = !!db
        .prepare(
          "SELECT 1 FROM sqlite_master WHERE type='table' AND name='dashboard_commands'",
        )
        .get();
      if (hasCommands)
        for (const row of db
          .prepare('SELECT id,envelope FROM dashboard_commands')
          .all()) {
          const parsed: unknown = JSON.parse(String(row.envelope));
          const command = commandSchema.parse(parsed);
          if (command.status === 'PENDING')
            db.prepare(
              'UPDATE dashboard_commands SET envelope=? WHERE id=?',
            ).run(
              JSON.stringify({
                ...z.record(z.string(), z.unknown()).parse(parsed),
                status: 'UNKNOWN',
              }),
              String(row.id),
            );
        }
      db.exec('COMMIT');
    } catch (error) {
      try {
        db.exec('ROLLBACK');
      } catch {
        /* transaction may not have begun */
      }
      throw error;
    } finally {
      db.close();
    }
  }
}
