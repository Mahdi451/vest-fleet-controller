import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { OfflineBridgeExecutionAdapter } from '../packages/browser-execution/src/bridge/adapter.ts';
import {
  MAX_BRIDGE_MESSAGE_BYTES,
  parseBridgeRequest,
  type OfflineBridgePort,
} from '../packages/browser-execution/src/bridge/protocol.ts';
import { LIVE_VEST_SEND } from '../packages/browser-execution/src/live-command.ts';
import { D } from '../packages/core/src/index.ts';
import type { OrderRequest } from '../packages/execution/src/adapter.ts';
import { FleetController } from '../packages/execution/src/controller.ts';
import { Journal } from '../packages/execution/src/journal.ts';
import { MockVestAdapter } from '../packages/simulator/src/index.ts';
import { config, intent, NOW } from './helpers.ts';
import { offlineBridge } from './fixtures/offline-bridge.ts';

async function setup(path?: string) {
  let now = NOW;
  const clock = () => now;
  const journal = new Journal(path);
  const mock = new MockVestAdapter(config, clock, undefined, '30400');
  await mock.connect();
  const fixture = offlineBridge(mock, clock);
  const adapter = new OfflineBridgeExecutionAdapter(
    fixture.port,
    journal,
    { timeoutMs: 50 },
    clock,
  );
  await adapter.connect();
  const controller = new FleetController(adapter, config, journal, clock, 100);
  return {
    ...fixture,
    mock,
    journal,
    adapter,
    controller,
    clock,
    advance: (ms: number) => {
      now += ms;
    },
  };
}
type Setup = Awaited<ReturnType<typeof setup>>;
async function withSetup(run: (s: Setup) => Promise<void>) {
  const s = await setup();
  try {
    await run(s);
  } finally {
    await s.adapter.disconnect();
    s.journal.close();
  }
}
async function request(s: Setup): Promise<OrderRequest> {
  const preview = await s.controller.preview(intent, ['01']);
  return {
    requestId: 'entry-01',
    masterTradeId: 'master-01',
    accountId: '01',
    intent,
    preview: preview.orders[0]!,
    quote: preview.quote,
    config,
  };
}

