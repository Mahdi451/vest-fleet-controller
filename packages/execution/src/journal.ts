import { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { childResultSchema, type ChildResult } from './adapter.ts';

const auditSchema = z.object({
  balance: z.string().optional(),
  equity: z.string().optional(),
  funding: z.string().optional(),
  marketPrice: z.string().optional(),
  withdrawalGross: z.string().optional(),
  withdrawalNet: z.string().optional(),
  timestamp: z.number(),
  masterTradeId: z.string(),
  accountId: z.string().optional(),
  requestId: z.string().optional(),
  symbol: z.string().optional(),
  entryRequestId: z.string().optional(),
  protectionType: z.string().optional(),
  triggerPrice: z.string().optional(),
  reduceOnly: z.boolean().optional(),
  orderId: z.string().optional(),
  direction: z.string().optional(),
  requestedSize: z.string().optional(),
  filledSize: z.string().optional(),
  entryPrice: z.string().nullable().optional(),
  stop: z.string().optional(),
  target: z.string().optional(),
  fees: z.string().optional(),
  status: z.string(),
  error: z.string().nullable().optional(),
  adapter: z.string(),
  latency: z.number().optional(),
  fillLatencyMs: z.number().nonnegative().optional(),
  protectionLatencyMs: z.number().nonnegative().optional(),
  reconciliationLatencyMs: z.number().nonnegative().optional(),
  actualPlannedLoss: z.string().optional(),
  remainingAfterStop: z.string().optional(),
});
export type AuditEvent = z.infer<typeof auditSchema>;
export const commandSchema = z.object({
  id: z.string().regex(/^[a-f0-9]{64}$/),
  payloadHash: z.string().regex(/^[a-f0-9]{64}$/),
  ownerId: z.string(),
  instanceId: z.string(),
  sessionId: z.string().uuid(),
  previewId: z.string().length(64),
  selected: z.array(z.string()),
  createdAt: z.number(),
  expiresAt: z.number(),
  status: z.enum(['PREVIEWED', 'PENDING', 'COMPLETE', 'UNKNOWN']),
  results: z.array(childResultSchema).optional(),
});
export type CommandEnvelope = z.infer<typeof commandSchema>;
export class Journal {
  private db: DatabaseSync;
  constructor(path = ':memory:') {
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS trades(id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, result TEXT);
      CREATE TABLE IF NOT EXISTS children(id TEXT PRIMARY KEY, master_id TEXT NOT NULL, result TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS audit(id INTEGER PRIMARY KEY, event TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS dashboard_commands(id TEXT PRIMARY KEY, envelope TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS command_aliases(id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, command_id TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS browser_actions(id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, account_id TEXT NOT NULL, state TEXT NOT NULL);`);
  }
  claim(
    id: string,
    fingerprint: string,
  ): { fresh: boolean; result: ChildResult[] | null } {
    const row = this.db
      .prepare('SELECT fingerprint,result FROM trades WHERE id=?')
      .get(id);
    if (row) {
      if (row.fingerprint !== fingerprint)
        throw new Error('IDEMPOTENCY_CONFLICT');
      return {
        fresh: false,
        result: row.result ? this.readResults(String(row.result)) : null,
      };
    }
    this.db
      .prepare('INSERT INTO trades(id,fingerprint) VALUES(?,?)')
      .run(id, fingerprint);
    return { fresh: true, result: null };
  }
  replay(id: string, fingerprint: string): ChildResult[] {
    const row = this.db
      .prepare('SELECT fingerprint,result FROM trades WHERE id=?')
      .get(id);
    if (!row) throw new Error('PREVIEW_NOT_FOUND');
    if (row.fingerprint !== fingerprint)
      throw new Error('IDEMPOTENCY_CONFLICT');
    if (!row.result)
      throw new Error('INCOMPLETE_TRADE_REQUIRES_RECONCILIATION');
    return this.readResults(String(row.result));
  }
  private readResults(json: string): ChildResult[] {
    const parsed = z.array(childResultSchema).safeParse(JSON.parse(json));
    if (!parsed.success)
      throw new Error('LEGACY_RESULT_REQUIRES_RECONCILIATION');
    return parsed.data;
  }
  unresolvedAccount(accountId: string): boolean {
    return !!this.db
      .prepare(
        "SELECT 1 FROM children WHERE json_extract(result,'$.accountId')=? AND json_extract(result,'$.status')='UNKNOWN' LIMIT 1",
      )
      .get(accountId);
  }
  child(master: string, result: ChildResult) {
    childResultSchema.parse(result);
    this.db
      .prepare(
        'INSERT INTO children(id,master_id,result) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET result=excluded.result',
      )
      .run(result.requestId, master, JSON.stringify(result));
  }
  children(master: string): ChildResult[] {
    return this.db
      .prepare('SELECT result FROM children WHERE master_id=?')
      .all(master)
      .map((r) => JSON.parse(String(r.result)) as ChildResult);
  }
  allChildren(): ChildResult[] {
    return this.db
      .prepare('SELECT result FROM children')
      .all()
      .map((row) => childResultSchema.parse(JSON.parse(String(row.result))));
  }
  saveSimulator(snapshot: unknown) {
    this.db
      .prepare(
        "INSERT OR REPLACE INTO settings(key,value) VALUES('simulator',?)",
      )
      .run(JSON.stringify(snapshot));
  }
  loadSimulator(): unknown | null {
    const row = this.db
      .prepare("SELECT value FROM settings WHERE key='simulator'")
      .get();
    return row ? JSON.parse(String(row.value)) : null;
  }
  hasTrades(): boolean {
    return !!this.db.prepare('SELECT 1 FROM trades LIMIT 1').get();
  }
  /** Durable browser dispatch intent. An existing ID is never clicked a second time. */
  claimBrowserAction(
    id: string,
    fingerprint: string,
    accountId: string,
  ): boolean {
    const old = this.db
      .prepare('SELECT fingerprint,account_id FROM browser_actions WHERE id=?')
      .get(id);
    if (old) {
      if (old.fingerprint !== fingerprint || old.account_id !== accountId)
        throw new Error('IDEMPOTENCY_CONFLICT');
      return false;
    }
    this.db
      .prepare("INSERT INTO browser_actions VALUES(?,?,?,'SUBMITTING')")
      .run(id, fingerprint, accountId);
    return true;
  }
  confirmBrowserAction(id: string) {
    this.db
      .prepare("UPDATE browser_actions SET state='CONFIRMED' WHERE id=?")
      .run(id);
  }
  browserActionAccount(id: string): string | null {
    const row = this.db
      .prepare('SELECT account_id FROM browser_actions WHERE id=?')
      .get(id);
    return row ? String(row.account_id) : null;
  }
  hasBrowserActions(): boolean {
    return !!this.db.prepare('SELECT 1 FROM browser_actions LIMIT 1').get();
  }
  finish(id: string, result: ChildResult[]) {
    this.db
      .prepare('UPDATE trades SET result=? WHERE id=?')
      .run(JSON.stringify(result), id);
  }
  halted(): boolean {
    return (
      !!this.db.prepare("SELECT 1 FROM settings WHERE key='halted'").get() ||
      !!this.db
        .prepare(
          "SELECT 1 FROM browser_actions WHERE state='SUBMITTING' LIMIT 1",
        )
        .get() ||
      !!this.db
        .prepare('SELECT 1 FROM trades WHERE result IS NULL LIMIT 1')
        .get() ||
      !!this.db
        .prepare(
          "SELECT 1 FROM children WHERE json_extract(result,'$.status')='UNKNOWN' OR json_extract(result,'$.state') IS NULL LIMIT 1",
        )
        .get()
    );
  }
  halt() {
    this.db
      .prepare(
        "INSERT OR REPLACE INTO settings(key,value) VALUES('halted','true')",
      )
      .run();
  }
  log(event: AuditEvent) {
    // Allowlisted fields only. Callers use fixed error codes, never raw exceptions or request headers.
    this.db
      .prepare('INSERT INTO audit(event) VALUES(?)')
      .run(JSON.stringify(auditSchema.parse(event)));
  }
  events(limit?: number): AuditEvent[] {
    if (
      limit !== undefined &&
      (!Number.isInteger(limit) || limit < 1 || limit > 1000)
    )
      throw new Error('INVALID_AUDIT_LIMIT');
    const rows =
      limit === undefined
        ? this.db.prepare('SELECT event FROM audit ORDER BY id').all()
        : this.db
            .prepare('SELECT event FROM audit ORDER BY id DESC LIMIT ?')
            .all(limit)
            .reverse();
    return rows.map((r) => JSON.parse(String(r.event)) as AuditEvent);
  }
  saveCommand(command: CommandEnvelope) {
    commandSchema.parse(command);
    this.db
      .prepare(
        'INSERT INTO dashboard_commands VALUES(?,?) ON CONFLICT(id) DO UPDATE SET envelope=excluded.envelope',
      )
      .run(command.id, JSON.stringify(command));
  }
  command(id: string): CommandEnvelope | null {
    const row = this.db
      .prepare('SELECT envelope FROM dashboard_commands WHERE id=?')
      .get(id);
    return row ? commandSchema.parse(JSON.parse(String(row.envelope))) : null;
  }
  commands(): CommandEnvelope[] {
    return this.db
      .prepare('SELECT envelope FROM dashboard_commands ORDER BY rowid DESC')
      .all()
      .map((row) => commandSchema.parse(JSON.parse(String(row.envelope))));
  }
  bindCommandAlias(id: string, fingerprint: string, commandId: string) {
    const row = this.db
      .prepare('SELECT fingerprint,command_id FROM command_aliases WHERE id=?')
      .get(id);
    if (row) {
      if (row.fingerprint !== fingerprint || row.command_id !== commandId)
        throw new Error('IDEMPOTENCY_CONFLICT');
      return;
    }
    this.db
      .prepare('INSERT INTO command_aliases VALUES(?,?,?)')
      .run(id, fingerprint, commandId);
  }
  recoverCommands() {
    for (const command of this.commands()) {
      if (command.status !== 'PENDING') continue;
      command.status = 'UNKNOWN';
      this.saveCommand(command);
      this.halt();
    }
  }
  close() {
    this.db.close();
  }
}
