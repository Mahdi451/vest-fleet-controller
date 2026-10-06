import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { Journal } from '../packages/execution/src/journal.ts';
import { OfflineFanoutController } from '../packages/execution/src/fanout-controller.ts';
import { leaderEventSchema } from '../packages/execution/src/copier-events.ts';
import type { LatencyStamp } from '../packages/execution/src/copier-latency.ts';
import { MockVestAdapter } from '../packages/simulator/src/index.ts';
import { authenticatedOfflineBridge } from '../packages/browser-execution/src/bridge/authenticated-channel.ts';
import {
  normalizeProviderEntry,
  normalizeProviderInventory,
} from '../packages/browser-execution/src/bridge/provider-evidence.ts';
import { config, intent, NOW } from './helpers.ts';

// Synthetic test marker only: never an actual account or session credential.
const CANARY = 'fixture-secret-canary_9f83ca41a2704d7dbdfec589425a6e72';
const clean = (...values: unknown[]) => {
  for (const value of values)
    expect(
      typeof value === 'string' ? value : JSON.stringify(value),
    ).not.toContain(CANARY);
};
function cleanFiles(directory: string) {
  for (const name of readdirSync(directory))
    clean(readFileSync(join(directory, name)).toString('latin1'));
}
function errorOf(run: () => unknown) {
  try {
    run();
    throw new Error('EXPECTED_REFUSAL');
  } catch (error) {
    expect(String(error)).not.toBe('Error: EXPECTED_REFUSAL');
    return String(error);
  }
}
async function rejected(run: () => Promise<unknown>) {
  try {
    await run();
    throw new Error('EXPECTED_REFUSAL');
  } catch (error) {
    expect(String(error)).not.toBe('Error: EXPECTED_REFUSAL');
    clean(String(error));
    return String(error);
  }
}
async function fixture(
  run: (f: {
    journal: Journal;
    adapter: MockVestAdapter;
    copier: OfflineFanoutController;
    eventId: string;
    directory: string;
  }) => Promise<void>,
) {
  const directory = mkdtempSync(join(tmpdir(), 'copier-canary-'));
  const journal = new Journal(join(directory, 'journal.sqlite'));
  const adapter = new MockVestAdapter(config, () => NOW, undefined, '30400');
  try {
    await adapter.connect();
    journal.copier.registerLeaderStream({
      environment: 'OFFLINE_FIXTURE',
      evidence: 'SYNTHETIC',
      leaderAccountId: '01',
      sourceId: 'canary-fixture',
      symbol: 'NDX',
      baselineSequence: 0,
    });
    const { eventId } = journal.copier.recordLeaderEvent(
      leaderEventSchema.parse({
        environment: 'OFFLINE_FIXTURE',
        evidence: 'SYNTHETIC',
        origin: 'ACCEPTED_EVENT',
        leaderAccountId: '01',
        sourceId: 'canary-fixture',
        symbol: 'NDX',
        providerEventId: 'entry-1',
        entryRootId: 'entry-1',
        sequence: 1,
        occurredAt: NOW,
        kind: 'ENTRY',
        side: 'LONG',
        quantity: '1',
        leverage: intent.leverage,
      }),
      { generation: randomUUID(), detectedAt: NOW },
    );
    const copier = new OfflineFanoutController(
      adapter,
      config,
      journal,
      () => NOW,
      100,
    );
    await copier.arm({
      environment: 'OFFLINE_FIXTURE',
      evidence: 'SYNTHETIC',
      leaderAccountId: '01',
      followerAccountIds: ['02'],
      symbol: 'NDX',
      maxLeverage: '50',
      maxNotionalPerAccount: '100000',
      maxPlannedLossPerAccount: '10',
      expiresAt: NOW + 10000,
    });
    await run({ journal, adapter, copier, eventId, directory });
    cleanFiles(directory);
  } finally {
    await adapter.disconnect();
    journal.close();
    try {
      cleanFiles(directory);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }
}

describe('synthetic credential canaries at copier boundaries', () => {
  it('rejects malformed provider facts with fixed errors and no raw payload echo', () => {
    const context = {
      accountId: '02',
      contextId: 'fixture-02',
      generation: randomUUID(),
      state: 'READY' as const,
      identityVerifiedAt: NOW,
    };
    const binding = {
      expectedAccountIds: ['02'],
      contexts: [context],
      maxAgeMs: 100,
    };
    const expected = {
      accountId: '02',
      requestId: 'entry-02',
      symbol: 'NDX' as const,
      quantity: '1',
    };
    const error = errorOf(() =>
      normalizeProviderEntry(
        {
          environment: 'OFFLINE_FIXTURE',
          evidence: 'SYNTHETIC',
          context,
          capturedAt: NOW,
          accountId: '02',
          requestId: 'entry-02',
          providerOrderId: 'order-02',
          symbol: 'NDX',
          status: 'REJECTED',
          requestedQuantity: '1',
          filledQuantity: '0',
          fillPrice: null,
          fees: '0',
          remainder: {
            state: 'CANCELED',
            quantity: '0',
            noFutureExecution: true,
          },
          rejectionCode: CANARY,
        },
        expected,
        binding,
        NOW,
      ),
    );
    expect(error).toBe('Error: PROVIDER_EVIDENCE_INVALID');
    clean(
      error,
      errorOf(() =>
        normalizeProviderInventory({ credential: CANARY }, binding, NOW),
      ),
    );
  });
  it('sanitizes a provider exception before submission without entry side effects', async () =>
    fixture(async (f) => {
      const entry = vi.spyOn(f.adapter, 'placeOrder');
      vi.spyOn(f.adapter, 'getOpenOrders').mockRejectedValue(new Error(CANARY));
      const result = await f.copier.copyEntry(f.eventId, intent);
      expect(entry).not.toHaveBeenCalled();
      expect(result[0]!.attempt!.outcome.submission).not.toBe('ACCEPTED');
      clean(
        result,
        f.copier.snapshot(f.eventId),
        f.journal.events(),
        f.journal.copier.eventFollowers(f.eventId),
        f.journal.latency.eventSummary(f.eventId),
      );
    }));
  it('sanitizes submission and reconciliation exceptions while preserving UNKNOWN', async () =>
    fixture(async (f) => {
      const entry = vi
        .spyOn(f.adapter, 'placeOrder')
        .mockRejectedValue(new Error(CANARY));
      vi.spyOn(f.adapter, 'getOrder').mockRejectedValue(new Error(CANARY));
      const result = await f.copier.copyEntry(f.eventId, intent);
      expect(entry).toHaveBeenCalledTimes(1);
      expect(result[0]!.attempt!.outcome.submission).toBe('UNKNOWN');
      clean(
        result,
        f.copier.snapshot(f.eventId),
        f.journal.events(),
        f.journal.copier.eventFollowers(f.eventId),
        f.journal.latency.eventSummary(f.eventId),
      );
    }));
  it('does not persist a raw rejected provider ledger error into the execution journal', async () =>
    fixture(async (f) => {
      const raw = (requestId: string) => ({
        requestId,
        accountId: '02',
        status: 'REJECTED' as const,
        filledSize: '0',
        entryPrice: null,
        fees: '0',
        error: CANARY,
      });
      const entry = vi
        .spyOn(f.adapter, 'placeOrder')
        .mockImplementation(async (request) => raw(request.requestId));
      vi.spyOn(f.adapter, 'getOrder').mockImplementation(async (requestId) =>
        raw(requestId),
      );
      const result = await f.copier.copyEntry(f.eventId, intent);
      expect(entry).toHaveBeenCalledTimes(1);
      expect(result[0]!.attempt!.outcome.submission).toBe('REJECTED');
      clean(
        result,
        f.copier.snapshot(f.eventId),
        f.journal.events(),
        f.journal.copier.eventFollowers(f.eventId),
      );
    }));
  it('sanitizes repair book failures without dispatching an exposure-changing repair', async () =>
    fixture(async (f) => {
      const result = await f.copier.copyEntry(f.eventId, intent);
      expect(result[0]!.attempt!.outcome.stop).toBe('VERIFIED');
      const flatten = vi.spyOn(f.adapter, 'flattenOwnedPosition');
      const protection = vi.spyOn(f.adapter, 'repairOwnedProtection');
      vi.spyOn(f.adapter, 'getOpenOrders').mockRejectedValue(new Error(CANARY));
      const error = await rejected(() =>
        f.copier.repair(f.eventId, '02', 'FLATTEN'),
      );
      expect(error).toContain('FOLLOWER_PROVIDER_UNAVAILABLE');
      expect(flatten).not.toHaveBeenCalled();
      expect(protection).not.toHaveBeenCalled();
      clean(
        f.copier.snapshot(f.eventId),
        f.journal.events(),
        f.journal.copier.eventFollowers(f.eventId),
        f.journal.latency.eventSummary(f.eventId),
      );
    }));
  it('does not persist malformed latency payloads or hashed repair payload canaries', async () =>
    fixture(async (f) => {
      const result = await f.copier.copyEntry(f.eventId, intent),
        attempt = result[0]!.attempt!;
      const error = errorOf(() =>
        f.journal.latency.recordStamp({
          environment: 'OFFLINE_FIXTURE',
          evidence: 'SYNTHETIC',
          eventId: f.eventId,
          accountId: '02',
          attemptId: attempt.attemptId,
          phase: 'FILL_DETECTED',
          observedAt: NOW,
          clockSource: 'fixture',
          generation: randomUUID(),
          credential: CANARY,
        } as LatencyStamp),
      );
      expect(error).toBe('Error: INVALID_LATENCY_STAMP');
      const repair = f.journal.repairs.claim(
        attempt.attemptId,
        'RECONCILE',
        { syntheticMalformedCredential: CANARY },
        NOW,
      );
      clean(
        error,
        repair,
        f.journal.repairs.get(repair.record.repairId),
        f.journal.latency.eventSummary(f.eventId),
      );
    }));
  it('sanitizes backing channel errors and inspection after quarantine', async () => {
    const sessionId = randomUUID();
    const channel = authenticatedOfflineBridge(
      {
        environment: 'OFFLINE_FIXTURE',
        sessionId,
        concurrency: 'ACCOUNT_BOUND',
        exchange: async () => {
          throw new Error(CANARY);
        },
        quarantine: async () => {},
        close: async () => {},
      },
      {
        ownerGeneration: randomUUID(),
        controllerGeneration: randomUUID(),
        browserGeneration: randomUUID(),
      },
      {},
      () => NOW,
    );
    const error = await rejected(() =>
      channel.port.exchange(
        JSON.stringify({
          version: 1,
          environment: 'OFFLINE_FIXTURE',
          sessionId,
          messageId: randomUUID(),
          operation: 'CONNECT',
          payload: {},
        }),
      ),
    );
    expect(error).toBe('Error: AUTHENTICATED_CHANNEL_UNCONFIRMED');
    expect(channel.inspect().state).toBe('QUARANTINED');
    clean(channel.inspect());
  });
  it('rejects channel payload canaries without forwarding them to the backing port', async () => {
    const sessionId = randomUUID(),
      exchange = vi.fn(async () => CANARY);
    const channel = authenticatedOfflineBridge(
      {
        environment: 'OFFLINE_FIXTURE',
        sessionId,
        concurrency: 'ACCOUNT_BOUND',
        exchange,
        quarantine: async () => {},
        close: async () => {},
      },
      {
        ownerGeneration: randomUUID(),
        controllerGeneration: randomUUID(),
        browserGeneration: randomUUID(),
      },
      {},
      () => NOW,
    );
    await rejected(() =>
      channel.port.exchange(
        JSON.stringify({
          version: 1,
          environment: 'OFFLINE_FIXTURE',
          sessionId,
          messageId: randomUUID(),
          operation: 'CONNECT',
          payload: { credential: CANARY },
        }),
      ),
    );
    expect(exchange).not.toHaveBeenCalled();
    clean(channel.inspect());
  });
});