describe('offline browser bridge through the durable fleet controller', () => {
  it.each(['LONG', 'SHORT'] as const)(
    'protects %s from each fill and verifies emergency flatten',
    (side) =>
      withSetup(async (s) => {
        const preview = await s.controller.preview({ ...intent, side }, [
          '01',
          '02',
        ]);
        const results = await s.controller.execute(
          'bridge-trade',
          preview.previewId,
        );
        expect(results.map((result) => result.state)).toEqual([
          'PROTECTED',
          'PROTECTED',
        ]);
        expect(s.writes).toEqual([
          'ENTRY',
          'PROTECTION',
          'PROTECTION',
          'ENTRY',
          'PROTECTION',
          'PROTECTION',
        ]);
        for (const result of results) {
          const fill = new D(result.entryPrice!);
          expect(result.stopPrice).toBe(
            fill.plus(side === 'LONG' ? '-80' : '80').toFixed(),
          );
          expect(result.targetPrice).toBe(
            fill.plus(side === 'LONG' ? '80' : '-80').toFixed(),
          );
        }
        expect(
          await s.controller.execute('bridge-trade', preview.previewId),
        ).toEqual(results);
        expect(
          s.writes.filter((operation) => operation === 'ENTRY'),
        ).toHaveLength(2);
        await s.controller.flattenAll();
        for (const id of ['01', '02']) {
          expect((await s.mock.getAccountState(id)).positions).toEqual([]);
          expect(await s.mock.getOpenOrders(id)).toEqual([]);
        }
        expect(s.journal.hasUnresolvedExecution()).toBe(false);
        expect(s.adapter.mode).toBe('SIMULATION');
        expect(LIVE_VEST_SEND).toBe(false);
      }),
  );

  it('replays a completed command after reopening its SQLite journal', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'vest-bridge-'));
    const path = join(dir, 'journal.sqlite');
    const s = await setup(path);
    let reopened: Journal | undefined;
    try {
      const preview = await s.controller.preview(intent, ['01']);
      const original = await s.controller.execute(
        'durable-trade',
        preview.previewId,
      );
      s.journal.close();
      reopened = new Journal(path);
      const next = offlineBridge(s.mock, s.clock);
      const adapter = new OfflineBridgeExecutionAdapter(
        next.port,
        reopened,
        {},
        s.clock,
      );
      await adapter.connect();
      const controller = new FleetController(
        adapter,
        config,
        reopened,
        s.clock,
      );
      expect(
        await controller.execute('durable-trade', preview.previewId),
      ).toEqual(original);
      expect(next.writes).toEqual([]);
      await adapter.disconnect();
    } finally {
      await s.adapter.disconnect();
      reopened?.close();
      if (!reopened) s.journal.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('retains an unresolved entry after response loss and never resubmits after restart', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'vest-bridge-loss-'));
    const path = join(dir, 'journal.sqlite');
    const s = await setup(path);
    let reopened: Journal | undefined;
    try {
      const exchange = s.port.exchange;
      s.port.exchange = async (message) => {
        const response = await exchange(message);
        if (parseBridgeRequest(message).operation === 'ENTRY')
          throw new Error('sensitive raw provider error');
        return response;
      };
      const preview = await s.controller.preview(intent, ['01', '02']);
      const result = await s.controller.execute(
        'lost-trade',
        preview.previewId,
      );
      expect(result.map((row) => row.state)).toEqual(['UNKNOWN', 'HALTED']);
      expect((await s.mock.getAccountState('01')).positions).toHaveLength(1);
      expect(s.writes).toEqual(['ENTRY']);
      expect(s.journal.hasUnresolvedExecution()).toBe(true);
      s.journal.close();
      reopened = new Journal(path);
      const next = offlineBridge(s.mock, s.clock);
      const adapter = new OfflineBridgeExecutionAdapter(
        next.port,
        reopened,
        {},
        s.clock,
      );
      await adapter.connect();
      const controller = new FleetController(
        adapter,
        config,
        reopened,
        s.clock,
      );
      expect(controller.health().state).toBe('HALTED');
      expect(await controller.execute('lost-trade', preview.previewId)).toEqual(
        result,
      );
      expect(next.writes).toEqual([]);
      await adapter.disconnect();
    } finally {
      await s.adapter.disconnect();
      reopened?.close();
      if (!reopened) s.journal.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not dispatch duplicate direct entry attempts and rejects changed payloads', () =>
    withSetup(async (s) => {
      const order = await request(s);
      const [first, second] = await Promise.all([
        s.adapter.placeOrder(order),
        s.adapter.placeOrder(order),
      ]);
      expect(second).toEqual(first);
      expect(s.writes).toEqual(['ENTRY']);
      await expect(
        s.adapter.placeOrder({
          ...order,
          intent: { ...intent, side: 'SHORT' },
        }),
      ).rejects.toThrow('IDEMPOTENCY_CONFLICT');
      expect(s.writes).toEqual(['ENTRY']);
    }));

  it('does not repeat an unresolved partial flatten after the book changes and the journal reopens', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'vest-bridge-flatten-'));
    const path = join(dir, 'journal.sqlite');
    const s = await setup(path);
    let reopened: Journal | undefined;
    try {
      const preview = await s.controller.preview(intent, ['01']);
      await s.controller.execute('flatten-loss', preview.previewId);
      const exchange = s.port.exchange;
      s.port.exchange = async (message) => {
        if (parseBridgeRequest(message).operation !== 'FLATTEN')
          return exchange(message);
        s.writes.push('FLATTEN');
        const orders = await s.mock.getOpenOrders('01');
        await s.mock.cancelOrder('01', orders[0]!.orderId);
        throw new Error('response lost after partial cleanup');
      };
      await expect(s.adapter.flattenAccount('01')).rejects.toThrow(
        'BRIDGE_EXCHANGE_UNCONFIRMED',
      );
      expect((await s.mock.getAccountState('01')).positions).toHaveLength(1);
      expect(await s.mock.getOpenOrders('01')).toHaveLength(1);
      s.journal.close();
      reopened = new Journal(path);
      const next = offlineBridge(s.mock, s.clock);
      const adapter = new OfflineBridgeExecutionAdapter(
        next.port,
        reopened,
        {},
        s.clock,
      );
      await adapter.connect();
      await expect(adapter.flattenAccount('01')).rejects.toThrow(
        'BRIDGE_UNRESOLVED_MUTATION',
      );
      expect(next.writes).toEqual([]);
      expect(reopened.hasUnresolvedExecution()).toBe(true);
      // Observation is available for recovery; it does not clear the pending write.
      expect((await adapter.getAccountState('01')).positions).toHaveLength(1);
      await adapter.disconnect();
    } finally {
      await s.adapter.disconnect();
      reopened?.close();
      if (!reopened) s.journal.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps a flat-looking account unknown after a lost flatten acknowledgement', () =>
    withSetup(async (s) => {
      const preview = await s.controller.preview(intent, ['01']);
      await s.controller.execute('flat-response-loss', preview.previewId);
      const exchange = s.port.exchange;
      s.port.exchange = async (message) => {
        const response = await exchange(message);
        if (parseBridgeRequest(message).operation === 'FLATTEN')
          throw new Error('lost response');
        return response;
      };
      await expect(s.adapter.flattenAccount('01')).rejects.toThrow(
        'BRIDGE_EXCHANGE_UNCONFIRMED',
      );
      expect((await s.mock.getAccountState('01')).positions).toEqual([]);
      const next = offlineBridge(s.mock, s.clock);
      const adapter = new OfflineBridgeExecutionAdapter(
        next.port,
        s.journal,
        {},
        s.clock,
      );
      await adapter.connect();
      try {
        const controller = new FleetController(
          adapter,
          config,
          s.journal,
          s.clock,
        );
        const result = await controller.flattenAll();
        expect(
          result.find((account) => account.accountId === '01')?.status,
        ).toBe('UNKNOWN');
        expect(next.writes).toEqual([]);
        expect(s.journal.hasUnresolvedExecution()).toBe(true);
      } finally {
        await adapter.disconnect();
      }
    }));

  it.each(['PARTIAL_FILL', 'PARTIAL_FILL_PENDING'] as const)(
    'handles %s using existing protection and cleanup rules',
    (fault) =>
      withSetup(async (s) => {
        s.mock.injectFault('01', fault);
        const preview = await s.controller.preview(intent, ['01', '02']);
        const result = await s.controller.execute(
          'partial-trade',
          preview.previewId,
        );
        if (fault === 'PARTIAL_FILL') {
          expect(result.map((row) => row.state)).toEqual([
            'PROTECTED',
            'PROTECTED',
          ]);
          expect(result[0]?.entryWasPartial).toBe(true);
        } else {
          expect(result[0]?.state).not.toBe('PROTECTED');
          expect(result[1]?.state).toBe('HALTED');
          expect(
            s.writes.filter((operation) => operation === 'ENTRY'),
          ).toHaveLength(1);
        }
      }),
  );

  it('cleans up after protection rejection and halts subsequent accounts', () =>
    withSetup(async (s) => {
      s.mock.injectProtectionFault('01', 'STOP_LOSS', 'REJECT');
      const preview = await s.controller.preview(intent, ['01', '02']);
      const result = await s.controller.execute(
        'protection-trade',
        preview.previewId,
      );
      expect(result[0]?.state).not.toBe('PROTECTED');
      expect(result[1]?.state).toBe('HALTED');
      expect((await s.mock.getAccountState('01')).positions).toEqual([]);
      expect(await s.mock.getOpenOrders('01')).toEqual([]);
    }));

  it.each([
    'session',
    'message',
    'operation',
    'stale',
    'future',
    'raw',
    'environment',
    'extra',
    'oversized',
  ] as const)('quarantines a %s response before later requests', (fault) =>
    withSetup(async (s) => {
      const exchange = s.port.exchange;
      s.port.exchange = async (message) => {
        const response = JSON.parse(await exchange(message));
        if (fault === 'session')
          response.sessionId = '00000000-0000-4000-8000-000000000000';
        if (fault === 'message')
          response.messageId = '00000000-0000-4000-8000-000000000000';
        if (fault === 'operation') response.operation = 'LIST_ACCOUNTS';
        if (fault === 'stale') response.capturedAt = NOW - 1;
        if (fault === 'future') response.capturedAt = NOW + 1;
        if (fault === 'environment') response.environment = 'LIVE';
        if (fault === 'extra') response.authorization = 'secret';
        if (fault === 'raw') return 'unparseable secret';
        if (fault === 'oversized')
          return 'x'.repeat(MAX_BRIDGE_MESSAGE_BYTES + 1);
        return JSON.stringify(response);
      };
      await expect(s.adapter.getQuote()).rejects.toThrow(
        'BRIDGE_EXCHANGE_UNCONFIRMED',
      );
      expect(s.adapter.status()).toBe('QUARANTINED');
      const count = s.messages.length;
      await expect(s.adapter.listAccounts()).rejects.toThrow(
        'BRIDGE_UNAVAILABLE',
      );
      expect(s.messages).toHaveLength(count);
      expect(s.journal.halted()).toBe(true);
    }),
  );

  it.each(['account', 'request', 'provider-order'] as const)(
    'refuses mismatched %s evidence',
    (fault) =>
      withSetup(async (s) => {
        const exchange = s.port.exchange;
        s.port.exchange = async (message) => {
          const response = JSON.parse(await exchange(message));
          if (fault === 'account' && response.operation === 'ACCOUNT')
            response.result.accountId = '02';
          if (fault === 'request' && response.operation === 'ENTRY')
            response.result.requestId = 'another-entry';
          if (fault === 'provider-order' && response.operation === 'PROTECTION')
            response.result.orderId = 'venue-id-not-client-id';
          return JSON.stringify(response);
        };
        if (fault === 'account')
          await expect(s.adapter.getAccountState('01')).rejects.toThrow(
            'BRIDGE_EVIDENCE_MISMATCH',
          );
        else {
          const preview = await s.controller.preview(intent, ['01', '02']);
          const result = await s.controller.execute(
            'mismatch-trade',
            preview.previewId,
          );
          expect(result[0]?.state).not.toBe('PROTECTED');
          expect(result[1]?.state).toBe('HALTED');
        }
        expect(s.adapter.status()).toBe('QUARANTINED');
      }),
  );

  it('rejects unexpected credentials before serializing or dispatching a command', () =>
    withSetup(async (s) => {
      const order = await request(s);
      const count = s.messages.length;
      await expect(
        s.adapter.placeOrder({
          ...order,
          authorization: 'secret',
        } as OrderRequest),
      ).rejects.toThrow('INVALID_BRIDGE_COMMAND');
      await expect(
        s.adapter.placeOrder({
          ...order,
          config: { ...config, token: 'secret' },
        } as OrderRequest),
      ).rejects.toThrow('INVALID_BRIDGE_COMMAND');
      expect(s.messages).toHaveLength(count);
      expect(s.writes).toEqual([]);
      expect(s.messages.join('')).not.toContain('secret');
    }));

  it('cannot reconnect a closed bridge', () =>
    withSetup(async (s) => {
      await s.adapter.disconnect();
      await expect(s.adapter.connect()).rejects.toThrow('BRIDGE_UNAVAILABLE');
    }));

  it('does not refresh stale account or quote timestamps from a fresh capture', () =>
    withSetup(async (s) => {
      s.advance(config.maxDataAgeMs + 1);
      const preview = await s.controller.preview(intent, ['01']);
      expect(preview.orders[0]?.approved).toBe(false);
      expect(preview.orders[0]?.reasons).toEqual(
        expect.arrayContaining(['STALE_ACCOUNT', 'STALE_QUOTE']),
      );
      const result = await s.controller.execute(
        'stale-trade',
        preview.previewId,
      );
      expect(result[0]?.state).toBe('REJECTED');
      expect(s.writes).toEqual([]);
    }));

  it('refuses a session that expires during an exchange without leaking its error', () =>
    withSetup(async (s) => {
      s.port.exchange = async () => {
        throw new Error('Authorization: Bearer private-session-secret');
      };
      await expect(s.adapter.getAccountState('01')).rejects.toThrow(
        'BRIDGE_EXCHANGE_UNCONFIRMED',
      );
      expect(s.adapter.status()).toBe('QUARANTINED');
      expect(s.journal.halted()).toBe(true);
      expect(s.writes).toEqual([]);
    }));

  it('never becomes connected after a handshake times out and completes late', async () => {
    const journal = new Journal();
    const mock = new MockVestAdapter(config, () => NOW);
    await mock.connect();
    const fixture = offlineBridge(mock, () => NOW);
    const exchange = fixture.port.exchange;
    let release: (() => void) | undefined;
    fixture.port.exchange = async (message) => {
      const response = await exchange(message);
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return response;
    };
    const adapter = new OfflineBridgeExecutionAdapter(
      fixture.port,
      journal,
      { timeoutMs: 10 },
      () => NOW,
    );
    try {
      await expect(adapter.connect()).rejects.toThrow(
        'BRIDGE_EXCHANGE_UNCONFIRMED',
      );
      release?.();
      await Promise.resolve();
      expect(adapter.status()).toBe('QUARANTINED');
      await expect(adapter.connect()).rejects.toThrow('BRIDGE_UNAVAILABLE');
    } finally {
      await adapter.disconnect();
      journal.close();
    }
  });

  it('rejects a live transport even if it implements the fixture interface', () => {
    const journal = new Journal();
    try {
      expect(
        () =>
          new OfflineBridgeExecutionAdapter(
            { environment: 'LIVE' } as unknown as OfflineBridgePort,
            journal,
          ),
      ).toThrow('LIVE_BRIDGE_DISABLED');
    } finally {
      journal.close();
    }
  });
});
