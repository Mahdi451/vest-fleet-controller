import { fork } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { Journal } from '../packages/execution/src/journal.ts';
import { leaderEventSchema } from '../packages/execution/src/copier-events.ts';
import { initialFleet } from '../packages/core/src/index.ts';
import { NOW } from './helpers.ts';
function fixture(path?: string) {
  const journal = new Journal(path),
    records = journal.copier,
    generation = randomUUID();
  const event = (side: 'LONG' | 'SHORT') => {
    const scope = {
      environment: 'OFFLINE_FIXTURE' as const,
      evidence: 'SYNTHETIC' as const,
      leaderAccountId: '01',
      sourceId: `source-${side}`,
      symbol: 'NDX' as const,
    };
    records.registerLeaderStream({ ...scope, baselineSequence: 0 });
    return records.recordLeaderEvent(
      leaderEventSchema.parse({
        ...scope,
        origin: 'ACCEPTED_EVENT',
        providerEventId: `entry-${side}`,
        entryRootId: `entry-${side}`,
        sequence: 1,
        occurredAt: NOW,
        kind: 'ENTRY',
        side,
        quantity: '1',
        leverage: '10',
      }),
      { generation, detectedAt: NOW },
    ).eventId;
  };
  const long = event('LONG'),
    short = event('SHORT');
  const claim = (
    eventId = long,
    accountId = '02',
    accounts = initialFleet(NOW),
  ) =>
    records.claimFollowerAttempt(
      { eventId, followerAccountId: accountId, quantity: '1', leverage: '10' },
      generation,
      NOW,
      { accounts, maxAgeMs: 5000 },
    );
  return { journal, records, generation, long, short, claim };
}
type Fixture = ReturnType<typeof fixture>;
function withFixture(run: (f: Fixture) => void) {
  const f = fixture();
  try {
    run(f);
  } finally {
    f.journal.close();
  }
}
describe('atomic pending fleet hedge reservations', () => {
  it('includes claimed-but-not-sent exposure', () =>
    withFixture((f) => {
      f.claim();
      expect(() => f.claim(f.short, '03')).toThrow('COPIER_HEDGE_CONFLICT');
      expect(f.records.globalStop()).toBe('UNSAFE_FLEET_EXPOSURE');
    }));
  it('permits independent same-side reservations', () =>
    withFixture((f) => {
      expect(f.claim().fresh).toBe(true);
      expect(f.claim(f.long, '03').fresh).toBe(true);
      expect(f.records.globalStop()).toBeNull();
    }));
  it('retains an UNKNOWN reservation across journal reopen', () => {
    const dir = mkdtempSync(join(tmpdir(), 'copier-pending-')),
      path = join(dir, 'journal.sqlite');
    const f = fixture(path),
      c = f.claim();
    const a = f.records.markDispatchStarted(
      c.attempt.attemptId,
      f.generation,
      NOW,
    );
    f.records.recordAttemptObservation(a.attemptId, a.revision, {
      observationId: randomUUID(),
      observedAt: NOW,
      outcome: {
        ...a.outcome,
        submission: 'UNKNOWN',
        reason: 'ACKNOWLEDGEMENT_LOST',
      },
      terminal: null,
    });
    f.journal.close();
    const restored = new Journal(path);
    try {
      expect(() =>
        restored.copier.claimFollowerAttempt(
          {
            eventId: f.short,
            followerAccountId: '03',
            quantity: '1',
            leverage: '10',
          },
          randomUUID(),
          NOW,
        ),
      ).toThrow('COPIER_HEDGE_CONFLICT');
    } finally {
      restored.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it('retains pending exposure even if its account becomes disabled', () =>
    withFixture((f) => {
      f.claim();
      const fleet = initialFleet(NOW);
      fleet.find((a) => a.accountId === '02')!.enabled = false;
      expect(() => f.claim(f.short, '03', fleet)).toThrow(
        'COPIER_HEDGE_CONFLICT',
      );
    }));
  it('releases only after correlated terminal evidence and absent exposure', () =>
    withFixture((f) => {
      const c = f.claim(),
        a = c.attempt;
      f.records.recordAttemptObservation(a.attemptId, a.revision, {
        observationId: randomUUID(),
        observedAt: NOW,
        outcome: { ...a.outcome, exposure: 'ABSENT' },
        terminal: {
          evidence: 'SYNTHETIC',
          attemptId: a.attemptId,
          payloadHash: c.command.payloadHash,
          accountId: '02',
          result: 'NOT_SENT',
          providerOrderId: null,
          noFutureExecution: true,
          remainingQuantity: '0',
          observedAt: NOW,
        },
      });
      expect(f.claim(f.short, '03').fresh).toBe(true);
    }));
  it('counts opposing observed positions on enabled unselected accounts', () =>
    withFixture((f) => {
      const fleet = initialFleet(NOW);
      fleet.find((a) => a.accountId === '10')!.positions = [
        {
          symbol: 'NDX',
          side: 'LONG',
          quantity: '1',
          entryPrice: '30400',
          leverage: '10',
          entryRequestId: 'external-position',
          protectionStatus: 'ACTIVE',
        },
      ];
      expect(() => f.claim(f.short, '03', fleet)).toThrow(
        'COPIER_HEDGE_CONFLICT',
      );
    }));
  it('fails closed on stale full-fleet evidence', () =>
    withFixture((f) => {
      const fleet = initialFleet(NOW);
      fleet[9]!.lastSyncTimestamp = NOW - 5001;
      expect(() => f.claim(f.long, '02', fleet)).toThrow(
        'COPIER_FLEET_UNPROVEN',
      );
      expect(f.records.globalStop()).toBe('ACCOUNT_MAPPING_CORRUPT');
    }));
  it('rechecks observed exposure at the durable dispatch boundary', () =>
    withFixture((f) => {
      const c = f.claim(),
        fleet = initialFleet(NOW);
      fleet[9]!.positions = [
        {
          symbol: 'NDX',
          side: 'SHORT',
          quantity: '1',
          entryPrice: '30400',
          leverage: '10',
          entryRequestId: 'external-position',
          protectionStatus: 'ACTIVE',
        },
      ];
      expect(() =>
        f.records.markDispatchStarted(c.attempt.attemptId, f.generation, NOW, {
          accounts: fleet,
          maxAgeMs: 5000,
        }),
      ).toThrow('COPIER_HEDGE_CONFLICT');
      expect(
        f.records.followerAttempt(c.attempt.attemptId)?.dispatchStartedAt,
      ).toBeNull();
    }));
  it('permits at most one opposing side across competing processes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'copier-hedge-race-')),
      path = join(dir, 'journal.sqlite');
    const f = fixture(path);
    f.journal.close();
    const worker = fileURLToPath(
      new URL('./fixtures/copier-claim-worker.ts', import.meta.url),
    );
    const children = [
      fork(worker, [path, f.long, randomUUID(), String(NOW), '02'], {
        execArgv: ['--import', 'tsx'],
        stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      }),
      fork(worker, [path, f.short, randomUUID(), String(NOW), '03'], {
        execArgv: ['--import', 'tsx'],
        stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      }),
    ];
    try {
      const ready = children.map(
        (child) =>
          new Promise<void>((resolve, reject) => {
            child.once('message', (msg) =>
              msg === 'READY'
                ? resolve()
                : reject(new Error('WORKER_NOT_READY')),
            );
            child.once('error', reject);
          }),
      );
      await Promise.all(ready);
      const results = children.map(
        (child) =>
          new Promise<unknown>((resolve, reject) => {
            child.once('message', resolve);
            child.once('error', reject);
          }),
      );
      children.forEach((child) => child.send('CLAIM'));
      const outcome = await Promise.all(results);
      expect(
        outcome.filter(
          (r) =>
            typeof r === 'object' &&
            r !== null &&
            'fresh' in r &&
            r.fresh === true,
        ),
      ).toHaveLength(1);
      expect(outcome.filter((r) => r === 'FAILED')).toHaveLength(1);
      const reopened = new Journal(path);
      try {
        expect(reopened.copier.globalStop()).toBe('UNSAFE_FLEET_EXPOSURE');
        expect(
          reopened.copier.eventFollowers(f.long).length +
            reopened.copier.eventFollowers(f.short).length,
        ).toBe(1);
      } finally {
        reopened.close();
      }
    } finally {
      children.forEach((child) => child.kill());
      rmSync(dir, { recursive: true, force: true });
    }
  }, 10000);
});
