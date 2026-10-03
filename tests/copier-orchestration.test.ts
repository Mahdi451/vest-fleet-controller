import { describe, expect, it } from 'vitest';
import {
  CopyRunJournal,
  MockCopierAdapter,
  canTransition,
  evaluateSendGate,
  runSequentialCopy,
  transition,
} from '../packages/browser-execution/src/copier/index.ts';
import type { MockScript } from '../packages/browser-execution/src/copier/mock-adapter.ts';

const accounts = ['Account 01', 'Account 02', 'Account 03', 'Account 04'];
function scripts(
  extra: Record<string, MockScript> = {},
): Record<string, MockScript> {
  return {
    'Account 01': { kind: 'protected' },
    'Account 02': { kind: 'protected' },
    'Account 03': { kind: 'protected' },
    'Account 04': { kind: 'protected' },
    ...extra,
  };
}
async function copy(
  labels: readonly string[],
  book: Record<string, MockScript>,
  patch: { side?: 'LONG' | 'SHORT'; symbol?: string } = {},
) {
  const adapter = new MockCopierAdapter(book);
  const journal = new CopyRunJournal();
  const result = await runSequentialCopy(
    {
      runId: 184,
      accounts: labels,
      symbol: patch.symbol ?? 'NQ',
      side: patch.side ?? 'LONG',
      leverage: '50',
      allocation: '25',
      orderValueCap: '150',
      adapter,
    },
    journal,
  );
  return { adapter, journal, result, text: journal.render(result) };
}

