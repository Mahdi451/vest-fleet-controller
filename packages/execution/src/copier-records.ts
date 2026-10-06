import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import {
  D,
  accountSchema,
  isFresh,
  type Account,
} from '../../core/src/index.ts';
import { evaluateFleetExposure } from '../../risk-engine/src/exposure.ts';
import {
  attemptObservationSchema,
  fanoutBatchPlanSchema,
  fanoutBatchSchema,
  type FanoutBatchPlan,
  copierHash,
  dispositionSchema,
  eventObservationSchema,
  followerAttemptId,
  followerAttemptSchema,
  followerCommandId,
  followerCommandSchema,
  followerPlanSchema,
  globalFailureSchema,
  leaderEventId,
  leaderEventSchema,
  leaderRootKey,
  leaderStreamId,
  leaderStreamSchema,
  type AttemptObservation,
  type CopierGlobalFailure,
  type EventObservation,
  type FollowerAttempt,
  type FollowerCommand,
  type FollowerDisposition,
  type FollowerPlan,
  type LeaderEvent,
  type LeaderStream,
} from './copier-events.ts';

export interface CopierFleetEvidence {
  accounts: readonly Account[];
  maxAgeMs: number;
}
const fleetEvidenceSchema = z
  .object({
    accounts: z.array(accountSchema).min(1).max(100),
    maxAgeMs: z.number().int().positive().max(60000),
  })
  .strict();
type Row = Record<string, unknown>;
class RecordError extends Error {}
const refuse = (code: string): never => {
  throw new RecordError(code);
};
const lifecycleSchema = z
  .object({
    ownerGeneration: z.string().uuid(),
    at: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  })
  .strict();
const parse = <T>(schema: z.ZodType<T>, input: unknown): T => {
  const value = schema.safeParse(input);
  if (!value.success) return refuse('INVALID_COPIER_RECORD');
  return value.data;
};

