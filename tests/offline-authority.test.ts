import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  FleetController,
  type FleetPreview,
} from '../packages/execution/src/controller.ts';
import {
  OfflineDispatchAuthorizer,
  offlinePolicyHash,
  type OfflineGeneration,
} from '../packages/execution/src/offline-authority.ts';
import { config, intent, setup } from './helpers.ts';
import type { Account, ProtectionOrder } from '../packages/core/src/index.ts';
import type { ChildResult } from '../packages/execution/src/adapter.ts';

const generation = (): OfflineGeneration => ({
  environment: 'OFFLINE_FIXTURE',
  evidence: 'SYNTHETIC',
  ownerGeneration: randomUUID(),
  controllerGeneration: randomUUID(),
  browserGeneration: randomUUID(),
});
async function fixture() {
  const s = await setup();
  const identity = generation();
  const authority = new OfflineDispatchAuthorizer(identity, s.clock);
  const controller = new FleetController(
    s.adapter,
    config,
    s.journal,
    s.clock,
    50,
    authority,
  );
  return { ...s, identity, authority, controller };
}
function arm(
  s: Awaited<ReturnType<typeof fixture>>,
  p: FleetPreview,
  ttl = 1000,
) {
  s.authority.arm({
    generation: s.identity,
    previewId: p.previewId,
    policyHash: offlinePolicyHash(config),
    intent: p.intent,
    accounts: p.orders.map((o) => ({
      accountId: o.accountId,
      quantityCeiling: o.quantity,
      lossCeiling: o.totalPlannedLoss,
    })),
    issuedAt: s.clock(),
    expiresAt: s.clock() + ttl,
  });
}

