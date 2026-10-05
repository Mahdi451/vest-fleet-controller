import { fork } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import {
  leaderEventSchema,
  type AttemptObservation,
  type FollowerAttempt,
  type FollowerCommand,
  type FollowerOutcome,
  type LeaderEvent,
} from '../packages/execution/src/copier-events.ts';
import { Journal } from '../packages/execution/src/journal.ts';

const NOW = 1000,
  generation = randomUUID();
const stream = {
  environment: 'OFFLINE_FIXTURE' as const,
  evidence: 'SYNTHETIC' as const,
  leaderAccountId: '01',
  sourceId: 'synthetic-stream',
  symbol: 'NDX' as const,
  baselineSequence: 0,
};
function event(
  sequence = 1,
  overrides: Partial<LeaderEvent> = {},
): LeaderEvent {
  return leaderEventSchema.parse({
    environment: 'OFFLINE_FIXTURE',
    evidence: 'SYNTHETIC',
    origin: 'ACCEPTED_EVENT',
    leaderAccountId: '01',
    sourceId: stream.sourceId,
    providerEventId: `event-${sequence}`,
    entryRootId: `event-${sequence}`,
    symbol: 'NDX',
    sequence,
    occurredAt: NOW,
    kind: 'ENTRY',
    side: 'LONG',
    quantity: '2',
    leverage: '10',
    ...overrides,
  });
}
function fixture(path?: string) {
  const journal = new Journal(path);
  journal.copier.registerLeaderStream(stream);
  const first = journal.copier.recordLeaderEvent(event(), {
    generation,
    detectedAt: NOW,
  });
  const claim = (accountId = '02') =>
    journal.copier.claimFollowerAttempt(
      {
        eventId: first.eventId,
        followerAccountId: accountId,
        quantity: '1',
        leverage: '10',
      },
      generation,
      NOW,
    );
  return { journal, records: journal.copier, eventId: first.eventId, claim };
}
function withFixture(run: (f: ReturnType<typeof fixture>) => void) {
  const f = fixture();
  try {
    run(f);
  } finally {
    f.journal.close();
  }
}
function observation(
  attempt: FollowerAttempt,
  command: FollowerCommand,
  outcome: Partial<FollowerOutcome>,
  result: 'NOT_SENT' | 'REJECTED' | 'FILLED' | 'EXITED' | null = null,
  at = NOW,
): AttemptObservation {
  return {
    observationId: randomUUID(),
    observedAt: at,
    outcome: { ...attempt.outcome, ...outcome },
    terminal: result
      ? {
          evidence: 'SYNTHETIC',
          attemptId: attempt.attemptId,
          payloadHash: command.payloadHash,
          accountId: command.followerAccountId,
          result,
          providerOrderId: result === 'NOT_SENT' ? null : 'provider-order-02',
          noFutureExecution: true,
          remainingQuantity: '0',
          observedAt: at,
        }
      : null,
  };
}
function reject(f: ReturnType<typeof fixture>, started = true) {
  const claim = f.claim();
  const attempt = started
    ? f.records.markDispatchStarted(claim.attempt.attemptId, generation, NOW)
    : claim.attempt;
  const result = f.records.recordAttemptObservation(
    attempt.attemptId,
    attempt.revision,
    observation(
      attempt,
      claim.command,
      {
        submission: started ? 'REJECTED' : 'NOT_SENT',
        exposure: 'ABSENT',
        reason: started ? 'ENTRY_REJECTED' : 'DISPATCH_REFUSED',
      },
      started ? 'REJECTED' : 'NOT_SENT',
    ),
  );
  return { ...claim, attempt: result };
}