/** Additive record namespace over Journal's existing connection; never dispatches. */
export class CopierRecords {
  constructor(private readonly db: DatabaseSync) {
    db.exec(`PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS copier_batches(event_id TEXT PRIMARY KEY, batch TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS copier_streams(
        id TEXT PRIMARY KEY, binding TEXT NOT NULL, cursor INTEGER NOT NULL, high_water INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS copier_events(
        id TEXT PRIMARY KEY, stream_id TEXT NOT NULL, sequence INTEGER NOT NULL,
        fingerprint TEXT NOT NULL, event TEXT NOT NULL, UNIQUE(stream_id,sequence));
      CREATE TABLE IF NOT EXISTS copier_event_observations(
        id TEXT PRIMARY KEY, event_id TEXT NOT NULL, observation TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS copier_roots(
        id TEXT PRIMARY KEY, entry_event_id TEXT, closed INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS copier_commands(
        id TEXT PRIMARY KEY, event_id TEXT NOT NULL, account_id TEXT NOT NULL,
        command TEXT NOT NULL, UNIQUE(event_id,account_id));
      CREATE TABLE IF NOT EXISTS copier_attempts(
        id TEXT PRIMARY KEY, command_id TEXT NOT NULL, number INTEGER NOT NULL,
        attempt TEXT NOT NULL, UNIQUE(command_id,number));
      CREATE TABLE IF NOT EXISTS copier_attempt_observations(
        attempt_id TEXT NOT NULL, id TEXT NOT NULL, observation TEXT NOT NULL,
        PRIMARY KEY(attempt_id,id));
      CREATE TABLE IF NOT EXISTS copier_dispositions(
        root_id TEXT NOT NULL, account_id TEXT NOT NULL, disposition TEXT NOT NULL,
        PRIMARY KEY(root_id,account_id));
      CREATE INDEX IF NOT EXISTS copier_commands_account ON copier_commands(account_id);
      CREATE INDEX IF NOT EXISTS copier_events_stream ON copier_events(stream_id,sequence);`);
  }
  private transaction<T>(run: () => T): T {
    let started = false;
    try {
      this.db.exec('BEGIN IMMEDIATE');
      started = true;
      const result = run();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      if (started) {
        try {
          this.db.exec('ROLLBACK');
        } catch {
          return refuse('COPIER_STORAGE_FAILED');
        }
      }
      if (error instanceof RecordError) {
        if (error.message === 'COPIER_IDENTITY_CONFLICT')
          this.haltGlobal('EVENT_IDENTITY_CORRUPT');
        if (error.message === 'COPIER_HEDGE_CONFLICT')
          this.haltGlobal('UNSAFE_FLEET_EXPOSURE');
        if (error.message === 'COPIER_FLEET_UNPROVEN')
          this.haltGlobal('ACCOUNT_MAPPING_CORRUPT');
        if (error.message === 'COPIER_STORAGE_CORRUPT')
          this.haltGlobal('JOURNAL_INTEGRITY_LOST');
        throw error;
      }
      const busy =
        error instanceof Error && 'errcode' in error && error.errcode === 5;
      if (!busy) {
        try {
          this.haltGlobal('JOURNAL_INTEGRITY_LOST');
        } catch {
          /* Closed/damaged storage cannot acknowledge writes. */
        }
      }
      throw new RecordError(
        busy ? 'COPIER_STORAGE_BUSY' : 'COPIER_STORAGE_FAILED',
      );
    }
  }
  private read<T>(run: () => T): T {
    try {
      return run();
    } catch (error) {
      try {
        this.haltGlobal('JOURNAL_INTEGRITY_LOST');
      } catch {
        /* Best effort on damaged storage. */
      }
      if (error instanceof RecordError) throw error;
      return refuse('COPIER_STORAGE_FAILED');
    }
  }
  private stored<T>(schema: z.ZodType<T>, encoded: unknown): T {
    try {
      return schema.parse(JSON.parse(String(encoded)));
    } catch {
      return refuse('COPIER_STORAGE_CORRUPT');
    }
  }
  haltGlobal(reason: CopierGlobalFailure) {
    const value = parse(globalFailureSchema, reason);
    this.db
      .prepare(
        "INSERT OR IGNORE INTO settings(key,value) VALUES('copier_global_halt',?)",
      )
      .run(value);
  }
  globalStop(): CopierGlobalFailure | 'LEGACY_HALT' | null {
    return this.read(() => {
      if (this.db.prepare("SELECT 1 FROM settings WHERE key='halted'").get())
        return 'LEGACY_HALT';
      const row = this.db
        .prepare("SELECT value FROM settings WHERE key='copier_global_halt'")
        .get();
      if (!row) return null;
      const result = globalFailureSchema.safeParse(row.value);
      if (!result.success) return refuse('COPIER_STORAGE_CORRUPT');
      return result.data;
    });
  }
  fanoutBatch(eventId: string) {
    return this.read(() => {
      const row = this.db
        .prepare('SELECT batch FROM copier_batches WHERE event_id=?')
        .get(eventId);
      if (!row) return null;
      const batch = this.stored(fanoutBatchSchema, row.batch);
      const payloadHash = batch.payloadHash,
        plan = {
          eventId: batch.eventId,
          followerAccountIds: batch.followerAccountIds,
          intent: batch.intent,
        };
      const event = this.leaderEvent(eventId);
      if (
        batch.eventId !== eventId ||
        payloadHash !== copierHash(plan) ||
        !event ||
        event.kind !== 'ENTRY' ||
        batch.intent.side !== event.side ||
        batch.intent.symbol !== event.symbol ||
        !new D(batch.intent.leverage).eq(event.leverage) ||
        batch.followerAccountIds.includes(event.leaderAccountId)
      )
        return refuse('COPIER_STORAGE_CORRUPT');
      return batch;
    });
  }
  claimFanoutBatch(
    input: FanoutBatchPlan,
    ownerGeneration: string,
    at: number,
    fleetEvidence?: CopierFleetEvidence,
  ) {
    const plan = parse(fanoutBatchPlanSchema, input),
      life = parse(lifecycleSchema, { ownerGeneration, at });
    return this.transaction(() => {
      const previous = this.fanoutBatch(plan.eventId),
        payloadHash = copierHash(plan);
      if (previous) {
        if (previous.payloadHash !== payloadHash)
          return refuse('COPIER_IDENTITY_CONFLICT');
        return { fresh: false, batch: previous };
      }
      if (this.globalStop()) return refuse('COPIER_GLOBAL_STOP');
      const event = this.leaderEvent(plan.eventId);
      if (
        !event ||
        event.kind !== 'ENTRY' ||
        plan.intent.symbol !== event.symbol ||
        plan.intent.side !== event.side ||
        !new D(plan.intent.leverage).eq(event.leverage) ||
        plan.followerAccountIds.includes(event.leaderAccountId) ||
        at < event.occurredAt
      )
        return refuse('COPIER_IDENTITY_CONFLICT');
      const stream = this.db
        .prepare('SELECT cursor,high_water FROM copier_streams WHERE id=?')
        .get(leaderStreamId(event));
      if (!stream || stream.cursor !== stream.high_water)
        return refuse('LEADER_SEQUENCE_GAP');
      if (event.sequence !== stream.high_water)
        return refuse('STALE_LEADER_EVENT');
      this.assertFleetExposure(
        {
          operation: 'ENTRY',
          side: event.side,
          symbol: event.symbol,
          followerAccountId: plan.followerAccountIds[0]!,
        },
        life.at,
        fleetEvidence,
      );
      const batch = {
        ...plan,
        payloadHash,
        ownerGeneration: life.ownerGeneration,
        activatedAt: life.at,
      };
      this.db
        .prepare('INSERT INTO copier_batches VALUES(?,?)')
        .run(plan.eventId, JSON.stringify(batch));
      return { fresh: true, batch };
    });
  }
  registerLeaderStream(input: LeaderStream): string {
    const stream = parse(leaderStreamSchema, input);
    const key = leaderStreamId(stream);
    return this.transaction(() => {
      const previous = this.db
        .prepare('SELECT binding FROM copier_streams WHERE id=?')
        .get(key);
      if (previous && previous.binding !== JSON.stringify(stream))
        refuse('COPIER_IDENTITY_CONFLICT');
      if (!previous)
        this.db
          .prepare('INSERT INTO copier_streams VALUES(?,?,?,?)')
          .run(
            key,
            JSON.stringify(stream),
            stream.baselineSequence,
            stream.baselineSequence,
          );
      return key;
    });
  }
  private event(row: Row): LeaderEvent {
    const event = this.stored(leaderEventSchema, row.event);
    if (
      leaderEventId(event) !== row.id ||
      copierHash(event) !== row.fingerprint ||
      leaderStreamId(event) !== row.stream_id ||
      event.sequence !== row.sequence
    )
      refuse('COPIER_STORAGE_CORRUPT');
    return event;
  }
  leaderEvent(eventId: string): LeaderEvent | null {
    return this.read(() => {
      const row = this.db
        .prepare('SELECT * FROM copier_events WHERE id=?')
        .get(eventId);
      return row ? this.event(row) : null;
    });
  }
  eventContiguous(eventId: string): boolean {
    return this.read(() => {
      const event = this.leaderEvent(eventId);
      if (!event) return false;
      const stream = this.db
        .prepare('SELECT cursor,high_water FROM copier_streams WHERE id=?')
        .get(leaderStreamId(event));
      return (
        !!stream &&
        Number(stream.cursor) === Number(stream.high_water) &&
        Number(stream.cursor) >= event.sequence
      );
    });
  }
  firstDetection(eventId: string): EventObservation | null {
    return this.read(() => {
      if (!this.leaderEvent(eventId)) return null;
      const row = this.db
        .prepare(
          'SELECT * FROM copier_event_observations WHERE event_id=? ORDER BY rowid LIMIT 1',
        )
        .get(eventId);
      if (!row) return null;
      const observation = this.stored(eventObservationSchema, row.observation);
      if (row.id !== copierHash([eventId, observation]))
        return refuse('COPIER_STORAGE_CORRUPT');
      return observation;
    });
  }
  /** Execution history is independent from the dashboard's recent-event display limit. */
  leaderRootHistory(rootKey: string) {
    return this.read(() =>
      this.db
        .prepare('SELECT * FROM copier_events ORDER BY sequence')
        .all()
        .map((row) => ({ eventId: String(row.id), event: this.event(row) }))
        .filter((row) => leaderRootKey(row.event) === rootKey),
    );
  }
  leaderEvents() {
    return this.read(() =>
      this.db
        .prepare('SELECT * FROM copier_events ORDER BY rowid DESC LIMIT 100')
        .all()
        .map((row) => ({ eventId: String(row.id), event: this.event(row) })),
    );
  }
  recordLeaderEvent(input: LeaderEvent, observationInput: EventObservation) {
    const event = parse(leaderEventSchema, input);
    const observation = parse(eventObservationSchema, observationInput);
    if (observation.detectedAt < event.occurredAt)
      refuse('INVALID_EVENT_OBSERVATION');
    const eventId = leaderEventId(event),
      streamId = leaderStreamId(event);
    return this.transaction(() => {
      const stream = this.db
        .prepare('SELECT * FROM copier_streams WHERE id=?')
        .get(streamId);
      if (!stream) return refuse('LEADER_STREAM_UNREGISTERED');
      const binding = this.stored(leaderStreamSchema, stream.binding);
      if (
        leaderStreamId(binding) !== streamId ||
        !Number.isSafeInteger(stream.cursor) ||
        !Number.isSafeInteger(stream.high_water) ||
        Number(stream.cursor) < binding.baselineSequence ||
        Number(stream.high_water) < Number(stream.cursor)
      )
        return refuse('COPIER_STORAGE_CORRUPT');
      if (event.sequence <= binding.baselineSequence)
        refuse('EVENT_BEFORE_BASELINE');
      const previous = this.db
        .prepare('SELECT * FROM copier_events WHERE id=?')
        .get(eventId);
      const sequence = this.db
        .prepare(
          'SELECT id FROM copier_events WHERE stream_id=? AND sequence=?',
        )
        .get(streamId, event.sequence);
      if (
        (previous && previous.fingerprint !== copierHash(event)) ||
        (sequence && sequence.id !== eventId)
      )
        refuse('COPIER_IDENTITY_CONFLICT');
      if (previous) this.event(previous);
      else
        this.db
          .prepare('INSERT INTO copier_events VALUES(?,?,?,?,?)')
          .run(
            eventId,
            streamId,
            event.sequence,
            copierHash(event),
            JSON.stringify(event),
          );
      this.db
        .prepare(
          'INSERT OR IGNORE INTO copier_event_observations VALUES(?,?,?)',
        )
        .run(
          copierHash([eventId, observation]),
          eventId,
          JSON.stringify(observation),
        );
      const root = leaderRootKey(event);
      const existingRoot = this.db
        .prepare('SELECT entry_event_id FROM copier_roots WHERE id=?')
        .get(root);
      if (
        event.kind === 'ENTRY' &&
        existingRoot?.entry_event_id &&
        existingRoot.entry_event_id !== eventId
      )
        return refuse('COPIER_STORAGE_CORRUPT');
      if (event.kind === 'ENTRY')
        this.db
          .prepare(
            'INSERT INTO copier_roots VALUES(?,?,0) ON CONFLICT(id) DO UPDATE SET entry_event_id=excluded.entry_event_id',
          )
          .run(root, eventId);
      if (event.kind === 'CLOSE')
        this.db
          .prepare(
            'INSERT INTO copier_roots VALUES(?,NULL,1) ON CONFLICT(id) DO UPDATE SET closed=1',
          )
          .run(root);
      let cursor = Number(stream.cursor);
      while (
        this.db
          .prepare(
            'SELECT 1 FROM copier_events WHERE stream_id=? AND sequence=?',
          )
          .get(streamId, cursor + 1)
      )
        cursor++;
      const highWater = Math.max(Number(stream.high_water), event.sequence);
      this.db
        .prepare('UPDATE copier_streams SET cursor=?,high_water=? WHERE id=?')
        .run(cursor, highWater, streamId);
      return { fresh: !previous, eventId, contiguous: cursor === highWater };
    });
  }
  eventObservations(eventId: string): EventObservation[] {
    return this.read(() => {
      return this.db
        .prepare(
          'SELECT observation FROM copier_event_observations WHERE event_id=? ORDER BY rowid',
        )
        .all(eventId)
        .map((row) => this.stored(eventObservationSchema, row.observation));
    });
  }
  private command(row: Row): FollowerCommand {
    const command = this.stored(followerCommandSchema, row.command);
    const { commandId, payloadHash, ...payload } = command;
    const event = this.leaderEvent(command.eventId);
    if (
      commandId !== row.id ||
      commandId !==
        followerCommandId(command.eventId, command.followerAccountId) ||
      payloadHash !== copierHash(payload) ||
      row.account_id !== command.followerAccountId ||
      row.event_id !== command.eventId ||
      !event ||
      command.rootKey !== leaderRootKey(event) ||
      command.symbol !== event.symbol ||
      command.side !== event.side ||
      command.operation !== event.kind ||
      command.price !== ('price' in event ? event.price : null)
    )
      refuse('COPIER_STORAGE_CORRUPT');
    return command;
  }
  followerCommand(commandId: string): FollowerCommand | null {
    return this.read(() => {
      const row = this.db
        .prepare('SELECT * FROM copier_commands WHERE id=?')
        .get(commandId);
      return row ? this.command(row) : null;
    });
  }
  private attempt(row: Row): FollowerAttempt {
    const attempt = this.stored(followerAttemptSchema, row.attempt);
    if (
      attempt.attemptId !== row.id ||
      attempt.commandId !== row.command_id ||
      attempt.number !== row.number ||
      attempt.attemptId !==
        followerAttemptId(attempt.commandId, attempt.number) ||
      attempt.previousAttemptId !==
        (attempt.number === 1
          ? null
          : followerAttemptId(attempt.commandId, attempt.number - 1))
    )
      refuse('COPIER_STORAGE_CORRUPT');
    const command = this.followerCommand(attempt.commandId);
    if (
      !command ||
      (attempt.terminal &&
        (attempt.terminal.attemptId !== attempt.attemptId ||
          attempt.terminal.payloadHash !== command.payloadHash ||
          attempt.terminal.accountId !== command.followerAccountId))
    )
      refuse('COPIER_STORAGE_CORRUPT');
    return attempt;
  }
  followerAttempt(attemptId: string): FollowerAttempt | null {
    return this.read(() => {
      const row = this.db
        .prepare('SELECT * FROM copier_attempts WHERE id=?')
        .get(attemptId);
      return row ? this.attempt(row) : null;
    });
  }
  followerAttempts(commandId: string): FollowerAttempt[] {
    return this.read(() => {
      return this.db
        .prepare(
          'SELECT * FROM copier_attempts WHERE command_id=? ORDER BY number',
        )
        .all(commandId)
        .map((row) => this.attempt(row));
    });
  }
  accountBlockers(accountId: string, exceptCommandId?: string) {
    return this.read(() => {
      return this.db
        .prepare(
          `SELECT a.* FROM copier_commands c JOIN copier_attempts a ON a.command_id=c.id
      WHERE c.account_id=? AND a.number=(SELECT MAX(number) FROM copier_attempts WHERE command_id=c.id)`,
        )
        .all(accountId)
        .map((row) => this.attempt(row))
        .filter(
          (attempt) =>
            attempt.commandId !== exceptCommandId &&
            (!attempt.terminal || attempt.outcome.exposure !== 'ABSENT'),
        );
    });
  }
  eventFollowers(eventId: string) {
    return this.read(() =>
      this.db
        .prepare(
          'SELECT * FROM copier_commands WHERE event_id=? ORDER BY account_id',
        )
        .all(eventId)
        .map((row) => {
          const command = this.command(row),
            attempt = this.followerAttempts(command.commandId).at(-1);
          if (!attempt) return refuse('COPIER_STORAGE_CORRUPT');
          return { command, attempt };
        }),
    );
  }
  private admission(command: FollowerCommand) {
    if (this.globalStop()) refuse('COPIER_GLOBAL_STOP');
    const event = this.leaderEvent(command.eventId);
    if (!event) return refuse('LEADER_EVENT_MISSING');
    const stream = this.db
      .prepare('SELECT cursor,high_water FROM copier_streams WHERE id=?')
      .get(leaderStreamId(event));
    if (!stream || stream.cursor !== stream.high_water)
      return refuse('LEADER_SEQUENCE_GAP');
    if (event.sequence !== stream.high_water) refuse('STALE_LEADER_EVENT');
    const root = this.db
      .prepare('SELECT * FROM copier_roots WHERE id=?')
      .get(command.rootKey);
    if (!root?.entry_event_id) return refuse('ENTRY_ROOT_UNPROVEN');
    const entry = this.leaderEvent(String(root.entry_event_id));
    if (
      !entry ||
      entry.kind !== 'ENTRY' ||
      leaderRootKey(entry) !== command.rootKey ||
      ![0, 1].includes(Number(root.closed))
    )
      return refuse('COPIER_STORAGE_CORRUPT');
    const opening =
      command.operation === 'ENTRY' || command.operation === 'ADD';
    if (
      opening &&
      (root.closed ||
        this.db
          .prepare(
            'SELECT 1 FROM copier_dispositions WHERE root_id=? AND account_id=?',
          )
          .get(command.rootKey, command.followerAccountId))
    )
      refuse('FOLLOWER_EVENT_EXITED_OR_SKIPPED');
    const blockers = this.accountBlockers(
      command.followerAccountId,
      command.commandId,
    );
    if (
      blockers.some(
        (attempt) =>
          !attempt.terminal ||
          attempt.outcome.exposure === 'UNKNOWN' ||
          (attempt.outcome.exposure === 'PRESENT' &&
            (attempt.outcome.submission !== 'ACCEPTED' ||
              attempt.terminal.result !== 'FILLED' ||
              !new D(attempt.outcome.filledQuantity).gt(0))),
      )
    )
      refuse('FOLLOWER_REQUIRES_RECONCILIATION');
    if (command.operation === 'ENTRY' && blockers.length)
      refuse('FOLLOWER_HAS_EXPOSURE');
    if (
      command.operation !== 'ENTRY' &&
      !blockers.some(
        (attempt) =>
          this.followerCommand(attempt.commandId)?.rootKey ===
            command.rootKey && attempt.outcome.exposure === 'PRESENT',
      )
    )
      refuse(
        command.operation === 'ADD'
          ? 'FOLLOWER_ADD_REQUIRES_OWNED_EXPOSURE'
          : 'FOLLOWER_MUTATION_REQUIRES_OWNED_EXPOSURE',
      );
  }
  /** Possible entry exposure remains reserved until terminal proof AND absent exposure. */
  private assertFleetExposure(
    command: Pick<
      FollowerCommand,
      'operation' | 'side' | 'symbol' | 'followerAccountId'
    >,
    at: number,
    evidence?: CopierFleetEvidence,
  ) {
    if (command.operation !== 'ENTRY' && command.operation !== 'ADD') return;
    if (evidence) {
      const parsed = fleetEvidenceSchema.safeParse(evidence);
      if (
        !parsed.success ||
        new Set(parsed.data.accounts.map((a) => a.accountId)).size !==
          parsed.data.accounts.length ||
        !parsed.data.accounts.some(
          (a) => a.accountId === command.followerAccountId && a.enabled,
        ) ||
        parsed.data.accounts.some(
          (a) =>
            a.enabled &&
            !isFresh(a.lastSyncTimestamp, at, parsed.data.maxAgeMs),
        )
      )
        refuse('COPIER_FLEET_UNPROVEN');
      if (!parsed.success) return refuse('COPIER_FLEET_UNPROVEN');
      if (evaluateFleetExposure(command, parsed.data.accounts).length)
        refuse('COPIER_HEDGE_CONFLICT');
    }
    const rows = this.db
      .prepare(
        `SELECT a.* FROM copier_attempts a WHERE a.number=(SELECT MAX(number) FROM copier_attempts WHERE command_id=a.command_id)`,
      )
      .all();
    for (const row of rows) {
      const attempt = this.attempt(row);
      if (attempt.terminal && attempt.outcome.exposure === 'ABSENT') continue;
      const reserved = this.followerCommand(attempt.commandId);
      if (!reserved) return refuse('COPIER_STORAGE_CORRUPT');
      if (
        reserved.symbol === command.symbol &&
        reserved.side !== command.side &&
        (reserved.operation === 'ENTRY' || reserved.operation === 'ADD')
      )
        refuse('COPIER_HEDGE_CONFLICT');
    }
  }
  private createAttempt(
    command: FollowerCommand,
    number: number,
    ownerGeneration: string,
    at: number,
  ): FollowerAttempt {
    const opening =
      command.operation === 'ENTRY' || command.operation === 'ADD';
    const attempt: FollowerAttempt = {
      attemptId: followerAttemptId(command.commandId, number),
      commandId: command.commandId,
      number,
      previousAttemptId:
        number === 1 ? null : followerAttemptId(command.commandId, number - 1),
      ownerGeneration,
      claimedAt: at,
      dispatchStartedAt: null,
      revision: 0,
      outcome: {
        submission: 'NOT_SENT',
        fill: 'NONE',
        filledQuantity: '0',
        fillPrice: null,
        stop: opening ? 'MISSING' : 'NOT_REQUIRED',
        target: opening ? 'MISSING' : 'NOT_REQUIRED',
        exposure: 'UNKNOWN',
        reason: 'NONE',
      },
      terminal: null,
    };
    this.db
      .prepare('INSERT INTO copier_attempts VALUES(?,?,?,?)')
      .run(
        attempt.attemptId,
        command.commandId,
        number,
        JSON.stringify(attempt),
      );
    return attempt;
  }
  claimFollowerAttempt(
    input: FollowerPlan,
    ownerGeneration: string,
    at: number,
    fleetEvidence?: CopierFleetEvidence,
  ) {
    const plan = parse(followerPlanSchema, input),
      life = parse(lifecycleSchema, { ownerGeneration, at });
    return this.transaction(() => {
      const batch = this.fanoutBatch(plan.eventId);
      if (
        batch &&
        (batch.ownerGeneration !== life.ownerGeneration ||
          !batch.followerAccountIds.includes(plan.followerAccountId))
      )
        return refuse('COPIER_IDENTITY_CONFLICT');
      const event = this.leaderEvent(plan.eventId);
      if (!event) return refuse('LEADER_EVENT_MISSING');
      if (plan.followerAccountId === event.leaderAccountId)
        refuse('LEADER_CANNOT_BE_FOLLOWER');
      const payload = {
        eventId: plan.eventId,
        rootKey: leaderRootKey(event),
        followerAccountId: plan.followerAccountId,
        symbol: event.symbol,
        side: event.side,
        operation: event.kind,
        quantity: plan.quantity,
        leverage: plan.leverage,
        price: 'price' in event ? event.price : null,
      };
      const command: FollowerCommand = {
        commandId: followerCommandId(plan.eventId, plan.followerAccountId),
        ...payload,
        payloadHash: copierHash(payload),
      };
      const previous = this.followerCommand(command.commandId);
      if (previous && previous.payloadHash !== command.payloadHash)
        refuse('COPIER_IDENTITY_CONFLICT');
      if (previous) {
        const attempt = this.followerAttempts(command.commandId).at(-1);
        if (!attempt) return refuse('COPIER_STORAGE_CORRUPT');
        return { fresh: false, command: previous, attempt };
      }
      if (life.at < event.occurredAt) refuse('INVALID_COPIER_TIME');
      this.admission(command);
      this.assertFleetExposure(command, life.at, fleetEvidence);
      this.db
        .prepare('INSERT INTO copier_commands VALUES(?,?,?,?)')
        .run(
          command.commandId,
          command.eventId,
          command.followerAccountId,
          JSON.stringify(command),
        );
      return {
        fresh: true,
        command,
        attempt: this.createAttempt(command, 1, life.ownerGeneration, life.at),
      };
    });
  }
  markDispatchStarted(
    attemptId: string,
    ownerGeneration: string,
    at: number,
    fleetEvidence?: CopierFleetEvidence,
  ) {
    const life = parse(lifecycleSchema, { ownerGeneration, at });
    return this.transaction(() => {
      const attempt = this.followerAttempt(attemptId);
      if (!attempt) return refuse('FOLLOWER_ATTEMPT_MISSING');
      if (
        attempt.ownerGeneration !== life.ownerGeneration ||
        attempt.dispatchStartedAt !== null ||
        attempt.terminal ||
        attempt.outcome.submission !== 'NOT_SENT' ||
        life.at < attempt.claimedAt
      )
        refuse('DISPATCH_CLAIM_REFUSED');
      const command = this.followerCommand(attempt.commandId);
      if (!command) return refuse('COPIER_STORAGE_CORRUPT');
      const batch = this.fanoutBatch(command.eventId);
      if (
        batch &&
        attempt.number === 1 &&
        (batch.ownerGeneration !== life.ownerGeneration ||
          !batch.followerAccountIds.includes(command.followerAccountId))
      )
        return refuse('COPIER_IDENTITY_CONFLICT');
      this.admission(command);
      this.assertFleetExposure(command, life.at, fleetEvidence);
      attempt.dispatchStartedAt = life.at;
      attempt.revision++;
      attempt.outcome.submission = 'SUBMITTING';
      this.db
        .prepare('UPDATE copier_attempts SET attempt=? WHERE id=?')
        .run(JSON.stringify(attempt), attemptId);
      return attempt;
    });
  }
  recordAttemptObservation(
    attemptId: string,
    expectedRevision: number,
    input: AttemptObservation,
  ) {
    const observation = parse(attemptObservationSchema, input);
    return this.transaction(() => {
      const previous = this.db
        .prepare(
          'SELECT observation FROM copier_attempt_observations WHERE attempt_id=? AND id=?',
        )
        .get(attemptId, observation.observationId);
      const attempt = this.followerAttempt(attemptId);
      if (!attempt) return refuse('FOLLOWER_ATTEMPT_MISSING');
      if (previous) {
        if (previous.observation !== JSON.stringify(observation))
          refuse('COPIER_IDENTITY_CONFLICT');
        return attempt;
      }
      if (
        this.db
          .prepare(
            'SELECT 1 FROM copier_attempts WHERE command_id=? AND number>?',
          )
          .get(attempt.commandId, attempt.number)
      )
        refuse('HISTORICAL_ATTEMPT_IMMUTABLE');
      if (attempt.revision !== expectedRevision)
        refuse('FOLLOWER_OBSERVATION_CONFLICT');
      const command = this.followerCommand(attempt.commandId);
      if (!command) return refuse('COPIER_STORAGE_CORRUPT');
      const latest = this.db
        .prepare(
          'SELECT observation FROM copier_attempt_observations WHERE attempt_id=? ORDER BY rowid DESC LIMIT 1',
        )
        .get(attemptId);
      const lastAt = latest
        ? this.stored(attemptObservationSchema, latest.observation).observedAt
        : (attempt.dispatchStartedAt ?? attempt.claimedAt);
      const out = observation.outcome,
        proof = observation.terminal;
      if (
        observation.observedAt < lastAt ||
        new D(out.filledQuantity).lt(attempt.outcome.filledQuantity) ||
        new D(out.filledQuantity).gt(command.quantity) ||
        (out.fill === 'FILLED' &&
          !new D(out.filledQuantity).eq(command.quantity)) ||
        (out.fill === 'PARTIAL' &&
          new D(out.filledQuantity).gte(command.quantity)) ||
        (attempt.outcome.fillPrice !== null &&
          new D(out.filledQuantity).eq(attempt.outcome.filledQuantity) &&
          out.fillPrice !== attempt.outcome.fillPrice) ||
        (attempt.terminal &&
          !new D(out.filledQuantity).eq(attempt.outcome.filledQuantity)) ||
        ((attempt.outcome.exposure === 'PRESENT' ||
          new D(out.filledQuantity).gt(0)) &&
          out.exposure === 'ABSENT' &&
          proof?.result !== 'EXITED') ||
        (attempt.dispatchStartedAt === null && out.submission !== 'NOT_SENT') ||
        (attempt.dispatchStartedAt !== null && out.submission === 'NOT_SENT') ||
        (['REJECTED', 'ACCEPTED'].includes(attempt.outcome.submission) &&
          out.submission !== attempt.outcome.submission)
      )
        refuse('FOLLOWER_OBSERVATION_REFUSED');
      if (
        out.submission === 'REJECTED' &&
        (!proof || proof.result !== 'REJECTED')
      )
        refuse('TERMINAL_EVIDENCE_REQUIRED');
      if (
        proof &&
        (proof.attemptId !== attemptId ||
          proof.payloadHash !== command.payloadHash ||
          proof.accountId !== command.followerAccountId ||
          proof.observedAt !== observation.observedAt ||
          (proof.result === 'NOT_SENT' &&
            (attempt.dispatchStartedAt !== null ||
              out.submission !== 'NOT_SENT' ||
              out.fill !== 'NONE' ||
              out.exposure !== 'ABSENT')) ||
          (proof.result === 'REJECTED' &&
            (out.submission !== 'REJECTED' || out.fill !== 'NONE')) ||
          (proof.result === 'FILLED' &&
            (out.submission !== 'ACCEPTED' ||
              !['FILLED', 'PARTIAL'].includes(out.fill))) ||
          (proof.result === 'EXITED' &&
            (out.submission !== 'ACCEPTED' || out.exposure !== 'ABSENT')))
      )
        refuse('TERMINAL_EVIDENCE_REFUSED');
      if (
        attempt.terminal &&
        (!proof ||
          (attempt.terminal.result !== 'FILLED' &&
            proof.result !== attempt.terminal.result) ||
          (attempt.terminal.result === 'FILLED' &&
            !['FILLED', 'EXITED'].includes(proof.result)) ||
          proof.providerOrderId !== attempt.terminal.providerOrderId)
      )
        refuse('TERMINAL_EVIDENCE_IMMUTABLE');
      attempt.revision++;
      attempt.outcome = out;
      attempt.terminal = proof;
      this.db
        .prepare('INSERT INTO copier_attempt_observations VALUES(?,?,?)')
        .run(attemptId, observation.observationId, JSON.stringify(observation));
      this.db
        .prepare('UPDATE copier_attempts SET attempt=? WHERE id=?')
        .run(JSON.stringify(attempt), attemptId);
      return attempt;
    });
  }
  attemptObservations(attemptId: string): AttemptObservation[] {
    return this.read(() => {
      return this.db
        .prepare(
          'SELECT observation FROM copier_attempt_observations WHERE attempt_id=? ORDER BY rowid',
        )
        .all(attemptId)
        .map((row) => this.stored(attemptObservationSchema, row.observation));
    });
  }
  followerDisposition(eventId: string, accountId: string) {
    return this.read(() => {
      const event = this.leaderEvent(eventId);
      if (!event) return null;
      const root = leaderRootKey(event),
        row = this.db
          .prepare(
            'SELECT disposition FROM copier_dispositions WHERE root_id=? AND account_id=?',
          )
          .get(root, accountId);
      if (!row) return null;
      const disposition = this.stored(dispositionSchema, row.disposition),
        source = this.leaderEvent(disposition.eventId);
      if (
        disposition.followerAccountId !== accountId ||
        !source ||
        leaderRootKey(source) !== root
      )
        return refuse('COPIER_STORAGE_CORRUPT');
      return disposition;
    });
  }
  recordFollowerDisposition(input: FollowerDisposition) {
    const disposition = parse(dispositionSchema, input);
    return this.transaction(() => {
      const event = this.leaderEvent(disposition.eventId);
      if (!event) return refuse('LEADER_EVENT_MISSING');
      if (
        disposition.followerAccountId === event.leaderAccountId ||
        disposition.observedAt < event.occurredAt
      )
        refuse('FOLLOWER_DISPOSITION_REFUSED');
      const key = leaderRootKey(event);
      this.db
        .prepare('INSERT OR IGNORE INTO copier_dispositions VALUES(?,?,?)')
        .run(key, disposition.followerAccountId, JSON.stringify(disposition));
      return this.stored(
        dispositionSchema,
        this.db
          .prepare(
            'SELECT disposition FROM copier_dispositions WHERE root_id=? AND account_id=?',
          )
          .get(key, disposition.followerAccountId)?.disposition,
      );
    });
  }
  claimExplicitRetry(
    commandId: string,
    previousAttemptId: string,
    ownerGeneration: string,
    at: number,
    fleetEvidence?: CopierFleetEvidence,
  ) {
    const life = parse(lifecycleSchema, { ownerGeneration, at });
    return this.transaction(() => {
      const command = this.followerCommand(commandId);
      if (!command) return refuse('FOLLOWER_COMMAND_MISSING');
      const attempts = this.followerAttempts(commandId),
        previous = attempts.find(
          (item) => item.attemptId === previousAttemptId,
        );
      if (!previous) return refuse('FOLLOWER_ATTEMPT_MISSING');
      const existing = attempts.find(
        (item) => item.previousAttemptId === previousAttemptId,
      );
      if (existing) return { fresh: false, command, attempt: existing };
      if (
        previous.attemptId !== attempts.at(-1)?.attemptId ||
        !previous.terminal ||
        !['NOT_SENT', 'REJECTED'].includes(previous.terminal.result) ||
        previous.outcome.filledQuantity !== '0' ||
        previous.outcome.exposure !== 'ABSENT' ||
        life.at < previous.terminal.observedAt
      )
        refuse('EXPLICIT_RETRY_UNPROVEN');
      this.admission(command);
      this.assertFleetExposure(command, life.at, fleetEvidence);
      return {
        fresh: true,
        command,
        attempt: this.createAttempt(
          command,
          previous.number + 1,
          life.ownerGeneration,
          life.at,
        ),
      };
    });
  }
}
