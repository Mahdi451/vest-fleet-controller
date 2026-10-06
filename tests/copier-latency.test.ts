import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import {
  CopierLatencyStore,
  type LatencyStamp,
} from '../packages/execution/src/copier-latency.ts';

const eventId = 'a'.repeat(64),
  attemptId = 'b'.repeat(64),
  generation = randomUUID();
const stamp = (
  phase: LatencyStamp['phase'],
  observedAt: number,
  extra: Partial<LatencyStamp> = {},
): LatencyStamp => ({
  environment: 'OFFLINE_FIXTURE',
  evidence: 'SYNTHETIC',
  eventId,
  accountId: '02',
  attemptId,
  phase,
  observedAt,
  clockSource: 'fixture-monotonic',
  generation,
  ...extra,
});
function fixture(run: (store: CopierLatencyStore, db: DatabaseSync) => void) {
  const db = new DatabaseSync(':memory:');
  try {
    run(new CopierLatencyStore(db), db);
  } finally {
    db.close();
  }
}
describe('observed synthetic copier latency', () => {
  it('refuses invalid references with fixed errors', () =>
    fixture((store) => {
      expect(() => store.eventSummary('raw secret')).toThrow(
        'INVALID_LATENCY_REFERENCE',
      );
      expect(() =>
        store.attemptMetrics(eventId, 'invalid account', attemptId),
      ).toThrow('INVALID_LATENCY_REFERENCE');
    }));
  it('calculates observed durations without estimating missing facts', () =>
    fixture((store) => {
      expect(
        store.attemptMetrics(eventId, '02', attemptId).leaderToFillMs,
      ).toBeNull();
      store.recordStamp(stamp('LEADER_DETECTED', 100));
      store.recordStamp(stamp('SUBMIT_STARTED', 110));
      store.recordStamp(stamp('ACKNOWLEDGED', 112));
      store.recordStamp(stamp('FILL_DETECTED', 120));
      expect(store.attemptMetrics(eventId, '02', attemptId)).toMatchObject({
        leaderToSubmitMs: 10,
        leaderToFillMs: 20,
        submitToFillMs: 10,
        fillToProtectionMs: null,
        invalidMeasurements: [],
        evidence: 'SYNTHETIC',
      });
      store.recordStamp(stamp('PROTECTION_DETECTED', 130));
      expect(
        store.attemptMetrics(eventId, '02', attemptId).fillToProtectionMs,
      ).toBe(10);
    }));
  it('distinguishes an observed zero duration from missing', () =>
    fixture((store) => {
      store.recordStamp(stamp('LEADER_DETECTED', 10));
      store.recordStamp(stamp('SUBMIT_STARTED', 10));
      expect(
        store.attemptMetrics(eventId, '02', attemptId).leaderToSubmitMs,
      ).toBe(0);
      expect(
        store.attemptMetrics(eventId, '02', attemptId).submitToFillMs,
      ).toBeNull();
    }));
  it('permits exact replay and refuses changed facts', () =>
    fixture((store) => {
      const value = stamp('LEADER_DETECTED', 100);
      store.recordStamp(value);
      expect(store.recordStamp(value)).toEqual(value);
      expect(() => store.recordStamp({ ...value, observedAt: 101 })).toThrow(
        'LATENCY_STAMP_CONFLICT',
      );
      expect(
        store.attemptMetrics(eventId, '02', attemptId).stamps,
      ).toHaveLength(1);
    }));
  it('persists stamps and replay across SQLite reopen', () => {
    const directory = mkdtempSync(join(tmpdir(), 'latency-'));
    const path = join(directory, 'records.sqlite');
    try {
      let db = new DatabaseSync(path);
      const value = stamp('LEADER_DETECTED', 100);
      new CopierLatencyStore(db).recordStamp(value);
      db.close();
      db = new DatabaseSync(path);
      try {
        const store = new CopierLatencyStore(db);
        expect(store.recordStamp(value)).toEqual(value);
        expect(
          store.attemptMetrics(eventId, '02', attemptId).stamps,
        ).toHaveLength(1);
      } finally {
        db.close();
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
  it.each(['clockSource', 'generation'] as const)(
    'does not subtract across %s',
    (field) =>
      fixture((store) => {
        store.recordStamp(stamp('LEADER_DETECTED', 100));
        store.recordStamp(
          stamp(
            'SUBMIT_STARTED',
            50,
            field === 'generation'
              ? { generation: randomUUID() }
              : { clockSource: 'other-clock' },
          ),
        );
        expect(store.attemptMetrics(eventId, '02', attemptId)).toMatchObject({
          leaderToSubmitMs: null,
          invalidMeasurements: ['CLOCK_DOMAIN_MISMATCH'],
        });
      }),
  );
  it('rejects rollback without writing the invalid measurement', () =>
    fixture((store) => {
      store.recordStamp(stamp('LEADER_DETECTED', 100));
      expect(() => store.recordStamp(stamp('SUBMIT_STARTED', 99))).toThrow(
        'LATENCY_CLOCK_ROLLBACK',
      );
      expect(
        store.attemptMetrics(eventId, '02', attemptId).leaderToSubmitMs,
      ).toBeNull();
    }));
  it('rejects inconsistent causal order even when insertion time rises', () =>
    fixture((store) => {
      store.recordStamp(stamp('FILL_DETECTED', 100));
      expect(() => store.recordStamp(stamp('SUBMIT_STARTED', 110))).toThrow(
        'LATENCY_PHASE_ORDER_INVALID',
      );
    }));
  it('ranks valid fills with deterministic ties and includes unfilled submits in spread', () =>
    fixture((store) => {
      for (const [accountId, attemptId, submit, fill] of [
        ['03', 'c'.repeat(64), 115, 120],
        ['02', 'b'.repeat(64), 110, 120],
        ['04', 'd'.repeat(64), 150, null],
      ] as const) {
        const extra = { accountId, attemptId };
        store.recordStamp(stamp('LEADER_DETECTED', 100, extra));
        store.recordStamp(stamp('SUBMIT_STARTED', submit, extra));
        if (fill !== null)
          store.recordStamp(stamp('FILL_DETECTED', fill, extra));
      }
      const summary = store.eventSummary(eventId);
      expect(summary.clockDomains).toHaveLength(1);
      expect(summary.clockDomains[0]).toMatchObject({
        fastest: { accountId: '02', leaderToFillMs: 20 },
        slowest: { accountId: '03', leaderToFillMs: 20 },
        submitSpreadMs: 40,
      });
    }));
  it('never ranks or combines submissions from different clock domains', () =>
    fixture((store) => {
      for (const [accountId, gen] of [
        ['02', generation],
        ['03', randomUUID()],
      ] as const) {
        store.recordStamp(
          stamp('LEADER_DETECTED', 100, { accountId, generation: gen }),
        );
        store.recordStamp(
          stamp('SUBMIT_STARTED', 110, { accountId, generation: gen }),
        );
        store.recordStamp(
          stamp('FILL_DETECTED', 120, { accountId, generation: gen }),
        );
      }
      expect(store.eventSummary(eventId).clockDomains).toHaveLength(2);
      expect(
        store
          .eventSummary(eventId)
          .clockDomains.map((item) => item.submitSpreadMs),
      ).toEqual([0, 0]);
    }));
  it('represents no observations without invented followers', () =>
    fixture((store) => {
      expect(store.eventSummary(eventId).clockDomains).toEqual([]);
    }));
  it('rejects live provenance and raw fields with fixed errors', () =>
    fixture((store) => {
      expect(() =>
        store.recordStamp({
          ...stamp('LEADER_DETECTED', 1),
          environment: 'LIVE',
        } as unknown as LatencyStamp),
      ).toThrow('INVALID_LATENCY_STAMP');
      expect(() =>
        store.recordStamp({
          ...stamp('LEADER_DETECTED', 1),
          secret: 'private',
        } as LatencyStamp),
      ).toThrow('INVALID_LATENCY_STAMP');
    }));
  it('detects stored identity corruption and sanitizes storage failures', () =>
    fixture((store, db) => {
      const value = stamp('LEADER_DETECTED', 1);
      store.recordStamp(value);
      db.prepare('UPDATE copier_latency_stamps SET stamp=?').run(
        JSON.stringify({ ...value, accountId: '03' }),
      );
      expect(() => store.attemptMetrics(eventId, '02', attemptId)).toThrow(
        'LATENCY_STORAGE_CORRUPT',
      );
      db.exec('DROP TABLE copier_latency_stamps');
      expect(() => store.eventSummary(eventId)).toThrow(
        'LATENCY_STORAGE_FAILED',
      );
    }));
});