describe('copier orchestration', () => {
  it('refuses to submit again from ENTRY_UNKNOWN', () => {
    expect(canTransition('ENTRY_UNKNOWN', 'ENTRY_SUBMITTING')).toBe(false);
    expect(() => transition('ENTRY_UNKNOWN', 'ENTRY_SUBMITTING')).toThrow(
      'ENTRY_UNKNOWN_CANNOT_RESUBMIT',
    );
  });

  it('verifies Account 01, rediscovers it, then copies Account 02 once', async () => {
    const { adapter, result, text } = await copy(
      ['Account 01', 'Account 02'],
      scripts(),
    );
    expect(result.halted).toBe(false);
    expect(result.accounts.map((account) => account.status)).toEqual([
      'VERIFIED',
      'VERIFIED',
    ]);
    expect(
      result.accounts.every(
        (account) => account.positionState === 'OPEN_PROTECTED',
      ),
    ).toBe(true);
    expect(adapter.submitCount('Account 01')).toBe(1);
    expect(adapter.submitCount('Account 02')).toBe(1);
    expect(text).toContain('COPY RUN #184');
    expect(text).toContain('✓ symbol NQ');
    expect(text).toContain('✓ leverage 50x');
    expect(text).toContain('✓ allocation 25%');
    expect(text).toContain('✓ actual fill recorded');
    expect(text).toContain('✓ stop confirmed');
    expect(text).toContain('✓ target confirmed');
    const again = await runSequentialCopy(
      {
        runId: 185,
        accounts: ['Account 01'],
        symbol: 'NQ',
        side: 'LONG',
        leverage: '50',
        allocation: '25',
        orderValueCap: '150',
        adapter,
      },
      new CopyRunJournal(),
    );
    expect(again.accounts[0]).toMatchObject({
      status: 'FAILED',
      failureReason: 'EXISTING_POSITION',
    });
    expect(adapter.submitCount('Account 01')).toBe(1);
  });

  it('stops Account 02 when Account 01 fails, and leaves later accounts unattempted', async () => {
    const first = await copy(
      accounts,
      scripts({ 'Account 01': { kind: 'session-loss' } }),
    );
    expect(first.result.accounts.map((account) => account.status)).toEqual([
      'FAILED',
      'NOT_ATTEMPTED',
      'NOT_ATTEMPTED',
      'NOT_ATTEMPTED',
    ]);
    expect(first.result.haltReason).toBe('LOGIN_LOSS');
    expect(first.adapter.submitCount('Account 01')).toBe(0);
    const second = await copy(
      accounts,
      scripts({
        'Account 02': { kind: 'wrong-account', observed: 'Account 01' },
      }),
    );
    expect(
      second.result.accounts.map((account) => [
        account.accountLabel,
        account.status,
      ]),
    ).toEqual([
      ['Account 01', 'VERIFIED'],
      ['Account 02', 'FAILED'],
      ['Account 03', 'NOT_ATTEMPTED'],
      ['Account 04', 'NOT_ATTEMPTED'],
    ]);
    expect(second.result.accounts[1]?.failureReason).toBe(
      'FAILED_WRONG_HEADER',
    );
    expect(second.text).toContain('✗ expected Account 02');
    expect(second.text).toContain('✗ observed Account 01');
    expect(second.text).toContain('NOT ATTEMPTED');
    expect(second.adapter.submitCount('Account 02')).toBe(0);
    expect(second.adapter.submitCount('Account 03')).toBe(0);
  });

  it('reconciles an unknown entry once and halts when it stays ambiguous', async () => {
    const recovered = await copy(
      ['Account 01', 'Account 02'],
      scripts({ 'Account 01': { kind: 'unknown-then-filled' } }),
    );
    expect(recovered.result.accounts[0]?.status).toBe('VERIFIED');
    expect(recovered.adapter.submitCount('Account 01')).toBe(1);
    const ambiguous = await copy(
      ['Account 01', 'Account 02'],
      scripts({ 'Account 01': { kind: 'unknown-ambiguous' } }),
    );
    expect(ambiguous.result.accounts.map((account) => account.status)).toEqual([
      'FAILED',
      'NOT_ATTEMPTED',
    ]);
    expect(ambiguous.result.haltReason).toBe('AMBIGUOUS_ENTRY');
    expect(ambiguous.adapter.submitCount('Account 01')).toBe(1);
  });

  it('halts an unprotected fill, a bad header, a hedge, and a lost session', async () => {
    const naked = await copy(
      ['Account 01', 'Account 02'],
      scripts({ 'Account 01': { kind: 'missing-stop' } }),
    );
    expect(naked.result.haltReason).toBe('UNPROTECTED');
    expect(naked.result.accounts[1]?.status).toBe('NOT_ATTEMPTED');
    expect(naked.adapter.submitCount('Account 01')).toBe(1);
    const header = await copy(
      ['Account 02', 'Account 03'],
      scripts({
        'Account 02': { kind: 'wrong-account', observed: 'Account 01' },
      }),
    );
    expect(header.result.accounts[0]?.failureReason).toBe(
      'FAILED_WRONG_HEADER',
    );
    expect(header.result.accounts[1]?.status).toBe('NOT_ATTEMPTED');
    const hedge = await copy(
      ['Account 02', 'Account 03'],
      scripts({
        'Account 02': {
          kind: 'opposing-position',
          symbol: 'NQ',
          side: 'SHORT',
        },
      }),
    );
    expect(hedge.result.haltReason).toBe('HEDGE_GUARD');
    expect(hedge.adapter.submitCount('Account 02')).toBe(0);
    expect(hedge.result.accounts[1]?.status).toBe('NOT_ATTEMPTED');
    const disabled = await copy(['Account 02'], {
      'Account 02': {
        kind: 'opposing-position',
        symbol: 'NQ',
        side: 'SHORT',
        enabled: false,
      },
    });
    expect(disabled.result.accounts[0]?.status).toBe('VERIFIED');
    const session = await copy(
      ['Account 01'],
      scripts({ 'Account 01': { kind: 'session-loss' } }),
    );
    expect(session.result.haltReason).toBe('LOGIN_LOSS');
  });

  it('rejects leverage, size, stale pages, and a flatten that does not prove flat', async () => {
    const leverage = await copy(
      ['Account 01'],
      scripts({ 'Account 01': { kind: 'leverage-mismatch', observed: '15' } }),
    );
    expect(leverage.result.haltReason).toBe('LEVERAGE_NOT_CONFIRMED');
    const size = await copy(
      ['Account 01'],
      scripts({ 'Account 01': { kind: 'size-rejected' } }),
    );
    expect(size.result.haltReason).toBe('SIZE_NOT_CONFIRMED');
    const stale = await copy(
      ['Account 01'],
      scripts({ 'Account 01': { kind: 'stale-header' } }),
    );
    expect(stale.result.haltReason).toBe('STALE_BROWSER');
    const open = await copy(
      ['Account 01'],
      scripts({ 'Account 01': { kind: 'flatten-fails' } }),
    );
    expect(open.result.haltReason).toBe('EXISTING_POSITION');
    expect(open.result.accounts[0]?.positionState).not.toBe('CONFIRMED_FLAT');
    expect(open.adapter.submitCount('Account 01')).toBe(0);
  });

  it('keeps Send disarmed until live integration is proven separately', () => {
    const unread = evaluateSendGate({});
    expect(unread.liveSend).toBe(false);
    expect(unread.armed).toBe(false);
    expect(unread.sendPermitted).toBe(false);
    expect(unread.missing).toContain('flattenAvailable');
    const proven = evaluateSendGate({
      accountReadable: true,
      accountSwitchVerified: true,
      ticketReadable: true,
      leverageControllable: true,
      positionReadable: true,
      protectionReadable: true,
      flattenAvailable: true,
      confirmedFlatAvailable: true,
      exactlyOnceExecution: true,
      reconciliationSupported: true,
    });
    expect(proven.executionProven).toBe(true);
    expect(proven.liveSend).toBe(false);
    expect(proven.armed).toBe(false);
    expect(proven.sendPermitted).toBe(false);
  });
});