describe('synthetic offline dispatch authorization', () => {
  it('permits reads while locked and refuses entry before dispatch with a durable rejected result', async () => {
    const s = await fixture();
    try {
      const place = vi.spyOn(s.adapter, 'placeOrder');
      const p = await s.controller.preview(intent, ['01']);
      expect(s.authority.status()).toBe('LOCKED');
      const results = await s.controller.execute('locked', p.previewId);
      expect(results[0]!.status).toBe('REJECTED');
      expect(results[0]!.state).toBe('REJECTED');
      expect(place).not.toHaveBeenCalled();
      expect(s.journal.allChildren()[0]!.status).toBe('REJECTED');
      expect(s.controller.health().state).toBe('HALTED');
    } finally {
      s.journal.close();
    }
  });
  it('executes a sequential two-account flow including verified protection and duplicate suppression', async () => {
    const s = await fixture();
    try {
      const p = await s.controller.preview(intent, ['01', '02']);
      arm(s, p);
      const place = vi.spyOn(s.adapter, 'placeOrder');
      const results = await s.controller.execute('armed', p.previewId);
      expect(results.map((r) => r.state)).toEqual(['PROTECTED', 'PROTECTED']);
      await s.controller.execute('armed', p.previewId);
      expect(place).toHaveBeenCalledTimes(2);
      expect((await s.controller.flattenAll()).map((r) => r.status)).toEqual([
        'FLAT',
        'FLAT',
        ...Array(8).fill('UNKNOWN'),
      ]);
    } finally {
      s.journal.close();
    }
  });
  it('expiry after a confirmed fill permits its protection but refuses the next account', async () => {
    const s = await fixture();
    try {
      const p = await s.controller.preview(intent, ['01', '02']);
      arm(s, p, 10);
      const original = s.adapter.placeOrder.bind(s.adapter);
      vi.spyOn(s.adapter, 'placeOrder').mockImplementation(async (req) => {
        const result = await original(req);
        s.advance(11);
        return result;
      });
      const results = await s.controller.execute('expires', p.previewId);
      expect(results.map((r) => r.status)).toEqual(['FILLED', 'REJECTED']);
      expect(results[0]!.state).toBe('PROTECTED');
      expect(s.authority.status()).toBe('RECOVERY_ONLY');
      expect((await s.adapter.getAccountState('02')).positions).toHaveLength(0);
    } finally {
      s.journal.close();
    }
  });
  it('revoked entries still permit existing protection and owned emergency recovery', async () => {
    const s = await fixture();
    try {
      const p = await s.controller.preview(intent, ['01']);
      arm(s, p);
      const original = s.adapter.placeOrder.bind(s.adapter);
      vi.spyOn(s.adapter, 'placeOrder').mockImplementation(async (req) => {
        const result = await original(req);
        s.authority.revokeEntries();
        return result;
      });
      expect(
        (await s.controller.execute('revoke', p.previewId))[0]!.state,
      ).toBe('PROTECTED');
      expect((await s.controller.flattenAll())[0]!.status).toBe('FLAT');
    } finally {
      s.journal.close();
    }
  });
  it('identity uncertainty after entry forbids protection and cleanup, retaining UNKNOWN', async () => {
    const s = await fixture();
    try {
      const p = await s.controller.preview(intent, ['01']);
      arm(s, p);
      const original = s.adapter.placeOrder.bind(s.adapter);
      vi.spyOn(s.adapter, 'placeOrder').mockImplementation(async (req) => {
        const result = await original(req);
        s.authority.invalidateIdentity();
        return result;
      });
      const protection = vi.spyOn(s.adapter, 'placeProtectionOrder');
      const flatten = vi.spyOn(s.adapter, 'flattenAccount');
      const result = (await s.controller.execute('identity', p.previewId))[0]!;
      expect(result.status).toBe('UNKNOWN');
      expect(result.cleanupStatus).toBe('UNKNOWN');
      expect(protection).not.toHaveBeenCalled();
      expect(flatten).not.toHaveBeenCalled();
      expect(s.authority.status()).toBe('LOCKED');
    } finally {
      s.journal.close();
    }
  });
  it('a new authority starts locked even with the same generation and existing journal', async () => {
    const s = await fixture();
    try {
      const p = await s.controller.preview(intent, ['01']);
      arm(s, p);
      await s.controller.execute('before-restart', p.previewId);
      const fresh = new OfflineDispatchAuthorizer(s.identity, s.clock);
      const restarted = new FleetController(
        s.adapter,
        config,
        s.journal,
        s.clock,
        50,
        fresh,
      );
      const flatten = vi.spyOn(s.adapter, 'flattenAccount');
      expect((await restarted.flattenAll())[0]!.status).toBe('UNKNOWN');
      expect(flatten).not.toHaveBeenCalled();
      expect(fresh.status()).toBe('LOCKED');
    } finally {
      s.journal.close();
    }
  });
  it.each([
    'preview',
    'policy',
    'side',
    'quantity',
    'risk',
    'account',
  ] as const)('rejects %s scope mismatch', async (mismatch) => {
    const s = await fixture();
    try {
      const p = await s.controller.preview(intent, ['01']);
      arm(s, p);
      const request = {
        requestId: 'synthetic',
        masterTradeId: 'synthetic',
        accountId: '01',
        intent: p.intent,
        preview: p.orders[0]!,
        quote: p.quote,
        config,
      };
      const changed = structuredClone(request);
      if (mismatch === 'policy') changed.config.maxPriceMovePoints = '999';
      if (mismatch === 'side') changed.intent.side = 'SHORT';
      if (mismatch === 'quantity') changed.preview.quantity = '999999';
      if (mismatch === 'risk') changed.preview.totalPlannedLoss = '999999';
      if (mismatch === 'account') changed.accountId = '02';
      expect(() =>
        s.authority.assertEntry(
          changed,
          mismatch === 'preview' ? 'a'.repeat(64) : p.previewId,
        ),
      ).toThrow();
    } finally {
      s.journal.close();
    }
  });
  it('rejects invalid generation, unbounded lifetime, and unexpected arm properties', async () => {
    const s = await fixture();
    try {
      const p = await s.controller.preview(intent, ['01']);
      const value = {
        generation: s.identity,
        previewId: p.previewId,
        policyHash: offlinePolicyHash(config),
        intent,
        accounts: [{ accountId: '01', quantityCeiling: '1', lossCeiling: '1' }],
        issuedAt: s.clock(),
        expiresAt: s.clock() + 1000,
      };
      expect(() =>
        s.authority.arm({ ...value, generation: generation() }),
      ).toThrow();
      expect(() =>
        s.authority.arm({ ...value, expiresAt: s.clock() + 60001 }),
      ).toThrow();
      expect(() =>
        s.authority.arm({ ...value, liveMode: true } as typeof value),
      ).toThrow();
      expect(() =>
        s.authority.arm({
          ...value,
          generation: {
            ...s.identity,
            environment: 'LIVE',
          } as unknown as OfflineGeneration,
        }),
      ).toThrow();
    } finally {
      s.journal.close();
    }
  });
  it('refuses cancellation or flattening of unrelated exposure', async () => {
    const s = await fixture();
    try {
      const p = await s.controller.preview(intent, ['01']);
      arm(s, p);
      await s.controller.execute('owned', p.previewId);
      const account = await s.adapter.getAccountState('01');
      const open = await s.adapter.getOpenOrders('01');
      const children = s.journal.allChildren();
      expect(() =>
        s.authority.assertCancel(
          { ...open[0]!, entryRequestId: 'foreign' },
          children,
        ),
      ).toThrow();
      expect(() =>
        s.authority.assertFlatten(
          {
            ...account,
            positions: [
              { ...account.positions[0]!, entryRequestId: 'foreign' },
            ],
          },
          open,
          children,
        ),
      ).toThrow();
      expect(() => s.authority.assertFlatten(account, open, [])).toThrow();
    } finally {
      s.journal.close();
    }
  });
  it('expiry during revalidation refuses dispatch without claiming an unknown submission', async () => {
    const s = await fixture();
    try {
      const p = await s.controller.preview(intent, ['01']);
      arm(s, p, 10);
      const original = s.adapter.getQuote.bind(s.adapter);
      vi.spyOn(s.adapter, 'getQuote').mockImplementation(async () => {
        const q = await original();
        s.advance(11);
        return q;
      });
      const place = vi.spyOn(s.adapter, 'placeOrder');
      const result = (
        await s.controller.execute('late-validation', p.previewId)
      )[0]!;
      expect(result.status).toBe('REJECTED');
      expect(place).not.toHaveBeenCalled();
    } finally {
      s.journal.close();
    }
  });
  it.each(['STOP_LOSS', 'TAKE_PROFIT'] as const)(
    'failed %s permits confirmed owned exposure cleanup while halting later accounts',
    async (type) => {
      const s = await fixture();
      try {
        const p = await s.controller.preview(intent, ['01', '02']);
        arm(s, p);
        s.adapter.injectProtectionFault('01', type, 'REJECT');
        const result = await s.controller.execute(
          'failed-protection',
          p.previewId,
        );
        expect(result[0]!.cleanupStatus).toBe('FLAT');
        expect(result[0]!.status).toBe('UNKNOWN');
        expect((await s.adapter.getAccountState('02')).positions).toHaveLength(
          0,
        );
      } finally {
        s.journal.close();
      }
    },
  );
  it('clock rollback invalidates both entry and recovery authority', async () => {
    const s = await fixture();
    try {
      const p = await s.controller.preview(intent, ['01']);
      arm(s, p);
      await s.controller.execute('clock', p.previewId);
      s.advance(-1);
      expect(s.authority.status()).toBe('LOCKED');
      expect((await s.controller.flattenAll())[0]!.status).toBe('UNKNOWN');
    } finally {
      s.journal.close();
    }
  });
  it('rejects protection with an altered master identity and refuses historical fill grants', async () => {
    const s = await fixture();
    try {
      const p = await s.controller.preview(intent, ['01']);
      arm(s, p);
      await s.controller.execute('master-bound', p.previewId);
      const [order] = await s.adapter.getOpenOrders('01');
      const request = {
        requestId: order!.requestId,
        masterTradeId: order!.masterTradeId,
        accountId: order!.accountId,
        entryRequestId: order!.entryRequestId,
        symbol: order!.symbol,
        positionSide: order!.positionSide,
        quantity: order!.quantity,
        type: order!.type,
        triggerPrice: order!.triggerPrice,
        reduceOnly: order!.reduceOnly,
      };
      expect(() =>
        s.authority.assertProtection({
          ...request,
          masterTradeId: 'another-master',
        }),
      ).toThrow();
      expect(() =>
        s.authority.assertCancel(
          { ...order!, masterTradeId: 'another-master' },
          s.journal.allChildren(),
        ),
      ).toThrow();
      const fresh = new OfflineDispatchAuthorizer(s.identity, s.clock);
      fresh.arm({
        generation: s.identity,
        previewId: p.previewId,
        policyHash: offlinePolicyHash(config),
        intent,
        accounts: [
          {
            accountId: '01',
            quantityCeiling: p.orders[0]!.quantity,
            lossCeiling: p.orders[0]!.totalPlannedLoss,
          },
        ],
        issuedAt: s.clock(),
        expiresAt: s.clock() + 1000,
      });
      const child = s.journal.allChildren()[0]!;
      const account = await s.adapter.getAccountState('01');
      const ledger = await s.adapter.getOrder(child.requestId);
      expect(() => fresh.recordConfirmedFill(child, account, ledger!)).toThrow(
        'OFFLINE_FILL_NOT_AUTHORIZED',
      );
      expect(() => fresh.assertFlatten(account, [], [child])).toThrow();
    } finally {
      s.journal.close();
    }
  });
  it('revocation during awaited account verification prevents the actual controller dispatch', async () => {
    const s = await fixture();
    try {
      const p = await s.controller.preview(intent, ['01']);
      arm(s, p);
      const original = s.adapter.getAccountState.bind(s.adapter);
      vi.spyOn(s.adapter, 'getAccountState').mockImplementation(async (id) => {
        const value = await original(id);
        s.authority.revokeEntries();
        return value;
      });
      const place = vi.spyOn(s.adapter, 'placeOrder');
      expect(
        (await s.controller.execute('async-revocation', p.previewId))[0]!
          .status,
      ).toBe('REJECTED');
      expect(place).not.toHaveBeenCalled();
    } finally {
      s.journal.close();
    }
  });
  it('stale account identity evidence invalidates both authorities before submission', async () => {
    const s = await fixture();
    try {
      const p = await s.controller.preview(intent, ['01']);
      arm(s, p);
      const original = s.adapter.getAccountState.bind(s.adapter);
      vi.spyOn(s.adapter, 'getAccountState').mockImplementation(async (id) => ({
        ...(await original(id)),
        lastSyncTimestamp: s.clock() - config.maxDataAgeMs - 1,
      }));
      const place = vi.spyOn(s.adapter, 'placeOrder');
      expect(
        (await s.controller.execute('stale-evidence', p.previewId))[0]!.status,
      ).toBe('REJECTED');
      expect(s.authority.status()).toBe('LOCKED');
      expect(place).not.toHaveBeenCalled();
    } finally {
      s.journal.close();
    }
  });
  it('a computed fill loss exceeding its grant refuses protection but permits owned cleanup', async () => {
    const s = await fixture();
    try {
      const p = await s.controller.preview(intent, ['01']);
      arm(s, p);
      const record = s.authority.recordConfirmedFill.bind(s.authority);
      vi.spyOn(s.authority, 'recordConfirmedFill').mockImplementation(
        (child, account, ledger) =>
          record({ ...child, actualPlannedLoss: '999999' }, account, ledger),
      );
      const protection = vi.spyOn(s.adapter, 'placeProtectionOrder');
      const flatten = vi.spyOn(s.adapter, 'flattenAccount');
      const result = (
        await s.controller.execute('risk-ceiling', p.previewId)
      )[0]!;
      expect(protection).not.toHaveBeenCalled();
      expect(flatten).toHaveBeenCalledExactlyOnceWith('01');
      expect(result.status).toBe('UNKNOWN');
      expect(result.cleanupStatus).toBe('FLAT');
    } finally {
      s.journal.close();
    }
  });
  it('ledger lookup delay cannot dispatch flatten using an aged account snapshot', async () => {
    const s = await fixture();
    try {
      const p = await s.controller.preview(intent, ['01']);
      arm(s, p);
      await s.controller.execute('flatten-freshness', p.previewId);
      const original = s.adapter.getOrder.bind(s.adapter);
      vi.spyOn(s.adapter, 'getOrder').mockImplementation(async (id) => {
        const result = await original(id);
        s.advance(config.maxDataAgeMs + 1);
        return result;
      });
      const flatten = vi.spyOn(s.adapter, 'flattenAccount');
      expect((await s.controller.flattenAll())[0]!.status).toBe('UNKNOWN');
      expect(flatten).not.toHaveBeenCalled();
      expect(s.authority.status()).toBe('LOCKED');
    } finally {
      s.journal.close();
    }
  });
  it('stale orphan evidence never dispatches cancellation', async () => {
    const s = await fixture();
    try {
      const p = await s.controller.preview(intent, ['01']);
      arm(s, p);
      await s.controller.execute('orphan-freshness', p.previewId);
      const original = s.adapter.getAccountState.bind(s.adapter);
      vi.spyOn(s.adapter, 'getAccountState').mockImplementation(async (id) => ({
        ...(await original(id)),
        positions: [],
        lastSyncTimestamp: s.clock() - config.maxDataAgeMs - 1,
      }));
      const cancel = vi.spyOn(s.adapter, 'cancelOrder');
      await s.controller.reconcile();
      expect(cancel).not.toHaveBeenCalled();
      expect(s.authority.status()).toBe('LOCKED');
    } finally {
      s.journal.close();
    }
  });
  it('account evidence aging after entry prevents protection and unsafe cleanup', async () => {
    const s = await fixture();
    try {
      const p = await s.controller.preview(intent, ['01']);
      arm(s, p);
      const original = s.adapter.placeOrder.bind(s.adapter);
      vi.spyOn(s.adapter, 'placeOrder').mockImplementation(async (request) => {
        const result = await original(request);
        s.advance(config.maxDataAgeMs + 1);
        return result;
      });
      const protect = vi.spyOn(s.adapter, 'placeProtectionOrder');
      const flatten = vi.spyOn(s.adapter, 'flattenAccount');
      const result = (
        await s.controller.execute('fill-stale', p.previewId)
      )[0]!;
      expect(result.status).toBe('UNKNOWN');
      expect(result.cleanupStatus).toBe('UNKNOWN');
      expect(protect).not.toHaveBeenCalled();
      expect(flatten).not.toHaveBeenCalled();
      expect(s.authority.status()).toBe('LOCKED');
    } finally {
      s.journal.close();
    }
  });
  it('stop verification delay cannot submit the target from stale fill evidence', async () => {
    const s = await fixture();
    try {
      const p = await s.controller.preview(intent, ['01']);
      arm(s, p);
      const original = s.adapter.getProtectionOrder.bind(s.adapter);
      let delayed = false;
      vi.spyOn(s.adapter, 'getProtectionOrder').mockImplementation(
        async (...args) => {
          const result = await original(...args);
          if (!delayed) {
            delayed = true;
            s.advance(config.maxDataAgeMs + 1);
          }
          return result;
        },
      );
      const protect = vi.spyOn(s.adapter, 'placeProtectionOrder');
      const result = (
        await s.controller.execute('stop-delay', p.previewId)
      )[0]!;
      expect(protect).toHaveBeenCalledTimes(1);
      expect(protect.mock.calls[0]![0].type).toBe('STOP_LOSS');
      expect(result.status).toBe('UNKNOWN');
      expect(s.authority.status()).toBe('LOCKED');
    } finally {
      s.journal.close();
    }
  });
  it.each(['identity', 'age'] as const)(
    'rechecks %s after the asynchronous flatten proof returns',
    async (change) => {
      const s = await fixture();
      try {
        const p = await s.controller.preview(intent, ['01']);
        arm(s, p);
        await s.controller.execute('flatten-call-gap', p.previewId);
        const internals = s.controller as unknown as {
          authorizeFlatten: (id: string) => Promise<
            | {
                account: Account;
                open: ProtectionOrder[];
                children: ChildResult[];
              }
            | undefined
          >;
        };
        const original = internals.authorizeFlatten.bind(s.controller);
        vi.spyOn(internals, 'authorizeFlatten').mockImplementation(
          async (id) => {
            const proof = await original(id);
            queueMicrotask(() => {
              if (change === 'identity') s.authority.invalidateIdentity();
              else s.advance(config.maxDataAgeMs + 1);
            });
            return proof;
          },
        );
        const flatten = vi.spyOn(s.adapter, 'flattenAccount');
        expect((await s.controller.flattenAll())[0]!.status).toBe('UNKNOWN');
        expect(flatten).not.toHaveBeenCalled();
        expect(s.authority.status()).toBe('LOCKED');
      } finally {
        s.journal.close();
      }
    },
  );
});
