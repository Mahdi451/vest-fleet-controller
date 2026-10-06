import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';

export const latencyPhases = [
  'LEADER_DETECTED',
  'SUBMIT_STARTED',
  'ACKNOWLEDGED',
  'FILL_DETECTED',
  'PROTECTION_DETECTED',
] as const;
const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const latencyStampSchema = z
  .object({
    environment: z.literal('OFFLINE_FIXTURE'),
    evidence: z.literal('SYNTHETIC'),
    eventId: digest,
    accountId: z.string().regex(/^[A-Za-z0-9_:.-]{1,100}$/),
    attemptId: digest,
    phase: z.enum(latencyPhases),
    observedAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    clockSource: z.string().regex(/^[A-Za-z0-9_:.-]{1,100}$/),
    generation: z.string().uuid(),
  })
  .strict();
export type LatencyStamp = z.infer<typeof latencyStampSchema>;
type Phase = LatencyStamp['phase'];
class LatencyError extends Error {}
const fail = (code: string): never => {
  throw new LatencyError(code);
};
const domain = (stamp: LatencyStamp) =>
  JSON.stringify([stamp.clockSource, stamp.generation]);
const edges: readonly (readonly [Phase, Phase])[] = [
  ['LEADER_DETECTED', 'SUBMIT_STARTED'],
  ['SUBMIT_STARTED', 'ACKNOWLEDGED'],
  ['SUBMIT_STARTED', 'FILL_DETECTED'],
  ['FILL_DETECTED', 'PROTECTION_DETECTED'],
];

