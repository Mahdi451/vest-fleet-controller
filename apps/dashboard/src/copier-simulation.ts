import { z } from 'zod';
import { Journal } from '../../../packages/execution/src/journal.ts';
import { OfflineFanoutController } from '../../../packages/execution/src/fanout-controller.ts';
import { leaderEventSchema } from '../../../packages/execution/src/copier-events.ts';
import { repairOperationSchema } from '../../../packages/execution/src/copier-repairs.ts';
import { MockVestAdapter } from '../../../packages/simulator/src/index.ts';
import {
  intentSchema,
  positive,
  type RiskConfig,
} from '../../../packages/core/src/index.ts';
const accountId = z.string().regex(/^0[2-9]$|^10$/);
const armSchema = z
  .object({
    followers: z.array(accountId).min(1).max(9),
    maxLeverage: positive,
    maxNotional: positive,
    maxPlannedLoss: positive,
    durationMs: z.number().int().positive().max(900000),
  })
  .strict();
const entrySchema = z
  .object({
    eventKey: z.string().uuid(),
    sequence: z.number().int().positive(),
    intent: intentSchema,
  })
  .strict();
const repairSchema = z
  .object({
    eventId: z.string().regex(/^[a-f0-9]{64}$/),
    accountId,
    operation: repairOperationSchema,
    expectedAttemptId: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
const changeBase = {
  entryEventId: z.string().regex(/^[a-f0-9]{64}$/),
  eventKey: z.string().uuid(),
  sequence: z.number().int().positive(),
};
const changeSchema = z.discriminatedUnion('kind', [
  z
    .object({ ...changeBase, kind: z.literal('ADD'), quantity: positive })
    .strict(),
  z
    .object({ ...changeBase, kind: z.literal('REDUCE'), quantity: positive })
    .strict(),
  z.object({ ...changeBase, kind: z.literal('CLOSE') }).strict(),
  z
    .object({ ...changeBase, kind: z.literal('STOP_CHANGED'), price: positive })
    .strict(),
  z
    .object({
      ...changeBase,
      kind: z.literal('TARGET_CHANGED'),
      price: positive,
    })
    .strict(),
]);
const scenarioSchema = z
  .object({
    accountId,
    fault: z.enum([
      'REJECT_ENTRY',
      'UNKNOWN_ENTRY',
      'REJECT_STOP',
      'REJECT_TARGET',
    ]),
  })
  .strict();

/** Separate fixture fleet and journal: never adopts or mutates the legacy simulation. */
export async function createCopierSimulation(
  config: RiskConfig,
  path?: string,
  now: () => number = Date.now,
) {
  const journal = new Journal(path);
  const owner: { controller?: OfflineFanoutController } = {};
  const saved = journal.loadSimulator();
  const adapter = new MockVestAdapter(
    config,
    now,
    undefined,
    '30400',
    (event) => journal.log(event),
    (snapshot) => {
      try {
        journal.saveSimulator(snapshot);
      } catch {
        owner.controller?.halt('JOURNAL_INTEGRITY_LOST');
        throw new Error('COPIER_SIMULATION_STORAGE_FAILED');
      }
    },
    saved ?? undefined,
  );
  await adapter.connect();
  const copier = new OfflineFanoutController(adapter, config, journal, now);
  owner.controller = copier;
  journal.copier.registerLeaderStream({
    environment: 'OFFLINE_FIXTURE',
    evidence: 'SYNTHETIC',
    leaderAccountId: '01',
    sourceId: 'dashboard-synthetic-leader',
    symbol: 'NDX',
    baselineSequence: 0,
  });
  const active = new Set<Promise<unknown>>();
  let closing = false;
  async function execute(path: string, input: unknown) {
    if (closing) throw new Error('COPIER_SHUTTING_DOWN');
    if (path === '/api/copier/arm') {
      const policy = armSchema.parse(input);
      return copier.arm({
        environment: 'OFFLINE_FIXTURE',
        evidence: 'SYNTHETIC',
        leaderAccountId: '01',
        followerAccountIds: policy.followers,
        symbol: 'NDX',
        maxLeverage: policy.maxLeverage,
        maxNotionalPerAccount: policy.maxNotional,
        maxPlannedLossPerAccount: policy.maxPlannedLoss,
        expiresAt: now() + policy.durationMs,
      });
    }
    if (path === '/api/copier/lock') {
      z.object({}).strict().parse(input);
      copier.lock();
      return 'LOCKED';
    }
    if (path === '/api/copier/entry') {
      const request = entrySchema.parse(input);
      const event = leaderEventSchema.parse({
        environment: 'OFFLINE_FIXTURE',
        evidence: 'SYNTHETIC',
        origin: 'ACCEPTED_EVENT',
        leaderAccountId: '01',
        sourceId: 'dashboard-synthetic-leader',
        symbol: 'NDX',
        providerEventId: request.eventKey,
        entryRootId: request.eventKey,
        sequence: request.sequence,
        occurredAt: now(),
        kind: 'ENTRY',
        side: request.intent.side,
        quantity: '1',
        leverage: request.intent.leverage,
      });
      // Reconnect uses the immutable original event facts rather than inventing a new detection time.
      const previous = journal.copier
        .leaderEvents()
        .find((row) => row.event.providerEventId === request.eventKey);
      if (
        previous &&
        (previous.event.sequence !== request.sequence ||
          previous.event.side !== request.intent.side ||
          previous.event.leverage !== request.intent.leverage)
      ) {
        copier.halt('EVENT_IDENTITY_CORRUPT');
        throw new Error('COPIER_IDENTITY_CONFLICT');
      }
      if (!previous && copier.status() !== 'ARMED')
        throw new Error('OFFLINE_ENTRY_LOCKED');
      const accepted = previous ?? {
        eventId: copier.acceptSyntheticLeaderEvent(event).eventId,
        event,
      };
      return copier.copyEntry(accepted.eventId, request.intent);
    }
    if (path === '/api/copier/repair') {
      const request = repairSchema.parse(input);
      return copier.repair(
        request.eventId,
        request.accountId,
        request.operation,
        request.expectedAttemptId,
      );
    }
    if (path === '/api/copier/change') {
      const request = changeSchema.parse(input);
      const entry = journal.copier.leaderEvent(request.entryEventId);
      if (!entry || entry.kind !== 'ENTRY')
        throw new Error('CHANGE_ROOT_UNPROVEN');
      const previous = journal.copier
        .leaderEvents()
        .find((row) => row.event.providerEventId === request.eventKey);
      const event = leaderEventSchema.parse({
        ...entry,
        providerEventId: request.eventKey,
        sequence: request.sequence,
        occurredAt: previous?.event.occurredAt ?? now(),
        kind: request.kind,
        quantity: 'quantity' in request ? request.quantity : entry.quantity,
        ...('price' in request ? { price: request.price } : {}),
      });
      if (!previous && copier.status() !== 'ARMED')
        throw new Error('OFFLINE_MUTATION_LOCKED');
      const accepted = copier.acceptSyntheticLeaderEvent(event);
      return copier.copyChange(accepted.eventId);
    }
    if (path === '/api/copier/change-reconcile') {
      const request = z
        .object({ mutationId: z.string().regex(/^[a-f0-9]{64}$/) })
        .strict()
        .parse(input);
      return copier.reconcileChange(request.mutationId);
    }
    if (path === '/api/copier/scenario') {
      const scenario = scenarioSchema.parse(input);
      if (copier.status() !== 'ARMED') throw new Error('OFFLINE_ENTRY_LOCKED');
      if (scenario.fault === 'REJECT_ENTRY')
        adapter.injectFault(scenario.accountId, 'REJECT');
      if (scenario.fault === 'UNKNOWN_ENTRY')
        adapter.injectFault(scenario.accountId, 'TIMEOUT_BEFORE_FILL');
      if (scenario.fault === 'REJECT_STOP')
        adapter.injectProtectionFault(
          scenario.accountId,
          'STOP_LOSS',
          'REJECT',
        );
      if (scenario.fault === 'REJECT_TARGET')
        adapter.injectProtectionFault(
          scenario.accountId,
          'TAKE_PROFIT',
          'REJECT',
        );
      return 'SCENARIO_READY';
    }
    throw new Error('COPIER_ROUTE_UNKNOWN');
  }
  return {
    async state() {
      const events = journal.copier.leaderEvents();
      return {
        mode: 'OFFLINE_FIXTURE',
        liveState: 'LOCKED',
        liveSend: false,
        session: copier.status(),
        nextSequence:
          Math.max(0, ...events.map((row) => row.event.sequence)) + 1,
        accounts: await adapter.listAccounts(),
        ownedRoots: journal.mutations.roots(),
        mutationActivations: journal.mutations.activations(),
        mutations: journal.mutations.records().map((row) => ({
          ...row,
          request: undefined,
          receipt: undefined,
          clockSource: 'CONTROLLER_WALL_MS',
          leaderToSubmitMs:
            row.submitAt === null ||
            row.ownerGeneration !== row.detectionGeneration ||
            row.submitAt < row.detectedAt
              ? null
              : row.submitAt - row.detectedAt,
          leaderToVerifiedMs:
            row.verifiedAt === null ||
            row.verifiedGeneration !== row.detectionGeneration ||
            row.verifiedAt < row.detectedAt
              ? null
              : row.verifiedAt - row.detectedAt,
        })),
        events: events.map((row) => ({
          ...row,
          followers: copier.snapshot(row.eventId),
          latency: journal.latency.eventSummary(row.eventId),
        })),
      };
    },
    command(path: string, input: unknown) {
      const promise = execute(path, input);
      active.add(promise);
      void promise.then(
        () => active.delete(promise),
        () => active.delete(promise),
      );
      return promise;
    },
    lock: () => copier.lock(),
    async close() {
      closing = true;
      copier.lock();
      await Promise.allSettled([...active]);
      await adapter.disconnect();
      journal.close();
    },
  };
}
