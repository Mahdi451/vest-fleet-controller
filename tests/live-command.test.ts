import { describe, expect, it } from 'vitest';
import {
  leverageChoices,
  observeVestTicket,
  planSequentialCopy,
  previewCompanionCommand,
  reviewAccounts,
  sendCompanionCommand,
} from '../packages/browser-execution/src/live-command.ts';

const now = 1_800_000_000_000;
const entry = {
  action: 'LONG' as const,
  market: 'BTC-PERP',
  accountLabel: 'Account 01',
  size: '0.001',
  leverage: '10',
  stopDistance: '50',
  targetDistance: '80',
};
function ready(label: string, patch: Record<string, unknown> = {}) {
  return {
    accountLabel: label,
    headerLabel: label,
    session: 'AUTHENTICATED' as const,
    observedAt: now,
    hasOpenFill: false,
    protectionProven: false,
    ...patch,
  };
}

describe('companion command with Vest send off', () => {
  it('previews Long, Short, and Flatten without an order click', () => {
    expect(previewCompanionCommand(entry)).toEqual({
      ...entry,
      liveSend: false,
      clicksOrderControls: false,
    });
    expect(previewCompanionCommand({ ...entry, action: 'SHORT' }).action).toBe(
      'SHORT',
    );
    expect(
      previewCompanionCommand({
        action: 'FLATTEN',
        market: 'NQ-PERP',
        accountLabel: 'Account 10',
        size: '1',
        leverage: '10',
      }),
    ).toMatchObject({
      action: 'FLATTEN',
      stopDistance: null,
      targetDistance: null,
      liveSend: false,
      clicksOrderControls: false,
    });
  });

  it('requires a stop and target before a live entry can even be described as sendable', () => {
    const { stopDistance, ...withoutStop } = entry;
    expect(() => previewCompanionCommand(withoutStop)).toThrow();
    expect(stopDistance).toBe('50');
  });

  it('refuses to send', () => {
    expect(sendCompanionCommand).toThrow('LIVE_SEND_DISABLED');
  });

  it('stops the remaining accounts on login loss, the wrong header, stale data, or unproven protection', () => {
    const reviewed = reviewAccounts(
      [
        ready('Account 01'),
        ready('Account 02', { session: 'LOGIN_REQUIRED' }),
        ready('Account 03'),
      ],
      now,
      5000,
    );
    expect(reviewed.halted).toBe(true);
    expect(reviewed.accounts.map((account) => account.status)).toEqual([
      'CLEAR',
      'LOGIN_LOSS',
      'STOPPED_AFTER_HALT',
    ]);

    expect(
      reviewAccounts(
        [ready('Account 04', { headerLabel: 'Account 05' })],
        now,
        5000,
      ).accounts[0]?.status,
    ).toBe('WRONG_ACCOUNT');
    expect(
      reviewAccounts([ready('Account 06', { session: 'UNKNOWN' })], now, 5000)
        .accounts[0]?.status,
    ).toBe('LOGIN_LOSS');
    expect(
      reviewAccounts(
        [ready('Account 07', { observedAt: now - 5001 })],
        now,
        5000,
      ).accounts[0]?.status,
    ).toBe('STALE_DATA');
    expect(
      reviewAccounts(
        [
          ready('Account 08', { hasOpenFill: true, protectionProven: false }),
          ready('Account 09'),
        ],
        now,
        5000,
      ).accounts.map((account) => account.status),
    ).toEqual(['UNPROVEN_PROTECTION', 'STOPPED_AFTER_HALT']);
    expect(
      reviewAccounts(
        [ready('Account 10', { hasOpenFill: true, protectionProven: true })],
        now,
        5000,
      ).halted,
    ).toBe(false);
  });
});

describe('sequential Vest copy plan', () => {
  const copy = {
    action: 'LONG' as const,
    market: 'BTC-PERP',
    accountLabels: ['Account 02'],
    leverage: '1',
    offeredLeverage: ['15x', '1x', '2x', '5x', '8x', 'Change to 1x'],
    percent: '1',
    stopDistance: '0.3',
    targetDistance: '0.3',
    account01Flat: false,
    scope: 'NEXT_ACCOUNT' as const,
  };

  it('blocks a new copy while the Account 01 test is open', () => {
    expect(planSequentialCopy(copy)).toMatchObject({
      simultaneous: false,
      liveSend: false,
      clicksOrderControls: false,
      blockedReason: 'ACCOUNT_01_NOT_FLAT',
      steps: [],
    });
  });

  it('allows one flatten of Account 01, then one protected copy to Account 02', () => {
    expect(
      planSequentialCopy({
        ...copy,
        action: 'FLATTEN',
        accountLabels: ['Account 01'],
      }).steps,
    ).toEqual([
      expect.objectContaining({
        order: 1,
        accountLabel: 'Account 01',
        action: 'FLATTEN',
        waitForProtection: false,
      }),
    ]);
    const next = planSequentialCopy({ ...copy, account01Flat: true });
    expect(next.blockedReason).toBeNull();
    expect(next.steps).toEqual([
      expect.objectContaining({
        order: 1,
        accountLabel: 'Account 02',
        leverage: '1',
        percent: '1',
        waitForProtection: true,
      }),
    ]);
  });

  it('stores the open ticket menu and drops labels that are not leverage', () => {
    expect(
      observeVestTicket({
        market: 'BTC-PERP',
        leverageLabels: ['15x', '1x', '15x', 'Change to 1x', '2x'],
        marketClosed: false,
      }),
    ).toEqual({
      market: 'BTC-PERP',
      choices: ['15', '1', '2'],
      marketClosed: false,
    });
    expect(leverageChoices(['1x', '15x'])).toEqual(['1', '15']);
  });

  it('accepts only the leverage labels the ticket showed', () => {
    expect(planSequentialCopy({ ...copy, leverage: '50' }).blockedReason).toBe(
      'LEVERAGE_NOT_OFFERED',
    );
    expect(
      planSequentialCopy({ ...copy, offeredLeverage: [] }).blockedReason,
    ).toBe('LEVERAGE_UNOBSERVED');
    const oddMenu = ['1x', '3x', '25x', '50x', 'Change to 1x', '24h Change'];
    expect(
      planSequentialCopy({
        ...copy,
        market: 'NQ-PERP',
        leverage: '50',
        offeredLeverage: oddMenu,
        account01Flat: true,
      }).steps[0],
    ).toMatchObject({ market: 'NQ-PERP', leverage: '50' });
    expect(
      planSequentialCopy({
        ...copy,
        market: 'NQ-PERP',
        leverage: '15',
        offeredLeverage: oddMenu,
        account01Flat: true,
      }).blockedReason,
    ).toBe('LEVERAGE_NOT_OFFERED');
    expect(
      planSequentialCopy({
        ...copy,
        market: 'CL-PERP',
        leverage: '3',
        offeredLeverage: oddMenu,
        account01Flat: true,
      }).steps[0],
    ).toMatchObject({ leverage: '3' });
  });

  it('refuses a second account before Account 02 has its own copy', () => {
    expect(
      planSequentialCopy({
        ...copy,
        account01Flat: true,
        accountLabels: ['Account 02', 'Account 03'],
      }).blockedReason,
    ).toBe('FIRST_COPY_IS_ACCOUNT_02');
  });
});
