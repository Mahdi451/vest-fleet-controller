import { describe, expect, it, vi } from 'vitest';
import { D } from '../packages/core/src/index.ts';
import {
  ownedMutationRequestSchema,
  ownedMutationReceiptSchema,
  type OwnedMutationRequest,
} from '../packages/execution/src/owned-mutation-contract.ts';
import { MockVestAdapter } from '../packages/simulator/src/index.ts';
import { assessOwnedIncrease } from '../packages/risk-engine/src/owned-increase.ts';
import { config, intent, NOW, setup } from './helpers.ts';

async function fixture() {
  const f = await setup();
  const preview = await f.controller.preview(intent, ['02']);
  await f.controller.execute('mutation-root', preview.previewId);
  const a = await f.adapter.getAccountState('02'),
    p = a.positions[0]!;
  const base = {
    environment: 'OFFLINE_FIXTURE' as const,
    evidence: 'SYNTHETIC' as const,
    requestId: 'a'.repeat(64),
    eventId: 'b'.repeat(64),
    rootKey: 'c'.repeat(64),
    accountId: '02',
    entryRequestId: p.entryRequestId,
    symbol: 'NDX' as const,
    side: p.side,
    sequence: 2,
    expectedRevision: a.revision,
    expectedQuantity: p.quantity,
    expectedBasis: p.entryPrice,
    leverage: p.leverage,
    maxNotional: '100000',
    maxPlannedLoss: '9',
  };
  const request = (operation: OwnedMutationRequest['operation'], extra = {}) =>
    ownedMutationRequestSchema.parse({
      ...base,
      operation,
      ...(operation === 'ADD' || operation === 'REDUCE'
        ? {
            deltaQuantity: new D(p.quantity)
              .div(2)
              .div(config.sizeStep)
              .floor()
              .mul(config.sizeStep)
              .toFixed(),
          }
        : operation === 'STOP_CHANGED'
          ? { price: new D(p.entryPrice).minus(50).toFixed() }
          : operation === 'TARGET_CHANGED'
            ? { price: new D(p.entryPrice).plus(100).toFixed() }
            : {}),
      ...extra,
    });
  return { ...f, base, request };
}
describe('atomic synthetic owned mutations', () => {
  it('legacy owned flatten and protection repair refuse an unresolved mutation without effects', async () => {
    const f = await fixture();
    try {
      const req = f.request('ADD') as OwnedMutationRequest & {
        operation: 'ADD';
      };
      f.adapter.injectOwnedMutationFault('02', 'UNKNOWN_BEFORE');
      expect((await f.adapter.addOwnedPosition(req)).status).toBe('UNKNOWN');
      const before = await f.adapter.getAccountState('02'),
        orders = await f.adapter.getOpenOrders('02');
      const close = vi.spyOn(f.adapter, 'flattenAccount'),
        protect = vi.spyOn(f.adapter, 'placeProtectionOrder');
      await expect(
        f.adapter.flattenOwnedPosition({
          accountId: '02',
          entryRequestId: req.entryRequestId,
          expectedRevision: before.revision,
        }),
      ).rejects.toThrow('OWNED_MUTATION_REFUSED');
      const original = orders[0]!;
      await expect(
        f.adapter.repairOwnedProtection(
          {
            requestId: original.requestId,
            masterTradeId: original.masterTradeId,
            entryRequestId: original.entryRequestId,
            accountId: original.accountId,
            symbol: original.symbol,
            positionSide: original.positionSide,
            quantity: original.quantity,
            type: original.type,
            triggerPrice: original.triggerPrice,
            reduceOnly: true,
          },
          before.revision,
        ),
      ).rejects.toThrow('OWNED_MUTATION_REFUSED');
      expect(close).not.toHaveBeenCalled();
      expect(protect).not.toHaveBeenCalled();
      expect(await f.adapter.getAccountState('02')).toEqual(before);
      expect(await f.adapter.getOpenOrders('02')).toEqual(orders);
    } finally {
      f.journal.close();
    }
  });
  it('receipt schemas enforce numeric zero, rejection immutability and positive partial reductions', async () => {
    const f = await fixture();
    try {
      f.adapter.injectOwnedMutationFault('02', 'REJECT');
      const rejected = await f.adapter.closeOwnedPosition(
        f.request('CLOSE') as OwnedMutationRequest & { operation: 'CLOSE' },
      );
      expect(ownedMutationReceiptSchema.safeParse(rejected).success).toBe(true);
      for (const changed of [
        { ...rejected, fees: '0.1' },
        { ...rejected, executedQuantity: '0.1' },
        {
          ...rejected,
          after: { ...rejected.after, revision: rejected.after.revision + 1 },
        },
        { ...rejected, after: { ...rejected.after, basis: '1' } },
        {
          ...rejected,
          after: { ...rejected.after, quantity: '0.0', basis: '1' },
        },
        { ...rejected, before: { ...rejected.before, basis: null } },
        {
          ...rejected,
          status: 'PARTIAL',
          operation: 'ADD',
          executedQuantity: '0.1',
        },
        {
          ...rejected,
          status: 'PARTIAL',
          operation: 'REDUCE',
          executedQuantity: '0.0',
        },
      ])
        expect(ownedMutationReceiptSchema.safeParse(changed).success).toBe(
          false,
        );
      const closed = await f.adapter.closeOwnedPosition(
        f.request('CLOSE', {
          requestId: 'd'.repeat(64),
          sequence: 3,
        }) as OwnedMutationRequest & { operation: 'CLOSE' },
      );
      expect(
        ownedMutationReceiptSchema.safeParse({
          ...closed,
          after: { ...closed.after, quantity: '0.0' },
        }).success,
      ).toBe(true);
    } finally {
      f.journal.close();
    }
  });
  it('creates a missing stop only from authoritative canceled state using the stable ID', async () => {
    const f = await fixture();
    try {
      const old = (await f.adapter.getOpenOrders('02')).find(
        (o) => o.type === 'STOP_LOSS',
      )!;
      await f.adapter.cancelOrder('02', old.orderId);
      const state = await f.adapter.getAccountState('02');
      const receipt = await f.adapter.changeOwnedProtection(
        f.request('STOP_CHANGED', {
          expectedRevision: state.revision,
        }) as OwnedMutationRequest & { operation: 'STOP_CHANGED' },
      );
      expect(receipt.status).toBe('VERIFIED');
      expect(receipt.stop?.orderId).toBe(old.orderId);
      expect(
        (await f.adapter.getOpenOrders('02')).filter(
          (o) => o.type === 'STOP_LOSS',
        ),
      ).toHaveLength(1);
    } finally {
      f.journal.close();
    }
  });
  it('rejects stale evidence and a widening stop without changing existing protection', async () => {
    const f = await fixture();
    try {
      const before = await f.adapter.getOpenOrders('02');
      const widening = await f.adapter.changeOwnedProtection(
        f.request('STOP_CHANGED', {
          price: '30000',
        }) as OwnedMutationRequest & { operation: 'STOP_CHANGED' },
      );
      expect(widening.reason).toBe('RISK_LIMIT');
      expect(await f.adapter.getOpenOrders('02')).toEqual(before);
      f.advance(config.maxDataAgeMs + 1);
      const stale = await f.adapter.closeOwnedPosition(
        f.request('CLOSE', {
          requestId: 'd'.repeat(64),
          sequence: 3,
        }) as OwnedMutationRequest & { operation: 'CLOSE' },
      );
      expect(stale.reason).toBe('STALE_EVIDENCE');
      expect(await f.adapter.getOpenOrders('02')).toEqual(before);
    } finally {
      f.journal.close();
    }
  });
  it('adds aggregate exposure with stable root, weighted basis and resized siblings', async () => {
    const f = await fixture();
    try {
      await f.adapter.updatePrice('30410');
      const current = await f.adapter.getAccountState('02');
      const request = f.request('ADD', {
        expectedRevision: current.revision,
      }) as OwnedMutationRequest & {
        operation: 'ADD';
      };
      const before = await f.adapter.getAccountState('02');
      const result = await f.adapter.addOwnedPosition(request);
      expect(result.status).toBe('VERIFIED');
      expect(result.after.quantity).toBe(
        new D(request.expectedQuantity).plus(request.deltaQuantity).toFixed(),
      );
      expect(result.after.revision).toBeGreaterThan(result.before.revision);
      expect(result.after.basis).toBe(
        new D(request.expectedQuantity)
          .mul(request.expectedBasis)
          .plus(
            new D(request.deltaQuantity).mul(
              new D('30410').plus(config.slippagePointsPerSide),
            ),
          )
          .div(result.after.quantity)
          .toFixed(),
      );
      expect(result.stop?.quantity).toBe(result.after.quantity);
      expect(result.target?.quantity).toBe(result.after.quantity);
      const after = await f.adapter.getAccountState('02');
      expect(after.positions[0]?.entryRequestId).toBe(request.entryRequestId);
      expect(new D(after.balance).lt(before.balance)).toBe(true);
      expect(await f.adapter.addOwnedPosition(request)).toEqual(result);
      expect((await f.adapter.getAccountState('02')).revision).toBe(
        after.revision,
      );
      await expect(
        f.adapter.addOwnedPosition({
          ...request,
          deltaQuantity: config.sizeStep,
        }),
      ).rejects.toThrow('IDEMPOTENCY_CONFLICT');
    } finally {
      f.journal.close();
    }
  });
  it('refuses aggregate arm risk rather than treating the account as flat', async () => {
    const f = await fixture();
    try {
      const a = await f.adapter.getAccountState('02'),
        q = await f.adapter.getQuote(),
        stop = (await f.adapter.getOpenOrders('02')).find(
          (o) => o.type === 'STOP_LOSS',
        )!;
      expect(
        assessOwnedIncrease(
          a,
          q,
          config,
          a.positions[0]!.quantity,
          stop.triggerPrice,
          { maxNotional: '100000', maxPlannedLoss: '0.1' },
          NOW,
        ).approved,
      ).toBe(false);
      const result = await f.adapter.addOwnedPosition(
        f.request('ADD', { maxPlannedLoss: '0.1' }) as OwnedMutationRequest & {
          operation: 'ADD';
        },
      );
      expect(result.reason).toBe('RISK_LIMIT');
      expect(await f.adapter.getAccountState('02')).toEqual(a);
    } finally {
      f.journal.close();
    }
  });
  it.each(['REDUCE', 'CLOSE'] as const)(
    'atomically %s with exact remaining protection',
    async (operation) => {
      const f = await fixture();
      try {
        const req = f.request(operation);
        const result =
          operation === 'CLOSE'
            ? await f.adapter.closeOwnedPosition(
                req as OwnedMutationRequest & { operation: 'CLOSE' },
              )
            : await f.adapter.reduceOwnedPosition(
                req as OwnedMutationRequest & { operation: 'REDUCE' },
              );
        expect(result.status).toBe('VERIFIED');
        if (operation === 'CLOSE') {
          expect(result.after).toMatchObject({ quantity: '0', basis: null });
          expect(result.stop).toBeNull();
          expect(result.target).toBeNull();
          expect(result.protection.every((o) => o.status === 'CANCELED')).toBe(
            true,
          );
        } else {
          expect(result.after.quantity).toBe(
            new D(req.expectedQuantity)
              .minus(result.executedQuantity)
              .toFixed(),
          );
          expect(result.stop?.quantity).toBe(result.after.quantity);
          expect(result.target?.quantity).toBe(result.after.quantity);
        }
      } finally {
        f.journal.close();
      }
    },
  );
  it('records a terminal partial reduction without a late remainder', async () => {
    const f = await fixture();
    try {
      f.adapter.injectOwnedMutationFault('02', 'PARTIAL_REDUCE');
      const req = f.request('REDUCE') as OwnedMutationRequest & {
        operation: 'REDUCE';
      };
      const result = await f.adapter.reduceOwnedPosition(req);
      expect(result.status).toBe('PARTIAL');
      expect(result.noFutureExecution).toBe(true);
      expect(new D(result.executedQuantity).lt(req.deltaQuantity)).toBe(true);
      expect(result.stop?.quantity).toBe(result.after.quantity);
    } finally {
      f.journal.close();
    }
  });
  it.each(['STOP_CHANGED', 'TARGET_CHANGED'] as const)(
    'amends %s preserving stable owned order identity',
    async (operation) => {
      const f = await fixture();
      try {
        const req = f.request(operation) as OwnedMutationRequest & {
          operation: 'STOP_CHANGED' | 'TARGET_CHANGED';
        };
        const before = await f.adapter.getOpenOrders('02');
        const result = await f.adapter.changeOwnedProtection(req);
        expect(result.status).toBe('VERIFIED');
        const type = operation === 'STOP_CHANGED' ? 'STOP_LOSS' : 'TAKE_PROFIT';
        const changed = result.protection.find((o) => o.type === type)!;
        expect(changed.orderId).toBe(
          before.find((o) => o.type === type)!.orderId,
        );
        expect(changed.triggerPrice).toBe(req.price);
        expect(changed.quantity).toBe(req.expectedQuantity);
      } finally {
        f.journal.close();
      }
    },
  );
  it('rejects crossed stop prices without canceling the existing stop', async () => {
    const f = await fixture();
    try {
      const before = await f.adapter.getOpenOrders('02');
      const result = await f.adapter.changeOwnedProtection(
        f.request('STOP_CHANGED', {
          price: '30500',
        }) as OwnedMutationRequest & { operation: 'STOP_CHANGED' },
      );
      expect(result.reason).toBe('INVALID_PROTECTION');
      expect(await f.adapter.getOpenOrders('02')).toEqual(before);
    } finally {
      f.journal.close();
    }
  });
  it.each([
    'expectedRevision',
    'entryRequestId',
    'expectedQuantity',
    'expectedBasis',
  ] as const)('rejects changed %s before effects', async (field) => {
    const f = await fixture();
    try {
      const before = await f.adapter.getAccountState('02');
      const value =
        field === 'expectedRevision'
          ? before.revision + 1
          : field === 'entryRequestId'
            ? 'foreign'
            : '99999';
      const result = await f.adapter.closeOwnedPosition(
        f.request('CLOSE', { [field]: value }) as OwnedMutationRequest & {
          operation: 'CLOSE';
        },
      );
      expect(result.status).toBe('REJECTED');
      expect(await f.adapter.getAccountState('02')).toEqual(before);
    } finally {
      f.journal.close();
    }
  });
  it('persists lost-ack terminal receipt and exact replay across snapshot restore', async () => {
    const f = await fixture();
    try {
      const req = f.request('ADD') as OwnedMutationRequest & {
        operation: 'ADD';
      };
      f.adapter.injectOwnedMutationFault('02', 'UNKNOWN_AFTER');
      const response = await f.adapter.addOwnedPosition(req);
      expect(response.status).toBe('UNKNOWN');
      const saved = f.adapter.exportSnapshot();
      const restored = new MockVestAdapter(
        config,
        f.clock,
        undefined,
        '30400',
        undefined,
        undefined,
        saved,
      );
      await restored.connect();
      const terminal = await restored.readOwnedMutation(req.requestId);
      expect(terminal?.status).toBe('VERIFIED');
      expect(await restored.addOwnedPosition(req)).toEqual(terminal);
      expect(
        (await restored.getAccountState('02')).positions[0]?.quantity,
      ).toBe(terminal?.after.quantity);
    } finally {
      f.journal.close();
    }
  });
  it('unknown-before remains unresolved and blocks another root mutation', async () => {
    const f = await fixture();
    try {
      const before = await f.adapter.getAccountState('02');
      const req = f.request('CLOSE') as OwnedMutationRequest & {
        operation: 'CLOSE';
      };
      f.adapter.injectOwnedMutationFault('02', 'UNKNOWN_BEFORE');
      const result = await f.adapter.closeOwnedPosition(req);
      expect(result.status).toBe('UNKNOWN');
      expect(result.noFutureExecution).toBe(false);
      expect(await f.adapter.readOwnedMutation(req.requestId)).toEqual(result);
      const next = await f.adapter.closeOwnedPosition({
        ...req,
        requestId: 'd'.repeat(64),
        sequence: 3,
      });
      expect(next.status).toBe('REJECTED');
      expect(await f.adapter.getAccountState('02')).toEqual(before);
    } finally {
      f.journal.close();
    }
  });
  it('old snapshots without mutation receipts retain compatibility', async () => {
    const f = await fixture();
    try {
      const saved = f.adapter.exportSnapshot();
      const legacy: Record<string, unknown> = { ...saved };
      delete legacy.ownedMutations;
      const restored = new MockVestAdapter(
        config,
        f.clock,
        undefined,
        '30400',
        undefined,
        undefined,
        legacy,
      );
      await restored.connect();
      expect(await restored.readOwnedMutation('f'.repeat(64))).toBeNull();
    } finally {
      f.journal.close();
    }
  });
});
