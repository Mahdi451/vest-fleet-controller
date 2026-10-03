import { describe, expect, it } from 'vitest';
import {
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