/** Observed synthetic timings only; these records never establish execution success. */
export class CopierLatencyStore {
  constructor(private readonly db: DatabaseSync) {
    this.safe(() =>
      db.exec(`CREATE TABLE IF NOT EXISTS copier_latency_stamps(
      event_id TEXT NOT NULL, account_id TEXT NOT NULL, attempt_id TEXT NOT NULL,
      phase TEXT NOT NULL, stamp TEXT NOT NULL,
      PRIMARY KEY(event_id,account_id,attempt_id,phase));`),
    );
  }
  private safe<T>(run: () => T): T {
    try {
      return run();
    } catch (error) {
      if (error instanceof LatencyError) throw error;
      return fail('LATENCY_STORAGE_FAILED');
    }
  }
  private decode(encoded: unknown): LatencyStamp {
    try {
      return latencyStampSchema.parse(JSON.parse(String(encoded)));
    } catch {
      return fail('LATENCY_STORAGE_CORRUPT');
    }
  }
  private stamps(eventId: string, accountId: string, attemptId: string) {
    return this.db
      .prepare(
        'SELECT * FROM copier_latency_stamps WHERE event_id=? AND account_id=? AND attempt_id=?',
      )
      .all(eventId, accountId, attemptId)
      .map((row) => {
        const stamp = this.decode(row.stamp);
        if (
          stamp.eventId !== row.event_id ||
          stamp.accountId !== row.account_id ||
          stamp.attemptId !== row.attempt_id ||
          stamp.phase !== row.phase
        )
          fail('LATENCY_STORAGE_CORRUPT');
        return stamp;
      });
  }
  recordStamp(input: LatencyStamp): LatencyStamp {
    const parsed = latencyStampSchema.safeParse(input);
    if (!parsed.success) return fail('INVALID_LATENCY_STAMP');
    const stamp = parsed.data;
    return this.safe(() => {
      let started = false;
      try {
        this.db.exec('BEGIN IMMEDIATE');
        started = true;
        const previous = this.stamps(
          stamp.eventId,
          stamp.accountId,
          stamp.attemptId,
        );
        const same = previous.find((item) => item.phase === stamp.phase);
        if (same) {
          if (JSON.stringify(same) !== JSON.stringify(stamp))
            fail('LATENCY_STAMP_CONFLICT');
          this.db.exec('COMMIT');
          started = false;
          return same;
        }
        if (
          previous.some(
            (item) =>
              domain(item) === domain(stamp) &&
              stamp.observedAt < item.observedAt,
          )
        )
          fail('LATENCY_CLOCK_ROLLBACK');
        const all = [...previous, stamp];
        for (const [before, after] of edges) {
          const a = all.find((item) => item.phase === before),
            b = all.find((item) => item.phase === after);
          if (a && b && domain(a) === domain(b) && b.observedAt < a.observedAt)
            fail('LATENCY_PHASE_ORDER_INVALID');
        }
        this.db
          .prepare('INSERT INTO copier_latency_stamps VALUES(?,?,?,?,?)')
          .run(
            stamp.eventId,
            stamp.accountId,
            stamp.attemptId,
            stamp.phase,
            JSON.stringify(stamp),
          );
        this.db.exec('COMMIT');
        started = false;
        return stamp;
      } finally {
        if (started) this.db.exec('ROLLBACK');
      }
    });
  }
  attemptMetrics(eventId: string, accountId: string, attemptId: string) {
    if (
      !latencyStampSchema
        .pick({ eventId: true, accountId: true, attemptId: true })
        .safeParse({ eventId, accountId, attemptId }).success
    )
      return fail('INVALID_LATENCY_REFERENCE');
    return this.safe(() => {
      const stamps = this.stamps(eventId, accountId, attemptId);
      const invalid = new Set<
        'CLOCK_DOMAIN_MISMATCH' | 'PHASE_ORDER_INVALID'
      >();
      const elapsed = (before: Phase, after: Phase): number | null => {
        const a = stamps.find((item) => item.phase === before),
          b = stamps.find((item) => item.phase === after);
        if (!a || !b) return null;
        if (domain(a) !== domain(b)) {
          invalid.add('CLOCK_DOMAIN_MISMATCH');
          return null;
        }
        if (b.observedAt < a.observedAt) {
          invalid.add('PHASE_ORDER_INVALID');
          return null;
        }
        return b.observedAt - a.observedAt;
      };
      const durations = {
        leaderToSubmitMs: elapsed('LEADER_DETECTED', 'SUBMIT_STARTED'),
        leaderToFillMs: elapsed('LEADER_DETECTED', 'FILL_DETECTED'),
        submitToFillMs: elapsed('SUBMIT_STARTED', 'FILL_DETECTED'),
        fillToProtectionMs: elapsed('FILL_DETECTED', 'PROTECTION_DETECTED'),
      };
      for (const [before, after] of edges) elapsed(before, after);
      return {
        environment: 'OFFLINE_FIXTURE' as const,
        evidence: 'SYNTHETIC' as const,
        eventId,
        accountId,
        attemptId,
        ...durations,
        invalidMeasurements: [...invalid].sort(),
        stamps,
      };
    });
  }
  eventSummary(eventId: string) {
    if (!digest.safeParse(eventId).success)
      return fail('INVALID_LATENCY_REFERENCE');
    return this.safe(() => {
      const references = this.db
        .prepare(
          'SELECT DISTINCT account_id,attempt_id FROM copier_latency_stamps WHERE event_id=? ORDER BY account_id,attempt_id',
        )
        .all(eventId);
      const attempts = references.map((row) =>
        this.attemptMetrics(
          eventId,
          String(row.account_id),
          String(row.attempt_id),
        ),
      );
      const groups = new Map<string, typeof attempts>();
      for (const attempt of attempts) {
        const relevant = attempt.stamps.filter(
          (item) =>
            item.phase === 'SUBMIT_STARTED' ||
            (item.phase === 'FILL_DETECTED' && attempt.leaderToFillMs !== null),
        );
        for (const key of new Set(relevant.map(domain)))
          groups.set(key, [...(groups.get(key) ?? []), attempt]);
      }
      const clockDomains = [...groups.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, members]) => {
          const ranked = members
            .filter(
              (item) =>
                item.leaderToFillMs !== null &&
                domain(
                  item.stamps.find((stamp) => stamp.phase === 'FILL_DETECTED')!,
                ) === key,
            )
            .sort(
              (a, b) =>
                a.leaderToFillMs! - b.leaderToFillMs! ||
                a.accountId.localeCompare(b.accountId) ||
                a.attemptId.localeCompare(b.attemptId),
            );
          const submits = members
            .map((item) =>
              item.stamps.find((stamp) => stamp.phase === 'SUBMIT_STARTED'),
            )
            .filter(
              (stamp): stamp is LatencyStamp =>
                !!stamp && domain(stamp) === key,
            );
          return {
            clockSource: JSON.parse(key)[0] as string,
            generation: JSON.parse(key)[1] as string,
            observedSubmitCount: submits.length,
            comparableFillCount: ranked.length,
            fastest: ranked.length
              ? {
                  accountId: ranked[0]!.accountId,
                  attemptId: ranked[0]!.attemptId,
                  leaderToFillMs: ranked[0]!.leaderToFillMs!,
                }
              : null,
            slowest: ranked.length
              ? {
                  accountId: ranked.at(-1)!.accountId,
                  attemptId: ranked.at(-1)!.attemptId,
                  leaderToFillMs: ranked.at(-1)!.leaderToFillMs!,
                }
              : null,
            submitSpreadMs: submits.length
              ? Math.max(...submits.map((item) => item.observedAt)) -
                Math.min(...submits.map((item) => item.observedAt))
              : null,
          };
        });
      return {
        environment: 'OFFLINE_FIXTURE' as const,
        evidence: 'SYNTHETIC' as const,
        eventId,
        attempts,
        clockDomains,
      };
    });
  }
}