describe('durable synthetic leader events', () => {
  it('deduplicates economic values across observation generations without resetting ordering', () =>
    withFixture((f) => {
      const replay = f.records.recordLeaderEvent(
        event(1, { quantity: '2.00', leverage: '10.0' }),
        {
          generation: randomUUID(),
          detectedAt: NOW + 10,
        },
      );
      expect(replay).toMatchObject({
        fresh: false,
        eventId: f.eventId,
        contiguous: true,
      });
      expect(f.records.eventObservations(f.eventId)).toHaveLength(2);
      expect(f.records.leaderEvent(f.eventId)?.quantity).toBe('2');
    }));
  it.each(['quantity', 'kind', 'occurredAt', 'sequence'] as const)(
    'halts on conflicting event %s',
    (field) =>
      withFixture((f) => {
        const changed = {
          quantity: '3',
          kind: 'ADD',
          occurredAt: NOW - 1,
          sequence: 2,
        }[field];
        expect(() =>
          f.records.recordLeaderEvent(
            { ...event(), [field]: changed } as LeaderEvent,
            { generation, detectedAt: NOW },
          ),
        ).toThrow('COPIER_IDENTITY_CONFLICT');
        expect(f.records.globalStop()).toBe('EVENT_IDENTITY_CORRUPT');
        expect(f.records.leaderEvent(f.eventId)).toEqual(event());
      }),
  );
  it('rejects another event claiming the same source sequence', () =>
    withFixture((f) => {
      expect(() =>
        f.records.recordLeaderEvent(
          event(1, { providerEventId: 'different', entryRootId: 'different' }),
          { generation, detectedAt: NOW },
        ),
      ).toThrow('COPIER_IDENTITY_CONFLICT');
      expect(f.records.globalStop()).toBe('EVENT_IDENTITY_CORRUPT');
    }));
  it('requires registered stable stream ordering and rejects reset baselines', () =>
    withFixture((f) => {
      expect(() =>
        f.records.recordLeaderEvent(event(2, { sourceId: 'unknown-stream' }), {
          generation,
          detectedAt: NOW,
        }),
      ).toThrow('LEADER_STREAM_UNREGISTERED');
      expect(() =>
        f.records.registerLeaderStream({ ...stream, baselineSequence: 1 }),
      ).toThrow('COPIER_IDENTITY_CONFLICT');
    }));
  it('stores a sequence gap without admitting entries or manufacturing catch-up', () =>
    withFixture((f) => {
      const late = f.records.recordLeaderEvent(event(3), {
        generation,
        detectedAt: NOW,
      });
      expect(late.contiguous).toBe(false);
      expect(() =>
        f.records.claimFollowerAttempt(
          {
            eventId: late.eventId,
            followerAccountId: '02',
            quantity: '1',
            leverage: '10',
          },
          generation,
          NOW,
        ),
      ).toThrow('LEADER_SEQUENCE_GAP');
      const missing = f.records.recordLeaderEvent(event(2), {
        generation,
        detectedAt: NOW,
      });
      expect(missing.contiguous).toBe(true);
      expect(() =>
        f.records.claimFollowerAttempt(
          {
            eventId: missing.eventId,
            followerAccountId: '02',
            quantity: '1',
            leverage: '10',
          },
          generation,
          NOW,
        ),
      ).toThrow('STALE_LEADER_EVENT');
      expect(f.records.followerAttempts('nonexistent')).toEqual([]);
    }));
  it('keeps a close-before-entry tombstone after reordered delivery and SQLite reopen', () => {
    const directory = mkdtempSync(join(tmpdir(), 'copier-ordering-')),
      path = join(directory, 'journal.sqlite');
    let journal = new Journal(path);
    try {
      journal.copier.registerLeaderStream(stream);
      journal.copier.recordLeaderEvent(
        event(2, { kind: 'CLOSE', entryRootId: 'event-1' }),
        { generation, detectedAt: NOW },
      );
      const first = journal.copier.recordLeaderEvent(event(), {
        generation,
        detectedAt: NOW,
      });
      expect(() =>
        journal.copier.claimFollowerAttempt(
          {
            eventId: first.eventId,
            followerAccountId: '02',
            quantity: '1',
            leverage: '10',
          },
          generation,
          NOW,
        ),
      ).toThrow('STALE_LEADER_EVENT');
      journal.close();
      journal = new Journal(path);
      const addition = journal.copier.recordLeaderEvent(
        event(3, { kind: 'ADD', entryRootId: 'event-1' }),
        { generation, detectedAt: NOW },
      );
      expect(() =>
        journal.copier.claimFollowerAttempt(
          {
            eventId: addition.eventId,
            followerAccountId: '02',
            quantity: '1',
            leverage: '10',
          },
          randomUUID(),
          NOW,
        ),
      ).toThrow('FOLLOWER_EVENT_EXITED_OR_SKIPPED');
    } finally {
      journal.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
  it.each(['SNAPSHOT', 'LIVE'] as const)(
    'rejects %s input without echoing it',
    (kind) =>
      withFixture((f) => {
        const input =
          kind === 'SNAPSHOT'
            ? {
                ...event(2),
                origin: 'SNAPSHOT',
                authorization: 'private-canary',
              }
            : { ...event(2), environment: 'LIVE' };
        expect(() =>
          f.records.recordLeaderEvent(input as LeaderEvent, {
            generation,
            detectedAt: NOW,
          }),
        ).toThrow('INVALID_COPIER_RECORD');
        expect(f.records.globalStop()).toBeNull();
      }),
  );
});

describe('independent follower commands and attempts', () => {
  it('claims once, canonicalizes plans, preserves ownership and rejects changed economics', () =>
    withFixture((f) => {
      const first = f.claim();
      const replay = f.records.claimFollowerAttempt(
        {
          eventId: f.eventId,
          followerAccountId: '02',
          quantity: '1.00',
          leverage: '10.0',
        },
        randomUUID(),
        NOW + 1,
      );
      expect(first.fresh).toBe(true);
      expect(replay).toEqual({ ...first, fresh: false });
      expect(() =>
        f.records.claimFollowerAttempt(
          {
            eventId: f.eventId,
            followerAccountId: '02',
            quantity: '2',
            leverage: '10',
          },
          generation,
          NOW,
        ),
      ).toThrow('COPIER_IDENTITY_CONFLICT');
      expect(f.records.globalStop()).toBe('EVENT_IDENTITY_CORRUPT');
    }));
  it('blocks only the uncertain follower and never offers automatic replay permission', () =>
    withFixture((f) => {
      const first = f.claim('04');
      const started = f.records.markDispatchStarted(
        first.attempt.attemptId,
        generation,
        NOW,
      );
      f.records.recordAttemptObservation(
        started.attemptId,
        started.revision,
        observation(started, first.command, {
          submission: 'UNKNOWN',
          reason: 'ACKNOWLEDGEMENT_LOST',
        }),
      );
      expect(f.records.accountBlockers('04')).toHaveLength(1);
      expect(f.records.accountBlockers('05')).toEqual([]);
      expect(f.records.globalStop()).toBeNull();
      expect(f.claim('05').fresh).toBe(true);
      const next = f.records.recordLeaderEvent(event(2), {
        generation,
        detectedAt: NOW,
      });
      expect(() =>
        f.records.claimFollowerAttempt(
          {
            eventId: next.eventId,
            followerAccountId: '04',
            quantity: '1',
            leverage: '10',
          },
          generation,
          NOW,
        ),
      ).toThrow('FOLLOWER_REQUIRES_RECONCILIATION');
      expect(
        f.records.claimFollowerAttempt(
          {
            eventId: next.eventId,
            followerAccountId: '06',
            quantity: '1',
            leverage: '10',
          },
          generation,
          NOW,
        ).fresh,
      ).toBe(true);
      expect(() =>
        f.records.claimExplicitRetry(
          first.command.commandId,
          first.attempt.attemptId,
          generation,
          NOW,
        ),
      ).toThrow('EXPLICIT_RETRY_UNPROVEN');
      expect(f.journal.halted()).toBe(false);
    }));
  it('requires the claiming generation, writes submission uncertainty durably, and never marks dispatch twice', () =>
    withFixture((f) => {
      const claim = f.claim();
      expect(() =>
        f.records.markDispatchStarted(
          claim.attempt.attemptId,
          randomUUID(),
          NOW,
        ),
      ).toThrow('DISPATCH_CLAIM_REFUSED');
      const started = f.records.markDispatchStarted(
        claim.attempt.attemptId,
        generation,
        NOW,
      );
      expect(started.outcome.submission).toBe('SUBMITTING');
      expect(() =>
        f.records.markDispatchStarted(claim.attempt.attemptId, generation, NOW),
      ).toThrow('DISPATCH_CLAIM_REFUSED');
      expect(f.records.followerAttempt(started.attemptId)).toEqual(started);
    }));
  it('preserves claimed and submitting attempts across restart with no fresh permission', () => {
    const directory = mkdtempSync(join(tmpdir(), 'copier-restart-')),
      path = join(directory, 'journal.sqlite');
    const f = fixture(path);
    const claimed = f.claim('02'),
      other = f.claim('03');
    const started = f.records.markDispatchStarted(
      other.attempt.attemptId,
      generation,
      NOW,
    );
    f.journal.close();
    const reopened = new Journal(path);
    try {
      for (const record of [claimed, other]) {
        const replay = reopened.copier.claimFollowerAttempt(
          {
            eventId: f.eventId,
            followerAccountId: record.command.followerAccountId,
            quantity: '1',
            leverage: '10',
          },
          randomUUID(),
          NOW,
        );
        expect(replay.fresh).toBe(false);
        expect(
          reopened.copier.accountBlockers(record.command.followerAccountId),
        ).toHaveLength(1);
        expect(() =>
          reopened.copier.claimExplicitRetry(
            record.command.commandId,
            record.attempt.attemptId,
            randomUUID(),
            NOW,
          ),
        ).toThrow('EXPLICIT_RETRY_UNPROVEN');
      }
      expect(reopened.copier.followerAttempt(started.attemptId)).toEqual(
        started,
      );
      expect(reopened.copier.globalStop()).toBeNull();
    } finally {
      reopened.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
  it('independently records a filled account with a missing stop and a verified target', () =>
    withFixture((f) => {
      const claim = f.claim(),
        started = f.records.markDispatchStarted(
          claim.attempt.attemptId,
          generation,
          NOW,
        );
      const filled = f.records.recordAttemptObservation(
        started.attemptId,
        started.revision,
        observation(
          started,
          claim.command,
          {
            submission: 'ACCEPTED',
            fill: 'FILLED',
            filledQuantity: '1',
            fillPrice: '30400',
            exposure: 'PRESENT',
            stop: 'FAILED',
            target: 'VERIFIED',
            reason: 'SL_MISSING',
          },
          'FILLED',
        ),
      );
      expect(filled.outcome).toMatchObject({
        submission: 'ACCEPTED',
        stop: 'FAILED',
        target: 'VERIFIED',
        exposure: 'PRESENT',
      });
      expect(f.records.globalStop()).toBeNull();
      expect(f.claim('03').fresh).toBe(true);
    }));
  it.each([
    'AUTHENTICATION_LOST',
    'CHANNEL_INTEGRITY_LOST',
    'UNSAFE_FLEET_EXPOSURE',
  ] as const)('blocks all new dispatch claims after %s', (reason) =>
    withFixture((f) => {
      const claim = f.claim();
      f.records.haltGlobal(reason);
      expect(() =>
        f.records.markDispatchStarted(claim.attempt.attemptId, generation, NOW),
      ).toThrow('COPIER_GLOBAL_STOP');
      expect(() => f.claim('03')).toThrow('COPIER_GLOBAL_STOP');
      expect(
        f.records.followerAttempt(claim.attempt.attemptId)?.dispatchStartedAt,
      ).toBeNull();
    }),
  );
  it('rejects leader-as-follower, backwards time and unknown event roots', () =>
    withFixture((f) => {
      expect(() => f.claim('01')).toThrow('LEADER_CANNOT_BE_FOLLOWER');
      expect(() =>
        f.records.claimFollowerAttempt(
          {
            eventId: f.eventId,
            followerAccountId: '02',
            quantity: '1',
            leverage: '10',
          },
          generation,
          NOW - 1,
        ),
      ).toThrow('INVALID_COPIER_TIME');
      const next = f.records.recordLeaderEvent(
        event(2, { kind: 'ADD', entryRootId: 'unseen-entry' }),
        { generation, detectedAt: NOW },
      );
      expect(() =>
        f.records.claimFollowerAttempt(
          {
            eventId: next.eventId,
            followerAccountId: '02',
            quantity: '1',
            leverage: '10',
          },
          generation,
          NOW,
        ),
      ).toThrow('ENTRY_ROOT_UNPROVEN');
    }));
  it('does not treat a flat follower as eligible for an ADD', () =>
    withFixture((f) => {
      const next = f.records.recordLeaderEvent(
        event(2, { kind: 'ADD', entryRootId: 'event-1' }),
        { generation, detectedAt: NOW },
      );
      expect(() =>
        f.records.claimFollowerAttempt(
          {
            eventId: next.eventId,
            followerAccountId: '02',
            quantity: '1',
            leverage: '10',
          },
          generation,
          NOW,
        ),
      ).toThrow('FOLLOWER_ADD_REQUIRES_OWNED_EXPOSURE');
    }));
  it('claims atomically from two competing processes', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'copier-compete-')),
      path = join(directory, 'journal.sqlite');
    const f = fixture(path);
    f.journal.close();
    const children = [0, 1].map(() =>
      fork(
        fileURLToPath(
          new URL('./fixtures/copier-claim-worker.ts', import.meta.url),
        ),
        [path, f.eventId, randomUUID(), String(NOW)],
        {
          execArgv: ['--import', 'tsx'],
          stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
        },
      ),
    );
    try {
      await Promise.all(
        children.map(
          (child) =>
            new Promise<void>((resolve, reject) => {
              child.once('message', (message) =>
                message === 'READY'
                  ? resolve()
                  : reject(new Error('WORKER_NOT_READY')),
              );
              child.once('error', () => reject(new Error('WORKER_FAILED')));
              child.once('exit', (code) => {
                if (code !== 0) reject(new Error('WORKER_FAILED'));
              });
            }),
        ),
      );
      const results = await Promise.all(
        children.map(
          (child) =>
            new Promise<{ fresh: boolean; attemptId: string }>(
              (resolve, reject) => {
                child.once('message', (message) =>
                  typeof message === 'object' &&
                  message !== null &&
                  'fresh' in message &&
                  'attemptId' in message
                    ? resolve(message as { fresh: boolean; attemptId: string })
                    : reject(new Error('WORKER_FAILED')),
                );
                child.send('CLAIM');
              },
            ),
        ),
      );
      expect(results.filter((result) => result.fresh)).toHaveLength(1);
      expect(new Set(results.map((result) => result.attemptId)).size).toBe(1);
      const check = new Journal(path);
      try {
        expect(
          check.copier.followerAttempts(
            check.copier.followerAttempt(results[0]!.attemptId)!.commandId,
          ),
        ).toHaveLength(1);
      } finally {
        check.close();
      }
    } finally {
      for (const child of children) child.kill();
      rmSync(directory, { recursive: true, force: true });
    }
  }, 10_000);
});

describe('explicit retries and append-only outcome evidence', () => {
  it('accumulates partial fills, freezes terminal quantity and requires terminal exit evidence to clear exposure', () =>
    withFixture((f) => {
      const claim = f.claim(),
        started = f.records.markDispatchStarted(
          claim.attempt.attemptId,
          generation,
          NOW,
        );
      const partial = f.records.recordAttemptObservation(
        started.attemptId,
        started.revision,
        observation(started, claim.command, {
          submission: 'ACCEPTED',
          fill: 'PARTIAL',
          filledQuantity: '0.5',
          fillPrice: '30400',
          exposure: 'PRESENT',
        }),
      );
      const filled = f.records.recordAttemptObservation(
        partial.attemptId,
        partial.revision,
        observation(
          partial,
          claim.command,
          {
            fill: 'FILLED',
            filledQuantity: '1',
            fillPrice: '30401',
            stop: 'VERIFIED',
            target: 'VERIFIED',
          },
          'FILLED',
          NOW + 1,
        ),
      );
      expect(() =>
        f.records.recordAttemptObservation(
          filled.attemptId,
          filled.revision,
          observation(
            filled,
            claim.command,
            {
              fill: 'PARTIAL',
              filledQuantity: '0.5',
              stop: 'MISSING',
              target: 'MISSING',
            },
            'FILLED',
            NOW + 2,
          ),
        ),
      ).toThrow('FOLLOWER_OBSERVATION_REFUSED');
      expect(() =>
        f.records.recordAttemptObservation(
          filled.attemptId,
          filled.revision,
          observation(
            filled,
            claim.command,
            {
              exposure: 'ABSENT',
              stop: 'NOT_REQUIRED',
              target: 'NOT_REQUIRED',
            },
            'FILLED',
            NOW + 2,
          ),
        ),
      ).toThrow('FOLLOWER_OBSERVATION_REFUSED');
      const exited = f.records.recordAttemptObservation(
        filled.attemptId,
        filled.revision,
        observation(
          filled,
          claim.command,
          {
            exposure: 'ABSENT',
            stop: 'NOT_REQUIRED',
            target: 'NOT_REQUIRED',
            reason: 'EXIT_VERIFIED',
          },
          'EXITED',
          NOW + 2,
        ),
      );
      expect(exited.outcome.filledQuantity).toBe('1');
      expect(f.records.accountBlockers('02')).toEqual([]);
      expect(f.records.attemptObservations(exited.attemptId)).toHaveLength(3);
      expect(() =>
        f.records.claimExplicitRetry(
          claim.command.commandId,
          exited.attemptId,
          generation,
          NOW + 3,
        ),
      ).toThrow('EXPLICIT_RETRY_UNPROVEN');
    }));
  it('refreshes rejection/exposure evidence without erasing the original proof or allowing early retry', () =>
    withFixture((f) => {
      const claim = f.claim(),
        started = f.records.markDispatchStarted(
          claim.attempt.attemptId,
          generation,
          NOW,
        );
      const rejected = f.records.recordAttemptObservation(
        started.attemptId,
        started.revision,
        observation(
          started,
          claim.command,
          {
            submission: 'REJECTED',
            exposure: 'UNKNOWN',
            reason: 'ENTRY_REJECTED',
          },
          'REJECTED',
        ),
      );
      expect(() =>
        f.records.claimExplicitRetry(
          claim.command.commandId,
          rejected.attemptId,
          generation,
          NOW + 1,
        ),
      ).toThrow('EXPLICIT_RETRY_UNPROVEN');
      const resolved = f.records.recordAttemptObservation(
        rejected.attemptId,
        rejected.revision,
        observation(
          rejected,
          claim.command,
          {
            exposure: 'ABSENT',
          },
          'REJECTED',
          NOW + 1,
        ),
      );
      expect(f.records.attemptObservations(resolved.attemptId)).toHaveLength(2);
      expect(
        f.records.claimExplicitRetry(
          claim.command.commandId,
          resolved.attemptId,
          generation,
          NOW + 2,
        ).fresh,
      ).toBe(true);
    }));
  it('does not accept observed partial fill as retryable even when its remainder is terminal', () =>
    withFixture((f) => {
      const claim = f.claim(),
        started = f.records.markDispatchStarted(
          claim.attempt.attemptId,
          generation,
          NOW,
        );
      const partial = f.records.recordAttemptObservation(
        started.attemptId,
        started.revision,
        observation(
          started,
          claim.command,
          {
            submission: 'ACCEPTED',
            fill: 'PARTIAL',
            filledQuantity: '0.5',
            fillPrice: '30400',
            exposure: 'PRESENT',
          },
          'FILLED',
        ),
      );
      expect(() =>
        f.records.claimExplicitRetry(
          claim.command.commandId,
          partial.attemptId,
          generation,
          NOW + 1,
        ),
      ).toThrow('EXPLICIT_RETRY_UNPROVEN');
      expect(() =>
        f.records.recordAttemptObservation(
          partial.attemptId,
          partial.revision,
          observation(
            partial,
            claim.command,
            {
              fill: 'FILLED',
              filledQuantity: '1',
            },
            'FILLED',
            NOW + 1,
          ),
        ),
      ).toThrow('FOLLOWER_OBSERVATION_REFUSED');
    }));
  it('refuses stale/contradictory observations and refuses changing a replayed observation', () =>
    withFixture((f) => {
      const claim = f.claim(),
        started = f.records.markDispatchStarted(
          claim.attempt.attemptId,
          generation,
          NOW,
        );
      const obs = observation(
        started,
        claim.command,
        { submission: 'UNKNOWN', reason: 'ACKNOWLEDGEMENT_LOST' },
        null,
        NOW + 1,
      );
      const first = f.records.recordAttemptObservation(
        started.attemptId,
        started.revision,
        obs,
      );
      expect(() =>
        f.records.recordAttemptObservation(
          first.attemptId,
          first.revision,
          observation(
            first,
            claim.command,
            { submission: 'UNKNOWN' },
            null,
            NOW,
          ),
        ),
      ).toThrow('FOLLOWER_OBSERVATION_REFUSED');
      expect(() =>
        f.records.recordAttemptObservation(first.attemptId, first.revision, {
          ...obs,
          outcome: { ...obs.outcome, reason: 'SL_MISSING' },
        }),
      ).toThrow('COPIER_IDENTITY_CONFLICT');
      expect(f.records.globalStop()).toBe('EVENT_IDENTITY_CORRUPT');
      expect(f.records.attemptObservations(first.attemptId)).toEqual([obs]);
    }));
  it.each([true, false])(
    'creates one linked explicit retry after proven rejection/not-sent (sent=%s)',
    (started) =>
      withFixture((f) => {
        const first = reject(f, started);
        const next = f.records.claimExplicitRetry(
          first.command.commandId,
          first.attempt.attemptId,
          randomUUID(),
          NOW + 1,
        );
        expect(next.fresh).toBe(true);
        expect(next.attempt).toMatchObject({
          number: 2,
          previousAttemptId: first.attempt.attemptId,
        });
        expect(next.attempt.attemptId).not.toBe(first.attempt.attemptId);
        expect(
          f.records.claimExplicitRetry(
            first.command.commandId,
            first.attempt.attemptId,
            generation,
            NOW + 2,
          ).fresh,
        ).toBe(false);
        expect(f.records.followerAttempt(first.attempt.attemptId)).toEqual(
          first.attempt,
        );
        expect(
          f.records.attemptObservations(first.attempt.attemptId),
        ).toHaveLength(1);
      }),
  );
  it('does not convert an UNKNOWN/flat-looking observation into retry evidence', () =>
    withFixture((f) => {
      const claim = f.claim(),
        started = f.records.markDispatchStarted(
          claim.attempt.attemptId,
          generation,
          NOW,
        );
      const unknown = f.records.recordAttemptObservation(
        started.attemptId,
        started.revision,
        observation(started, claim.command, {
          submission: 'UNKNOWN',
          exposure: 'ABSENT',
          reason: 'ACKNOWLEDGEMENT_LOST',
        }),
      );
      expect(() =>
        f.records.claimExplicitRetry(
          claim.command.commandId,
          unknown.attemptId,
          generation,
          NOW,
        ),
      ).toThrow('EXPLICIT_RETRY_UNPROVEN');
      expect(f.records.accountBlockers('02')).toHaveLength(1);
    }));
  it('reconciles UNKNOWN to terminal rejection before permitting explicit retry', () =>
    withFixture((f) => {
      const claim = f.claim(),
        started = f.records.markDispatchStarted(
          claim.attempt.attemptId,
          generation,
          NOW,
        );
      const unknown = f.records.recordAttemptObservation(
        started.attemptId,
        started.revision,
        observation(started, claim.command, {
          submission: 'UNKNOWN',
          exposure: 'UNKNOWN',
          reason: 'ACKNOWLEDGEMENT_LOST',
        }),
      );
      const rejected = f.records.recordAttemptObservation(
        unknown.attemptId,
        unknown.revision,
        observation(
          unknown,
          claim.command,
          {
            submission: 'REJECTED',
            exposure: 'ABSENT',
            reason: 'ENTRY_REJECTED',
          },
          'REJECTED',
          NOW + 1,
        ),
      );
      expect(
        f.records.claimExplicitRetry(
          claim.command.commandId,
          rejected.attemptId,
          generation,
          NOW + 2,
        ).fresh,
      ).toBe(true);
      expect(f.records.attemptObservations(rejected.attemptId)).toHaveLength(2);
    }));
  it.each(['account', 'payload', 'attempt', 'remainder'] as const)(
    'refuses mismatched terminal %s evidence',
    (field) =>
      withFixture((f) => {
        const claim = f.claim(),
          started = f.records.markDispatchStarted(
            claim.attempt.attemptId,
            generation,
            NOW,
          );
        let obs = observation(
          started,
          claim.command,
          { submission: 'REJECTED', exposure: 'ABSENT' },
          'REJECTED',
        );
        if (field === 'account') obs.terminal!.accountId = '03';
        if (field === 'payload') obs.terminal!.payloadHash = 'a'.repeat(64);
        if (field === 'attempt') obs.terminal!.attemptId = 'a'.repeat(64);
        if (field === 'remainder')
          obs = {
            ...obs,
            terminal: { ...obs.terminal!, remainingQuantity: '1' },
          } as unknown as AttemptObservation;
        expect(() =>
          f.records.recordAttemptObservation(
            started.attemptId,
            started.revision,
            obs,
          ),
        ).toThrow(
          field === 'remainder'
            ? 'INVALID_COPIER_RECORD'
            : 'TERMINAL_EVIDENCE_REFUSED',
        );
        expect(f.records.followerAttempt(started.attemptId)).toEqual(started);
      }),
  );
  it('refuses rejection without terminal proof and refuses claiming NOT_SENT after dispatch', () =>
    withFixture((f) => {
      const claim = f.claim(),
        started = f.records.markDispatchStarted(
          claim.attempt.attemptId,
          generation,
          NOW,
        );
      expect(() =>
        f.records.recordAttemptObservation(
          started.attemptId,
          started.revision,
          observation(started, claim.command, {
            submission: 'REJECTED',
            exposure: 'ABSENT',
          }),
        ),
      ).toThrow('TERMINAL_EVIDENCE_REQUIRED');
      expect(() =>
        f.records.recordAttemptObservation(
          started.attemptId,
          started.revision,
          observation(
            started,
            claim.command,
            { submission: 'NOT_SENT', exposure: 'ABSENT' },
            'NOT_SENT',
          ),
        ),
      ).toThrow('FOLLOWER_OBSERVATION_REFUSED');
    }));
  it('preserves evidence on replay and uses revisions to reject competing outcome updates', () =>
    withFixture((f) => {
      const claim = f.claim(),
        started = f.records.markDispatchStarted(
          claim.attempt.attemptId,
          generation,
          NOW,
        );
      const obs = observation(started, claim.command, {
        submission: 'UNKNOWN',
        reason: 'ACKNOWLEDGEMENT_LOST',
      });
      const first = f.records.recordAttemptObservation(
        started.attemptId,
        started.revision,
        obs,
      );
      expect(
        f.records.recordAttemptObservation(
          started.attemptId,
          started.revision,
          obs,
        ),
      ).toEqual(first);
      expect(() =>
        f.records.recordAttemptObservation(
          started.attemptId,
          started.revision,
          { ...obs, observationId: randomUUID() },
        ),
      ).toThrow('FOLLOWER_OBSERVATION_CONFLICT');
      expect(f.records.attemptObservations(started.attemptId)).toHaveLength(1);
    }));
  it('does not erase observed exposure with rejection', () =>
    withFixture((f) => {
      const claim = f.claim(),
        started = f.records.markDispatchStarted(
          claim.attempt.attemptId,
          generation,
          NOW,
        );
      const rejected = f.records.recordAttemptObservation(
        started.attemptId,
        started.revision,
        observation(
          started,
          claim.command,
          {
            submission: 'REJECTED',
            exposure: 'PRESENT',
            reason: 'ENTRY_REJECTED',
          },
          'REJECTED',
        ),
      );
      expect(rejected.outcome.exposure).toBe('PRESENT');
      expect(() =>
        f.records.claimExplicitRetry(
          claim.command.commandId,
          rejected.attemptId,
          generation,
          NOW,
        ),
      ).toThrow('EXPLICIT_RETRY_UNPROVEN');
    }));
});

describe('durable no-reopen dispositions', () => {
  it('rechecks an exit/skip between claim and dispatch', () =>
    withFixture((f) => {
      const claim = f.claim();
      f.records.recordFollowerDisposition({
        eventId: f.eventId,
        followerAccountId: '02',
        reason: 'SKIPPED',
        observedAt: NOW,
      });
      expect(() =>
        f.records.markDispatchStarted(claim.attempt.attemptId, generation, NOW),
      ).toThrow('FOLLOWER_EVENT_EXITED_OR_SKIPPED');
      expect(
        f.records.followerAttempt(claim.attempt.attemptId)?.dispatchStartedAt,
      ).toBeNull();
    }));
  it.each([
    'STOP_OUT',
    'MANUAL_CLOSE',
    'LIQUIDATED',
    'BREACHED',
    'OPERATOR_FLATTEN',
    'SKIPPED',
  ] as const)(
    'blocks replay/retry/add for %s but permits a genuine new entry cycle',
    (reason) =>
      withFixture((f) => {
        const old = reject(f);
        f.records.recordFollowerDisposition({
          eventId: f.eventId,
          followerAccountId: '02',
          reason,
          observedAt: NOW,
        });
        expect(f.claim().fresh).toBe(false);
        expect(() =>
          f.records.claimExplicitRetry(
            old.command.commandId,
            old.attempt.attemptId,
            generation,
            NOW,
          ),
        ).toThrow('FOLLOWER_EVENT_EXITED_OR_SKIPPED');
        const addition = f.records.recordLeaderEvent(
          event(2, { kind: 'ADD', entryRootId: 'event-1' }),
          { generation, detectedAt: NOW },
        );
        expect(() =>
          f.records.claimFollowerAttempt(
            {
              eventId: addition.eventId,
              followerAccountId: '02',
              quantity: '1',
              leverage: '10',
            },
            generation,
            NOW,
          ),
        ).toThrow('FOLLOWER_EVENT_EXITED_OR_SKIPPED');
        const fresh = f.records.recordLeaderEvent(event(3), {
          generation,
          detectedAt: NOW,
        });
        expect(
          f.records.claimFollowerAttempt(
            {
              eventId: fresh.eventId,
              followerAccountId: '02',
              quantity: '1',
              leverage: '10',
            },
            generation,
            NOW,
          ).fresh,
        ).toBe(true);
      }),
  );
  it('persists skip before any command claim and preserves the first disposition', () => {
    const directory = mkdtempSync(join(tmpdir(), 'copier-skip-')),
      path = join(directory, 'journal.sqlite');
    const f = fixture(path);
    const original = f.records.recordFollowerDisposition({
      eventId: f.eventId,
      followerAccountId: '02',
      reason: 'SKIPPED',
      observedAt: NOW,
    });
    f.journal.close();
    const reopened = new Journal(path);
    try {
      expect(
        reopened.copier.recordFollowerDisposition({
          ...original,
          reason: 'MANUAL_CLOSE',
          observedAt: NOW + 1,
        }),
      ).toEqual(original);
      expect(() =>
        reopened.copier.claimFollowerAttempt(
          {
            eventId: f.eventId,
            followerAccountId: '02',
            quantity: '1',
            leverage: '10',
          },
          generation,
          NOW,
        ),
      ).toThrow('FOLLOWER_EVENT_EXITED_OR_SKIPPED');
      expect(
        reopened.copier.claimFollowerAttempt(
          {
            eventId: f.eventId,
            followerAccountId: '03',
            quantity: '1',
            leverage: '10',
          },
          generation,
          NOW,
        ).fresh,
      ).toBe(true);
    } finally {
      reopened.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
  it('preserves legacy journal rows byte-for-byte while adding copier tables', () => {
    const directory = mkdtempSync(join(tmpdir(), 'copier-history-')),
      path = join(directory, 'journal.sqlite');
    const old = new Journal(path);
    old.close();
    const db = new DatabaseSync(path),
      raw =
        '{"adapter":"old","status":"HISTORICAL","timestamp":1,"masterTradeId":"old"}';
    db.prepare('INSERT INTO audit(event) VALUES(?)').run(raw);
    db.close();
    const f = fixture(path);
    f.claim();
    f.journal.close();
    const check = new DatabaseSync(path);
    try {
      expect(
        check.prepare('SELECT event FROM audit WHERE id=1').get()?.event,
      ).toBe(raw);
    } finally {
      check.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe('reviewed record integrity boundaries', () => {
  it('freezes an old attempt after retry, but permits exact observation replay', () =>
    withFixture((f) => {
      const old = reject(f);
      const original = f.records.attemptObservations(old.attempt.attemptId)[0]!;
      f.records.claimExplicitRetry(
        old.command.commandId,
        old.attempt.attemptId,
        generation,
        NOW,
      );
      expect(
        f.records.recordAttemptObservation(old.attempt.attemptId, 0, original),
      ).toEqual(old.attempt);
      expect(() =>
        f.records.recordAttemptObservation(
          old.attempt.attemptId,
          old.attempt.revision,
          observation(
            old.attempt,
            old.command,
            { exposure: 'UNKNOWN' },
            'REJECTED',
          ),
        ),
      ).toThrow('HISTORICAL_ATTEMPT_IMMUTABLE');
      expect(f.records.attemptObservations(old.attempt.attemptId)).toHaveLength(
        1,
      );
    }));
  it('requires exit proof even on the first filled observation with absent exposure', () =>
    withFixture((f) => {
      const claim = f.claim();
      const started = f.records.markDispatchStarted(
        claim.attempt.attemptId,
        generation,
        NOW,
      );
      const out = {
        submission: 'ACCEPTED',
        fill: 'FILLED',
        filledQuantity: '1',
        fillPrice: '20000',
        exposure: 'ABSENT',
        stop: 'NOT_REQUIRED',
        target: 'NOT_REQUIRED',
      } as const;
      expect(() =>
        f.records.recordAttemptObservation(
          started.attemptId,
          started.revision,
          observation(started, claim.command, out, 'FILLED'),
        ),
      ).toThrow('FOLLOWER_OBSERVATION_REFUSED');
      const exited = f.records.recordAttemptObservation(
        started.attemptId,
        started.revision,
        observation(started, claim.command, out, 'EXITED'),
      );
      expect(exited.outcome.exposure).toBe('ABSENT');
      expect(f.records.accountBlockers('02')).toHaveLength(0);
    }));
  it.each(['REDUCE', 'CLOSE', 'STOP_CHANGED', 'TARGET_CHANGED'] as const)(
    'refuses %s without same-root follower ownership',
    (kind) =>
      withFixture((f) => {
        const next = f.records.recordLeaderEvent(
          event(2, {
            kind,
            entryRootId: 'event-1',
            ...(['STOP_CHANGED', 'TARGET_CHANGED'].includes(kind)
              ? { price: '19000' }
              : {}),
          }),
          { generation, detectedAt: NOW },
        );
        expect(() =>
          f.records.claimFollowerAttempt(
            {
              eventId: next.eventId,
              followerAccountId: '02',
              quantity: '1',
              leverage: '10',
            },
            generation,
            NOW,
          ),
        ).toThrow('FOLLOWER_MUTATION_REQUIRES_OWNED_EXPOSURE');
      }),
  );
  it.each([
    'malformed',
    'terminal-account',
    'terminal-payload',
    'terminal-attempt',
  ])(
    'sanitizes %s corruption on a public read and stops globally',
    (corruption) => {
      const directory = mkdtempSync(join(tmpdir(), 'copier-corruption-'));
      const path = join(directory, 'journal.sqlite');
      const f = fixture(path);
      const old = reject(f);
      const db = new DatabaseSync(path);
      try {
        const tampered = structuredClone(old.attempt);
        if (corruption === 'terminal-account')
          tampered.terminal!.accountId = '09';
        if (corruption === 'terminal-payload')
          tampered.terminal!.payloadHash = '0'.repeat(64);
        if (corruption === 'terminal-attempt')
          tampered.terminal!.attemptId = 'wrong-attempt';
        db.prepare('UPDATE copier_attempts SET attempt=? WHERE id=?').run(
          corruption === 'malformed'
            ? '{secret-marker'
            : JSON.stringify(tampered),
          old.attempt.attemptId,
        );
        expect(() => f.records.followerAttempt(old.attempt.attemptId)).toThrow(
          'COPIER_STORAGE_CORRUPT',
        );
        expect(f.records.globalStop()).toBe('JOURNAL_INTEGRITY_LOST');
      } finally {
        db.close();
        f.journal.close();
        rmSync(directory, { recursive: true, force: true });
      }
    },
  );
  it('sanitizes a closed storage read failure', () => {
    const f = fixture();
    f.journal.close();
    expect(() => f.records.followerAttempt('missing')).toThrow(
      'COPIER_STORAGE_FAILED',
    );
  });
});

describe('uncertain exposure ownership', () => {
  it.each(['ADD', 'CLOSE', 'STOP_CHANGED'] as const)(
    'does not authorize %s from a rejected attempt with present exposure',
    (kind) =>
      withFixture((f) => {
        const claim = f.claim();
        const started = f.records.markDispatchStarted(
          claim.attempt.attemptId,
          generation,
          NOW,
        );
        f.records.recordAttemptObservation(
          started.attemptId,
          started.revision,
          observation(
            started,
            claim.command,
            { submission: 'REJECTED', exposure: 'PRESENT' },
            'REJECTED',
          ),
        );
        const next = f.records.recordLeaderEvent(
          event(2, {
            kind,
            entryRootId: 'event-1',
            ...(kind === 'STOP_CHANGED' ? { price: '19000' } : {}),
          }),
          { generation, detectedAt: NOW },
        );
        expect(() =>
          f.records.claimFollowerAttempt(
            {
              eventId: next.eventId,
              followerAccountId: '02',
              quantity: '1',
              leverage: '10',
            },
            generation,
            NOW,
          ),
        ).toThrow('FOLLOWER_REQUIRES_RECONCILIATION');
        expect(f.records.globalStop()).toBeNull();
      }),
  );
});

describe('explicit copier schema activation', () => {
  it('keeps legacy inventory unchanged until copier records are requested', () => {
    const directory = mkdtempSync(join(tmpdir(), 'copier-schema-'));
    const path = join(directory, 'journal.sqlite');
    const journal = new Journal(path);
    const db = new DatabaseSync(path);
    try {
      const tables = () =>
        db
          .prepare(
            "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'copier_%'",
          )
          .all();
      expect(tables()).toHaveLength(0);
      const records = journal.copier;
      expect(journal.copier).toBe(records);
      expect(tables()).toHaveLength(8);
    } finally {
      db.close();
      journal.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
